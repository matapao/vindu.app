// A task of Desktop's: its local projection, and its UI connection, passed to the processor that runs it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AppsProvider, OpenMore, PointItem, Reminder, Shown, ShellState, Template, ViewCheckpoint, ViewSnapshot, Vindu, ViewsSetup } from '@matapao/vindu/server';
import type { Act, Attachment } from './work.js';
import { startDevice, type DeviceTool } from './device.js';
import { TaskRecord } from './task-record.js';
import { exportArchive } from './task-archive.js';

export type Switch = {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  type: 'select' | 'boolean';
  value: string | boolean;
  options?: { value: string; name: string; description?: string | null; group?: string }[];
  via: 'config' | 'mode';
};

export type TaskQuestion = {
  call: string;
  tool: string;
  title: string;
  input?: unknown;
  options: { optionId: string; name: string; kind: 'allow_once' | 'reject_once' }[];
  form?: { message: string; url?: string; fields?: {
    name: string; title: string; description?: string; type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
    required: boolean; choices?: { value: string; label: string }[];
  }[] };
};
export type TaskAnswer = { option: string } | { accept: boolean; content?: Record<string, unknown> };
export type TaskResult = { connector: string; tool: string; input: unknown; result: unknown };
export type TaskMessage = {
  text: string;
  context: string;
  attachments: { path: string; name: string; type: string; size: number }[];
  signal: AbortSignal;
};

export type TaskReply = { text: string; usage?: { totalTokens: number }; costUsd?: number | null };
export type TaskConsumer = {
  send: (message: TaskMessage) => Promise<TaskReply>;
  set?: (id: string, value: string | boolean) => void | Promise<void>;
  close?: () => void | Promise<void>;
};

