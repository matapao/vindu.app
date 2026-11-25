import fs from 'node:fs';
import path from 'node:path';
import { bindTaskTools } from './desktop-task-tools.js';
import { openAddress } from './os.js';
import { openTask, type OpenTask, type TaskRouter, type TaskSetup } from './task.js';
import type { DesktopTaskCheckpoint, Opening, ThreadItem } from './task-checkpoint.js';
import { APP } from './desktop-settings.js';
import type { DesktopHost } from './desktop-host.js';
import type { TaskActivity } from './desktop-task-activity.js';
import type { TaskCaptures } from './desktop-task-captures.js';
import type { PageHost } from './pages.js';

type TaskOpening = Omit<Opening, 'harness' | 'inference'> & { harness?: unknown; inference?: unknown };
type StartOptions = {
  template?: unknown;
  from?: { snapshot: ReturnType<OpenTask['snapshot']>; record: OpenTask['record']; task: string };
  job?: Job;
  id?: string;
  saved?: DesktopTaskCheckpoint;
};
type Job = { label: string; prompt: string; connectors?: string[]; writes: boolean };
type Opened = { id: string; cwd: string; where: string; notes: string[]; switches: ReturnType<OpenTask['switches']>; mode: ReturnType<OpenTask['mode']> };

export function desktopTasks(host: DesktopHost, state: TaskActivity, media: TaskCaptures, pages: PageHost) {
  const { userData, options: o, tilde, readSettings, harnessOf, ensureProcessor,
    celler, send, desktop, uiProvider } = host;
  const { availableConnectors } = host.connectors;
  const { tasks, routers, opened, acts, threads, threadAsks, changed, named, latest, startedWith, save, remember, tellActivity, need } = state;
  const { deviceTools } = media;
  let lastId = 0;
  const newId = () => {
    lastId = Math.max(Date.now(), lastId + 1);
    while (fs.lstatSync(path.join(userData, 'tasks', String(lastId)), { throwIfNoEntry: false })) lastId++;
    return String(lastId);
  };
  function discardOpening(id: string) {
    routers.delete(id);
    acts.delete(id);
    threadAsks.delete(id);
    threads.delete(id);
    latest.delete(id);
    tellActivity();
  }

  const start = async (ask: TaskOpening, cwd: string, options: StartOptions = {}): Promise<Opened> => {
    const { template, from, job, id: given, saved } = options;
    if (state.closing) throw new Error('Vindu is closing');
    const id = given ?? newId();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid task identifier');
    const detached = !ask.harness;
    const harness = detached ? '' : harnessOf(ask.harness);
    if (!detached) {
      ensureProcessor(harness);
      if (!o.connect) throw new Error('No processor is connected to this task.');
    }
    if (ask.inference) throw new Error('The processor configures its model endpoint.');
    const q = { ...ask, harness } as Opening;
    const now = readSettings();
    const dataDir = path.join(userData, 'tasks', id);
    const isJob = !!job || !!saved?.activity.job;
    const readsOnly = job ? !job.writes : saved?.readsOnly ?? false;
    if (tasks.has(id) || routers.has(id) || (!saved && fs.lstatSync(dataDir, { throwIfNoEntry: false }))) throw new Error(`there is already a task ${id}`);
    const found = availableConnectors();
    const chosen = found.connectors.filter(c => (q.connectors ?? q.servers ?? []).includes(c.name) && (!job?.connectors || job.connectors.includes(c.name)));
    const lifetime = new AbortController();
    const router: TaskRouter = {};
    routers.set(id, router);
    const tools = await bindTaskTools(host, {
      cwd, harness, readsOnly, chosen, router, signal: lifetime.signal,
    }).catch(error => { routers.delete(id); throw error; });
    threads.set(id, saved?.thread ?? []);
    if (saved) {
      acts.set(id, { ...saved.activity, asks: [], running: undefined, due: { count: 0 },
        ...(saved.activity.running ? { ended: { at: Date.now(), stop: 'interrupted' } } : {}) });
    } else {
      const base = path.basename(cwd);
      const title = from ? (acts.get(from.task)?.title ?? base) + (job ? `: ${job.label}` : ', from its view') : base;
      acts.set(id, { id, title, folder: cwd, harness, opened: Date.now(), asks: [], due: { count: 0 },
        problems: [], notices: [], unseen: [], seenAt: job ? 0 : Date.now(), pinned: false, muted: false,
        ...(job ? { job: job.label } : {}) });
    }
    const t = await openTask({
      id, owner: APP.id, router, harness, cwd, dataDir, uiProvider, restore: saved?.view, connect: detached ? undefined : o.connect,
      ...tools.bindings,
      ...(o.home ? { home: o.home } : {}),
      ...(template ? { template } : {}), ...(from ? { from } : {}), person: now.person, device: deviceTools(now.device),
      ...taskUpdates(id, !!saved, host, state, media),
      ...(now.jobs?.on && !detached && !isJob ? { onJob: async (j: { view: string; label: string; prompt: string; connectors?: string[]; writes: boolean; snapshot: ReturnType<OpenTask['snapshot']> }): Promise<{ id?: string; refused?: string }> => {
        const t0 = tasks.get(id); const was = opened.get(id); if (!t0 || !was) return { refused: 'the task is closing' };
        if (!t0.attached) return { refused: 'No processor is connected to this task.' };
        const r = await start({ ...was.q, template: undefined }, was.cwd, {
          from: { snapshot: j.snapshot, record: t0.record, task: id }, job: j,
        });
        return { id: r.id };
      } } : {}),
      ...(isJob ? { jobs: false, hooks: false, readsOnly } : {}),
      views: {
        terminal: { run: now.terminal?.run, shell: now.terminal?.shell, login: now.terminal?.login, onExit: (term, code) => desktop.send('pty-exit', id, term, code) },
        // the person's pages keep their sign-ins; the model's pages start empty each task and never see the person's
        browser: {
          open: ({ name, owner }) => pages.open(id, name, owner),
          close: name => { void pages.close(id, name); },
        },
      },
    }).catch(async error => {
      await tools.close();
      discardOpening(id);
      throw error;
    });
    if (state.closing) {
      lifetime.abort();
      try { await t.close(); } finally { await tools.close(); }
      discardOpening(id);
      throw new Error('Vindu is closing');
    }
    t.connectors = chosen.map(connector => ({
      name: connector.name, title: connector.title, kind: connector.kind, guide: !!connector.skill,
      ...(connector.kind === 'http' ? { base: connector.http.base } : {}),
    }));
    const close = t.close.bind(t);
    t.close = async () => { lifetime.abort(); try { await close(); } finally { await tools.close(); } };
    if (from || saved?.named) named.add(id);
    tasks.set(id, t); opened.set(id, { q: { ...q, connectors: chosen.map(c => c.name) }, cwd: t.cwd, readsOnly });
    // a task the window started is in front once the window shows it (task:shown), in the order the person started them, not
    // as each finishes opening; a job runs in the background: the person's task stays in front
    if (!job && given === undefined) state.front = id;
    acts.get(id)!.folder = t.cwd;
    changed(id);
    if (!saved) {
      try { save(id); }
      catch (error) {
        opened.delete(id); tasks.delete(id); routers.delete(id); acts.delete(id); threads.delete(id); latest.delete(id);
        await t.close();
        throw error;
      }
    }
    if (q.template) startedWith.set(id, q.template);
    if (from) await t.branched; // its views are there before the window turns to it
    if (job) { // its switches and notes for when the person goes to it; then its prompt, in the background
      send('switches', id, t.switches()); for (const n of [...t.notes, ...tools.notes]) send('note', id, n);
      send('note', id, `a job of task ${from!.task}: ${job.label}${job.writes ? '' : ' (it only reads)'}`);
      void runPrompt(id, job.prompt).catch(() => undefined);
    }
    const notes = [...t.notes, ...tools.notes];
    if (from) notes.push(`a new task from the view of task ${from.task}: a fresh session, with what that view points at carried exactly`);
    for (const [name, why] of Object.entries(found.failed)) notes.push(`the connector in ${name} could not be read: ${why}`);
    return { id, cwd: t.cwd, where: tilde(t.cwd), notes, switches: t.switches(), mode: t.mode() };
  };
  // Activity shows the progress of each Celler turn.
  const runPrompt = async (id: string, text: string, servers?: string[], attachments?: { name: string; mime: string; file: string }[], origin?: string) => {
    const t = need(id); const a = acts.get(id);
    const initial = opened.get(id);
    if (!initial) throw new Error('The task is no longer open');
    const item: ThreadItem = { kind: 'user', text, files: attachments?.map(({ name }) => ({ name })) ?? [] };
    if (typeof text !== 'string') throw new Error('Give the task a message.');
    if (!t.attached) throw new Error('No processor is connected to this task.');
    ensureProcessor(initial.q.harness);
    if (a?.running) throw new Error('This task is already running');
    remember(id, item); send('user', id, item, origin);
    const words = text.replace(/\s+/g, ' ').trim();
    if (a) { if (!named.has(id) && words) { named.add(id); a.title = words.length > 48 ? `${words.slice(0, 47)}…` : words; } a.running = { since: Date.now(), what: words.length > 60 ? `${words.slice(0, 59)}…` : words }; changed(id); }
    const finish = celler.meter();
    const monitor = setInterval(() => {
      try { ensureProcessor(initial.q.harness); } catch { void t.cancel(); }
    }, 100);
    monitor.unref();
    try {
      if (servers?.length) throw new Error('Select a configured connector for tools in Celler');
      const done = await t.prompt(text, attachments);
      finish(done.usage.totalTokens, done.costUsd);
      if (a) a.ended = { at: Date.now(), stop: done.stopReason };
      return { stopReason: done.stopReason, text: done.text, saved: done.saved, refusals: t.refusals };
    } catch (e) {
      remember(id, { kind: 'error', text: String((e as Error).message ?? e) });
      if (a) { a.ended = { at: Date.now(), stop: 'failed' }; a.problems.push({ at: Date.now(), what: `the turn failed: ${String((e as Error).message ?? e)}` }); }
      throw e;
    } finally { clearInterval(monitor); finish(); if (a) { a.running = undefined; changed(id); } }
  };
  return { start, runPrompt };
}

