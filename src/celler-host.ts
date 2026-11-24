import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp, type Adapter, type NodeConfig } from '@matapao/celler';
import type { TaskConnection, TaskResult } from './task.js';

type Limits = { tokens: number; cost: number; minutes: number };
type Tool = Extract<NodeConfig, { kind: 'tool' }>;
type ToolCall = {
  owner: string;
  processor: string;
  cwd: string;
  node: Tool;
  adapters: Map<string, Adapter>;
  input: Record<string, unknown>;
  mayUse?: (connector: string) => boolean;
  mayRun?: () => boolean;
  ask?: TaskConnection['ask'];
  observed?: (result: TaskResult) => void;
  signal?: AbortSignal;
};
const ZERO: Limits = { tokens: 0, cost: 0, minutes: 0 };
const limit = (n: number) => Number.isFinite(n) && n > 0 ? n : 0;
const today = () => { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime(); };

export function openCellerHost(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'runs.sqlite'));
  // These tables are the host's policy inputs and spending counters. Celler owns its graph, active grants, run audit and approvals.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vindu_apps (id TEXT PRIMARY KEY, grants TEXT NOT NULL, budget TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS vindu_usage (id TEXT PRIMARY KEY, app TEXT NOT NULL, started INTEGER NOT NULL,
      ended INTEGER, tokens REAL NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS vindu_usage_day ON vindu_usage(app,started);
  `);
  const registered = db.prepare('SELECT grants,budget FROM vindu_apps WHERE id = ?');
  const make = db.prepare('INSERT OR IGNORE INTO vindu_apps VALUES (?,?,?)');
  const setGrants = db.prepare('UPDATE vindu_apps SET grants = ? WHERE id = ?');
  const setBudget = db.prepare('UPDATE vindu_apps SET budget = ? WHERE id = ?');
  const startUsage = db.prepare('INSERT INTO vindu_usage (id,app,started) VALUES (?,?,?)');
  const endUsage = db.prepare('UPDATE vindu_usage SET ended = ?, tokens = ?, cost = ? WHERE id = ?');
  const usage = db.prepare(`SELECT coalesce(sum(tokens),0) tokens,coalesce(sum(cost),0) cost,
    coalesce(sum(coalesce(ended, ?) - started),0)/60000.0 minutes
    FROM vindu_usage WHERE app = ? AND started >= ?`);
  // A process which lost its host is no longer consuming time.
  db.prepare('UPDATE vindu_usage SET ended = ? WHERE ended IS NULL').run(Date.now());

  const grants = (owner: string): string[] => JSON.parse(String(registered.get(owner)?.grants ?? '[]')) as string[];
  const budget = (owner: string): Limits => JSON.parse(String(registered.get(owner)?.budget ?? JSON.stringify(ZERO))) as Limits;
  const spent = (owner: string): Limits => usage.get(Date.now(), owner, today()) as Limits;
  const over = (owner: string) => {
    const limits = budget(owner), used = spent(owner);
    const key = (Object.keys(limits) as (keyof Limits)[]).find(key => limits[key] > 0 && used[key] >= limits[key]);
    return key ? `Daily ${key} budget reached` : undefined;
  };
  // Each live connector binding belongs to its task. Two tasks can select the same connector with different grants.
  const names = new WeakMap<Adapter, string>();
  const bindings = new Map<string, number>();
  // Celler checks admission before handing us its run ID. Bind exactly that caller's live policy to the run.
  const admission = new AsyncLocalStorage<{ call: ToolCall; run?: string }>();
  const active = new Map<string, ToolCall>();
  const registry = new Map<string, Adapter>();
  const shutdown = new AbortController();
  const running = new Set<Promise<CallToolResult>>();
  const openMeters = new Set<(tokens?: number, cost?: number | null) => void>();
  const app = createApp({ database: db, adapters: registry, platform: {
    allowed(run, id) {
      const entering = admission.getStore();
      if (entering && !entering.run && !active.has(run.id)) {
        entering.run = run.id;
        active.set(run.id, entering.call);
      }
      const call = active.get(run.id);
      if (!call || call.owner !== run.owner || call.mayRun?.() === false || over(run.owner) || (call.processor && !grants(run.owner).includes(call.processor))) return false;
      if (id === run.entry) return true;
      const connector = call.node.id.split('.')[0];
      return id === call.node.id && (call.mayUse?.(connector) ?? grants(run.owner).includes(`connector:${connector}`));
    },
    // The only client here is the in-process client of the one requested connector tool.
    async launch(run, connect, signal) {
      const call = active.get(run.id);
      if (!call || call.owner !== run.owner) throw new Error('The connector call is closed.');
      const client = new Client({ name: 'vindu', version: '0.1.0' });
      const [serverEnd, clientEnd] = InMemoryTransport.createLinkedPair();
      let review: Promise<void> | undefined;
      const reviewLifetime = new AbortController();
      const reviewSignal = AbortSignal.any([signal, reviewLifetime.signal]);
      const timer = setInterval(() => {
        if (review || reviewSignal.aborted) return;
        review = reviewWrite(call, run.id, reviewSignal).catch(() => {}).finally(() => { review = undefined; });
      }, 100);
      timer.unref();
      try {
        await connect(serverEnd, true);
        await client.connect(clientEnd);
        return CallToolResultSchema.parse(await client.callTool({ name: call.node.id, arguments: call.input }, undefined, { signal, timeout: 120_000 }));
      } finally {
        clearInterval(timer);
        reviewLifetime.abort();
        await client.close();
        await serverEnd.close();
        await review?.catch(() => {});
      }
    },
  } });

  async function reviewWrite(call: ToolCall, run: string, signal: AbortSignal) {
    const item = app.human.inbox(call.owner).find(value => value.run === run && value.state === 'pending');
    if (!item || signal.aborted) return;
    const packet = app.human.review(call.owner, item.id).write;
    const tool = `mcp__${item.tool.replace('.', '__')}`;
    try {
      const answer = await call.ask?.({ call: item.id, tool, title: `Approve ${packet.operation} to ${packet.destination}?`, input: packet,
        options: [{ optionId: 'allow', name: 'Send the reviewed request', kind: 'allow_once' },
          { optionId: 'decline', name: 'Decline', kind: 'reject_once' }] }, signal);
      if (signal.aborted) return;
      if (answer && 'option' in answer && answer.option === 'allow') await app.human.approve(call.owner, item.id, signal);
      else app.human.decline(call.owner, item.id);
    } catch {
      if (app.human.inbox(call.owner).some(current => current.id === item.id && current.state === 'pending')) app.human.decline(call.owner, item.id);
    }
  }

  async function callTool(call: ToolCall) {
    shutdown.signal.throwIfAborted();
    const adapter = 'adapter' in call.node.target ? call.adapters.get(call.node.target.adapter) : undefined;
    if (!adapter) throw new Error('The connector is unavailable.');
    const entry = names.get(adapter) ?? `tool-${randomUUID()}`;
    names.set(adapter, entry);
    bindings.set(entry, (bindings.get(entry) ?? 0) + 1);
    const adapterId = entry + '.adapter';
    registry.set(adapterId, adapter);
    const request: { call: ToolCall; run?: string } = { call };
    let result: Promise<CallToolResult> | undefined;
    try {
      const revision = app.publish([{ kind: 'cell', id: entry, title: 'Connector', profile: 'connector', exports: [call.node.id] },
        { ...call.node, target: { adapter: adapterId } }]);
      const signal = call.signal ? AbortSignal.any([shutdown.signal, call.signal]) : shutdown.signal;
      result = admission.run(request, () => app.start({ owner: call.owner, workspace: call.cwd, entry, revision, input: null }, signal));
      running.add(result);
      const output = await result;
      const dot = call.node.id.indexOf('.');
      try {
        call.observed?.({ connector: call.node.id.slice(0, dot), tool: call.node.id.slice(dot + 1), input: call.input, result: output });
      } catch {
        // A completed write must still return its receipt if the task window has closed or its projection failed.
        console.warn('Vindu could not display a connector result. Celler still records the call.');
      }
      return output;
    } finally {
      if (request.run) active.delete(request.run);
      if (result) running.delete(result);
      const remaining = (bindings.get(entry) ?? 1) - 1;
      if (remaining) bindings.set(entry, remaining);
      else { bindings.delete(entry); registry.delete(adapterId); }
    }
  }

  function meter(owner: string) {
    shutdown.signal.throwIfAborted();
    const id = randomUUID();
    startUsage.run(id, owner, Date.now());
    const finish = (tokens = 0, cost: number | null = null) => {
      if (openMeters.delete(finish)) endUsage.run(Date.now(), limit(tokens), limit(cost ?? 0), id);
    };
    openMeters.add(finish);
    return finish;
  }

  return {
    register(owner: string, defaults: string[] = []) { make.run(owner, JSON.stringify(defaults), JSON.stringify(ZERO)); },
    grants, grant(owner: string, id: string, enabled: boolean) {
      const current = new Set(grants(owner));
      if (enabled) current.add(id); else current.delete(id);
      setGrants.run(JSON.stringify([...current]), owner);
      void app.notifyToolsChanged();
    }, budget, spent, over,
    setBudget(owner: string, limits: Limits) { setBudget.run(JSON.stringify({ tokens: limit(limits.tokens), cost: limit(limits.cost), minutes: limit(limits.minutes) }), owner); },
    meter, callTool, history: app.history,
    async close() {
      shutdown.abort();
      await Promise.allSettled(running);
      for (const finish of openMeters) finish();
      db.close();
    },
  };
}