export type TaskConnection = {
  id: string;
  cwd: string;
  processor: string;
  owner?: string;
  readsOnly: boolean;
  mcpServers: { name: string; transport: 'http'; url: string; headers: Record<string, string> }[];
  text: (delta: string) => void;
  activity: (event: Act) => void;
  settings: (settings: Switch[]) => void;
  observe: (result: TaskResult) => string;
  ask: (question: TaskQuestion, signal: AbortSignal) => Promise<TaskAnswer | null>;
  callTool?: (server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>;
};

export type TaskSetup = {
  id?: string;
  owner?: string;
  readsOnly?: boolean;
  harness: string;
  connect?: (task: TaskConnection) => TaskConsumer | undefined;
  callTool?: TaskConnection['callTool'];
  cwd: string;
  dataDir: string;
  uiProvider: Vindu;
  onShow: (view: Shown) => void;
  onText: (text: string) => void;
  onShell?: (state: ShellState) => void;
  onNote?: (text: string) => void;
  onSwitches?: (switches: Switch[]) => void;
  onActivity?: (event: Act) => void;
  onTold?: (said: string) => void;
  openLink?: (url: string) => Promise<void> | void;
  permission?: (ask: TaskQuestion, signal: AbortSignal) => Promise<TaskAnswer | null>;
  elicit?: (ask: TaskQuestion, signal: AbortSignal) => Promise<TaskAnswer | null>;
  app?: Pick<OpenMore, 'onApp' | 'onAppMessage' | 'onAskGone' | 'onSend'>;
  appsProvider?: AppsProvider;
  sources?: Pick<OpenMore, 'isRead' | 'source' | 'watch'>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  views?: ViewsSetup;
  seed?: string;
  person?: { name?: string };
  restore?: ViewCheckpoint;
  template?: unknown;
  inputs?: Record<string, unknown>;
  capture?: OpenMore['capture'];
  onSuggest?: OpenMore['onSuggest'];
  device?: DeviceTool[];
  onReminder?: (reminder: Reminder) => void;
  onNotice?: OpenMore['onNotice'];
  onJob?: OpenMore['onJob'];
  jobs?: boolean;
  hooks?: boolean;
  from?: { snapshot: ViewSnapshot; record: TaskRecord; task: string };
  router?: TaskRouter;
};

export type TaskRouter = {
  event?: (value: unknown, window?: string, replyToWindow?: OpenMore['onApp']) => boolean;
  record?: TaskRecord;
  observe?: (result: TaskResult) => string;
  ask?: (question: TaskQuestion, signal: AbortSignal) => Promise<TaskAnswer | null>;
};
const UI = 'ui';
const DEVICE = 'device';
const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const stringOf = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

function resultData(result: unknown) {
  const raw = recordOf(result);
  const content = Array.isArray(raw.content) ? raw.content : Array.isArray(result) ? result : [];
  const text = typeof result === 'string' ? result : content.map(recordOf)
    .filter(item => item.type === 'text').map(item => stringOf(item.text) ?? '').join('\n');
  let value = raw.structuredContent;
  if (value === undefined && text) {
    try { value = JSON.parse(text); } catch { /* This result is ordinary text. */ }
  }
  if (value === undefined && !text && !content.length) value = result;
  const rows = Array.isArray(value) && value.length > 0 && value.every(row => row && typeof row === 'object' && !Array.isArray(row)) ? value : undefined;
  const images = content.map(recordOf).flatMap(item => item.type === 'image' && typeof item.data === 'string' &&
    typeof item.mimeType === 'string' && /^image\/(?:png|jpeg|gif|webp)$/.test(item.mimeType)
    ? [{ data: Buffer.from(item.data, 'base64'), mime: item.mimeType }] : []);
  return { text, value: rows ? undefined : value, rows, images, error: raw.isError === true };
}

function schemaOf(form: NonNullable<TaskQuestion['form']>) {
  const fields = form.fields ?? [];
  return { type: 'object' as const,
    properties: Object.fromEntries(fields.map(field => [field.name, {
      type: field.type, title: field.title, ...(field.description ? { description: field.description } : {}),
      ...(field.type === 'array' ? { items: { type: 'string', ...(field.choices ? { enum: field.choices.map(value => value.value) } : {}) } }
        : field.choices ? { oneOf: field.choices.map(value => ({ const: value.value, title: value.label })) } : {}),
    }])),
    required: fields.filter(field => field.required).map(field => field.name),
  };
}

/** Resolve the workspace chosen by the person, optionally copying a seed into a new folder. */
export function placeFor(options: { cwd: string; seed?: string; home?: string }): { cwd: string; notes: string[] } {
  const home = options.home ?? os.homedir();
  const cwd = options.cwd === '~' || options.cwd.startsWith('~/') ? path.join(home, options.cwd.slice(1)) : path.resolve(options.cwd);
  fs.mkdirSync(cwd, { recursive: true });
  const notes: string[] = [];
  if (options.seed && fs.readdirSync(cwd).length === 0) {
    fs.cpSync(options.seed, cwd, { recursive: true, filter: file => file === options.seed || !path.basename(file).startsWith('.') && path.basename(file) !== 'node_modules' });
    notes.push(`The task starts with a copy of ${options.seed}.`);
  }
  return { cwd: fs.realpathSync(cwd), notes };
}

function httpServer(name: string, url: string): TaskConnection['mcpServers'][number] {
  return { name, transport: 'http', url, headers: {} };
}

export async function openTask(setup: TaskSetup) {
  const t = setup;
  const { cwd, notes } = placeFor(t);
  const record = new TaskRecord(t.dataDir);
  const tell = (note: string) => t.onNote?.(note);
  const lifetime = new AbortController();
  let closed = false;
  const observe = (data: TaskResult) => {
    if (closed) throw new Error('The task is closed.');
    const entry = record.addResult({ server: data.connector, tool: data.tool, input: data.input,
      ...resultData(data.result), raw: data.result, fidelity: 'exact', via: 'connector' });
    ui.result(entry.id);
    return entry.id;
  };
  const template = recordOf(t.template);
  let formShown: (() => void) | undefined;
  const firstForm = !t.inputs && Object.keys(recordOf(template.inputs)).length
    ? new Promise<void>(resolve => { formShown = resolve; }) : undefined;
  const open = async (url: string) => { if (/^https?:\/\//i.test(url)) await t.openLink?.(url); };
  const ui: ReturnType<Vindu['open']> = t.uiProvider.open({ results: record, dir: t.dataDir, work: cwd, cwd }, {
    onView(view) {
      t.onShow(view);
      if (view.ask?.op === `start ${template.name}`) formShown?.();
    },
    onState: t.onShell, ...t.app, ...t.sources,
    ...(t.appsProvider ? { apps: { ...t.appsProvider, result: id => {
      const entry = record.get(id);
      return entry?.kind === 'result' ? entry.raw : t.appsProvider?.result?.(id);
    } } } : {}),
    onOpenLink: async url => {
      if (await ui.link({ title: 'An app wants to open a page', message: 'An app in this window asks to open this page.', url }) === 'accept') await open(url);
    },
    ...(t.views ? { views: { ...t.views, ...(t.views.terminal !== false ? { terminal: { env: t.env, ...t.views.terminal } } : {}) } } : {}),
    record: event => record.addResult({ server: UI, tool: event.tool, input: event.input, value: event.result,
      raw: event.result, fidelity: 'exact', via: 'window' }).id,
    capture: t.capture, onSuggest: t.onSuggest, onReminder: t.onReminder, onNotice: t.onNotice,
    onJob: t.connect && t.jobs !== false ? t.onJob : undefined, jobs: t.jobs, hooks: t.hooks,
  });
  const who = { name: t.person?.name?.trim() || 'the person' };
  const event = (value: unknown, window = 'main', replyToWindow?: OpenMore['onApp']) => {
    const source = recordOf(value);
    if (source.type === 'action' && !source.by) return ui.event({ ...source, by: { ...who, window } });
    if (source.type === 'select' && !source.from) return ui.event({ ...source, from: { ...who, window } });
    return ui.event(value, replyToWindow);
  };
  if (t.router) { t.router.event = event; t.router.record = record; t.router.observe = observe; }
  const device = await (t.device?.length ? startDevice({
    tools: t.device,
    log: entry => tell(entry.read ? `the model read ${String(entry.device)} from this device (${String(entry.read)})` : `you ${entry.yes ? 'let' : 'did not let'} the model read ${String(entry.asked)}`),
    ask: async what => await ui.permission({ title: `Let the model read ${what}?`, tool: 'the device', input: {},
      options: [{ name: 'Allow for this task' }, { name: 'Deny' }] }, new AbortController().signal) === 0,
    keep: (tool, value) => record.addResult({ server: DEVICE, tool, input: {}, value, raw: value, fidelity: 'exact', via: 'device' }).id,
  }) : Promise.resolve(undefined)).catch(error => { ui.close(); throw error; });
  const mcpServers = [ui.mcpServer, ...(device ? [httpServer(DEVICE, device.url)] : [])];
  const ask = async (question: TaskQuestion, requested: AbortSignal): Promise<TaskAnswer | null> => {
    const signal = AbortSignal.any([requested, lifetime.signal]);
    if (signal.aborted) return null;
    const form = question.form;
    if (form) {
      if (t.elicit) return t.elicit(question, signal);
      if (form.url) {
        const response = await ui.link({ message: form.message, url: form.url }, signal);
        if (response === 'accept') { await open(form.url); return { accept: true }; }
        return response === 'decline' ? { accept: false } : null;
      }
      const response = await ui.ask({ message: form.message, schema: schemaOf(form) }, signal);
      return response.action === 'accept' ? { accept: true, content: response.content } : response.action === 'decline' ? { accept: false } : null;
    }
    if (t.permission) return t.permission(question, signal);
    const parts = /^mcp__(.+?)__(.+)$/.exec(question.tool);
    const server = parts?.[1] ?? 'processor', tool = parts?.[2] ?? question.tool;
    const chosen = await ui.permission({ title: question.title, tool, input: question.input, options: question.options,
      own: mcpServers.some(item => item.name === server), server, name: tool }, signal);
    return chosen === null || !question.options[chosen] ? null : { option: question.options[chosen].optionId };
  };

  if (t.router) t.router.ask = ask;

  let switches: Switch[] = [];
  let first = true;
  let active: AbortController | undefined;
  let receivedText = false;
  let consumer: TaskConsumer | undefined;
  const attach = () => {
    consumer = t.connect?.({
      id: t.id ?? randomUUID(), processor: t.harness, owner: t.owner, readsOnly: t.readsOnly === true, cwd, mcpServers,
      text(delta) { if (!closed && !active?.signal.aborted) { receivedText = true; t.onText(delta); } },
      activity(event) { if (!closed) { record.frame('progress', event); t.onActivity?.(event); } },
      settings(next) { if (!closed) { switches = next; t.onSwitches?.(next); } },
      observe, ask,
      ...(t.callTool ? { callTool: (server, tool, args, requested) => {
        const signal = AbortSignal.any([lifetime.signal, ...(active ? [active.signal] : []), ...(requested ? [requested] : [])]);
        signal.throwIfAborted();
        return t.callTool!(server, tool, args, signal);
      } } : {}),
    });
    if (t.connect && !consumer) throw new Error('No processor is connected to this task.');
  };
  try {
    if (t.restore) {
      const missing = await ui.restore(t.restore);
      if (missing.length) throw new Error(`Could not reopen the saved views: ${missing.join(', ')}. The task is still on disk.`);
    } else attach();
  } catch (error) {
    closed = true;
    lifetime.abort();
    try { ui.close(); } finally { await device?.close(); }
    throw error;
  }

  const branching = t.from ? (async () => {
    const carried: Record<string, string> = {};
    for (const id of t.from!.snapshot.ids) {
      const entry = t.from!.record.get(id);
      if (entry) carried[id] = record.carry(entry, t.from!.task).id;
    }
    const views = await ui.startFrom(t.from!.snapshot, carried);
    for (const [name, why] of Object.entries(views.refused)) tell(`The view "${name}" could not be carried: ${why}`);
  })() : Promise.resolve();
  void branching.catch(() => undefined);
  const starting = t.template ? ui.useTemplate(t.template, t.inputs) : undefined;
  const initialized = starting?.catch(() => undefined);
  // A template with required inputs is ready when its first form is visible, even while the person is still answering.
  // An invalid template can finish without showing a form.
  if (initialized && firstForm) await Promise.race([firstForm, initialized]);

  async function prompt(text: string, attachments: Attachment[] = []) {
    if (closed) throw new Error('The task is closed.');
    if (!consumer && t.restore) attach();
    if (!consumer) throw new Error('No processor is connected to this task.');
    if (active) throw new Error('This task already has a running turn.');
    const controller = new AbortController();
    active = controller;
    receivedText = false;
    let files: string | undefined;
    try {
      if (first) await branching;
      controller.signal.throwIfAborted();
      const given = attachments.map((attachment, index) => {
        files ??= fs.mkdtempSync(path.join(cwd, '.vindu-attachments-'));
        const destination = path.join(files, `${index + 1}-${path.basename(attachment.name)}`);
        fs.copyFileSync(attachment.file, destination, fs.constants.COPYFILE_EXCL);
        return { path: destination, name: attachment.name, type: attachment.mime, size: fs.statSync(destination).size };
      });
      const context = [ui.delta(1200), ui.context(1200).text, first ? ui.note : ''].filter(Boolean).join('\n\n');
      if (context) t.onTold?.(context);
      const reply = await consumer.send({ text, context, attachments: given, signal: controller.signal });
      if (!receivedText && !controller.signal.aborted && reply.text) t.onText(reply.text);
      first = false;
      const result = { stopReason: controller.signal.aborted ? 'cancelled' as const : 'end_turn' as const,
        text: reply.text, saved: [] as string[], usage: reply.usage ?? { totalTokens: 0 }, costUsd: reply.costUsd ?? null };
      record.frame('turns', { at: new Date().toISOString(), result });
      return result;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return { stopReason: 'cancelled' as const, text: '', saved: [] as string[], usage: { totalTokens: 0 }, costUsd: null };
    } finally {
      active = undefined;
      if (files) fs.rmSync(files, { recursive: true, force: true });
    }
  }

  return {
    record, observe, refusals: ui.refusals, pages: ui.pages, cwd, work: cwd,
    ui: { url: ui.url, layoutMcpServer: ui.layoutMcpServer, provideFiles: ui.provideFiles },
    device: device ? { url: device.url } : undefined,
    views: ui.views,
    notes, get attached() { return !!consumer || !!(t.restore && t.connect); },
    switches: () => switches,
    async set(id: string, value: string | boolean) {
      const previous = switches;
      const setting = switches.find(item => item.id === id);
      const valid = setting?.type === 'boolean' ? typeof value === 'boolean' : setting?.options?.some(option => option.value === value);
      if (!valid || !consumer?.set || closed) throw new Error('Choose an option the processor offers.');
      await consumer.set(id, value);
      if (switches === previous) switches = switches.map(item => item.id === id ? { ...item, value } : item);
      return switches;
    },
    prompt, event,
    unheard: () => ui.unheard(),
    mode: () => ui.mode(),
    started: starting,
    useTemplate: (raw: unknown, inputs?: Record<string, unknown>) => ui.useTemplate(raw, inputs),
    pin: (name: string, about?: string) => ui.pin(name, about),
    arrangement: (): Template | undefined => ui.arrangement(),
    letModelChange: () => ui.letModelChange(),
    selection: () => ui.selection(),
    point: (item: PointItem) => ui.point(item),
    pointInPage: (view: string) => ui.pointInPage(view),
    stopPointing: (view: string) => ui.stopPointing(view),
    archive: (out: string) => exportArchive({ dirs: [{ name: 'task', path: t.dataDir }], out,
      about: { harness: t.harness, folder: cwd, exported: new Date().toISOString() } }),
    receipts: () => ui.receipts(),
    snapshot: () => ui.snapshot(),
    checkpoint: () => ui.checkpoint(),
    branched: branching,
    reminders: () => ui.reminders(),
    showReminders: () => ui.showReminders(),
    connectors: [] as { name: string; title: string; kind: string; guide: boolean; base?: string }[],
    cancel: async () => { active?.abort(); },
    close: async () => {
      if (closed) return;
      closed = true;
      lifetime.abort();
      active?.abort();
      try { ui.close(); } finally {
        try { await consumer?.close?.(); } finally { await device?.close(); }
      }
    },
  };
}
export type OpenTask = Awaited<ReturnType<typeof openTask>>;