type TaskUpdates = Pick<TaskSetup, 'onShow' | 'onShell' | 'onSuggest' | 'capture' | 'onReminder' | 'onNotice' |
  'onText' | 'onNote' | 'onTold' | 'onSwitches' | 'onActivity' | 'openLink' | 'app'>;

/** Publish task events to Desktop's page, the saved thread and the Activity entry. */
function taskUpdates(id: string, restoring: boolean, host: DesktopHost, state: TaskActivity, media: TaskCaptures): TaskUpdates {
  const { send, home } = host;
  const { remember, seen, threadAsk, acts, changed } = state;
  function append(kind: 'text' | 'note' | 'told', text: string) {
    remember(id, { kind, text });
    send(kind, id, text);
  }
  return {
    onShow(view) {
      send('view', id, view);
      seen(id).views.set(view.name, view);
      if (view.ask) {
        threadAsk(id, view.name, view.ask.title);
        return;
      }
      const entry = acts.get(id);
      if (!entry || (restoring && !state.tasks.has(id)) || id === state.front) return;
      if (!entry.unseen.includes(view.name)) entry.unseen.push(view.name);
      entry.changedAt = Date.now();
      changed(id);
    },
    onShell(shell) {
      send('shell', id, shell);
      const latest = seen(id);
      latest.state = shell;
      // Keep outstanding questions for a page of Desktop's that opens after a question was.
      for (const [name, view] of latest.views) {
        if (!shell.views.some(v => v.name === name) && !(view as { ask?: unknown } | undefined)?.ask) {
          latest.views.delete(name);
        }
      }
      state.fromShell(id, shell);
    },
    onSuggest: text => send('suggest', id, text),
    capture: request => media.capture(id, request),
    onReminder: reminder => state.notify(id, reminder),
    onNotice(notice) {
      const text = `${notice.title}: ${notice.text}`;
      const entry = acts.get(id);
      if (entry) {
        (entry.notices ??= []).push({ at: Date.now(), what: text });
        changed(id);
      }
      send('note', id, text);
    },
    onText: text => append('text', text),
    onNote: text => append('note', text.replaceAll(`${home}${path.sep}`, `~${path.sep}`)),
    onTold: text => append('told', text),
    onSwitches: switches => send('switches', id, switches),
    onActivity(event) {
      remember(id, { kind: 'act', event });
      send('act', id, event);
    },
    openLink: openAddress,
    app: {
      onAppMessage: text => send('suggest', id, text),
      onAskGone(view, action) {
        send('askGone', id, view, action);
        threadAsk(id, view);
        state.latest.get(id)?.views.delete(view);
      },
      onSend: view => send('sent', id, view),
    },
  };
}
