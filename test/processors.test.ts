// The app's own processors, with no model called: which CLIs are found, what Settings says each still needs (from a
// health check that asks a stand-in program its version and sign-in), and a task's turns wired through to the runtime
// that runs its CLI (a stand-in runtime here), with the task's folder and servers, the person's answer to what the CLI
// asks, its session from one turn to the next, its cancel, its failure in its own words, and its usage in the budget.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { AgentProgram, RunHandle, RunProgress, RunResult, Runtime, RunSpec } from '@matapao/celler/harness';
import type { Shown } from '@matapao/vindu/server';
import { startApp, type App } from '../src/app.js';
import { localProcessors } from '../src/processors.js';
import type { ThreadItem } from '../src/task-checkpoint.js';

const folders: string[] = [];
const temporary = (prefix: string) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); folders.push(dir); return dir; };
let app: App | undefined;
afterEach(async () => { await app?.close(); app = undefined; for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A stand-in for a CLI: it says its version, and whether it is signed in, as the real one would. */
function standIn(dir: string, name: string, version: string, signedIn: boolean) {
  const file = path.join(dir, name);
  const status = name === 'claude' ? `echo '{"loggedIn": ${signedIn}}'` : signedIn ? 'echo "Logged in using ChatGPT"' : 'echo "Not logged in"; exit 1';
  fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\n  *) ${status} ;;\nesac\n`, { mode: 0o755 });
  return file;
}

function call(url: string, ch: string, ...args: unknown[]): Promise<unknown> {
  const { port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}socket`, { headers: { origin: `http://127.0.0.1:${port}` } } as unknown as string[]);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'call', id: 1, ch, a: args }));
    ws.onmessage = event => {
      const reply = JSON.parse(String(event.data)) as { t: string; v?: unknown; e?: string };
      if (reply.t !== 'reply') return;
      ws.close();
      if (reply.e !== undefined) reject(new Error(reply.e)); else resolve(reply.v);
    };
    ws.onerror = () => reject(new Error('The test page socket did not open'));
  });
}

test('the CLIs found are the processors, and their checks say what each still needs, with no model called', async () => {
  const dir = temporary('vindu-clis-'), codexHome = path.join(dir, 'codex-home');
  const claude = standIn(dir, 'claude', '9.9.9 (Claude Code)', true), codex = standIn(dir, 'codex', 'codex-cli 9.9.9', false);
  const both = localProcessors({ codexHome, find: program => (program === 'claude' ? claude : codex) });
  assert.deepEqual(both.processors, [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }]);
  const [ready, signedOut] = await both.checkProcessors();
  assert.deepEqual(ready, { id: 'claude', name: 'Claude Code', found: true, ready: true, detail: 'Claude Code 9.9.9' });
  assert.equal(signedOut.ready, false);
  assert.match(signedOut.detail, /^Codex 9\.9\.9 · not signed in for Vindu \(CODEX_HOME=".*codex-home" codex login, in a terminal, signs it in\)$/);
  assert.equal(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "file"\n', 'Codex keeps its sign-in in the app\'s own Codex home');

  const none = localProcessors({ codexHome, find: () => null });
  assert.deepEqual(none.processors, []);
  assert.equal(none.connect({ processor: 'claude' } as Parameters<typeof none.connect>[0]), undefined);
  assert.deepEqual((await none.checkProcessors()).map(check => [check.id, check.found, check.detail]), [
    ['claude', false, "Claude Code wasn't found on this computer. Install it, then restart Vindu."],
    ['codex', false, "Codex wasn't found on this computer. Install it, then restart Vindu."],
  ]);
});

test('Settings lists the CLI found, says what it needs to sign in, and says which one is not on this computer', async () => {
  const dir = temporary('vindu-settings-clis-');
  const claude = standIn(dir, 'claude', '9.9.9 (Claude Code)', false);
  app = await startApp({ userData: path.join(dir, 'data'), home: dir, port: 17680,
    ...localProcessors({ codexHome: path.join(dir, 'codex'), find: program => (program === 'claude' ? claude : null) }) });
  const listed = await call(app.desktop.url, 'settings:processors') as { processors: { id: string }[]; granted: string[] };
  assert.deepEqual([listed.processors.map(processor => processor.id), listed.granted], [['claude'], ['claude']]);
  const checks = await call(app.desktop.url, 'settings:processor-checks') as { id: string; found: boolean; ready: boolean; detail: string }[];
  assert.deepEqual(checks.map(check => [check.id, check.found, check.ready]), [['claude', true, false], ['codex', false, false]]);
  assert.equal(checks[0].detail, 'Claude Code 9.9.9 · not logged in to Claude (claude auth login, in a terminal, signs it in)');
  assert.equal(checks[1].detail, "Codex wasn't found on this computer. Install it, then restart Vindu.");
  await assert.rejects(call(app.desktop.url, 'task:create', { id: 'on-codex', harness: 'codex' }), /Choose an available processor/);
});

/** A stand-in for a CLI's runtime: each run as the turn gives it, what it reports, and how it ends. */
class StandInRuntime implements Runtime {
  readonly kind = 'stand-in';
  readonly runs: RunSpec[] = [];
  constructor(private readonly turns: ((spec: RunSpec, progress: (event: RunProgress) => void, stopped: AbortSignal) => Promise<RunResult>)[]) {}
  async health() { return { ok: true, checkedAt: Date.now(), detail: 'a stand-in' }; }
  run(spec: RunSpec, progress: (event: RunProgress) => void): RunHandle {
    this.runs.push(spec);
    const stop = new AbortController();
    const done = this.turns[this.runs.length - 1](spec, progress, stop.signal);
    return { done, cleaned: done.then(() => undefined), cancel: () => stop.abort() };
  }
}
const usage = { input: 5, output: 3, cacheRead: 2, cacheWrite5m: 0, cacheWrite1h: 0 };
const ended = (over: Partial<RunResult>): RunResult => ({ ok: true, text: '', usage, costUsd: 0.5, permissionDenials: [], ...over });

test('a task\'s turns run its CLI in its folder with its servers, the person answers what it asks, and its session goes on', async () => {
  const dir = temporary('vindu-turns-'), work = path.join(dir, 'work');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify({ tasksFolder: work }));
  const answers: unknown[] = [];
  const runtime = new StandInRuntime([
    async (spec, progress) => {
      progress({ type: 'session', sessionId: 'session-1' });
      progress({ type: 'settings', settings: [{ id: 'model', name: 'Model', value: 'its own model' }, { id: 'effort', name: 'Effort', value: '' }] });
      progress({ type: 'tool', tool: 'Bash', summary: 'Bash npm test', call: 'c1' });
      answers.push(await spec.ask!({ call: 'c1', tool: 'Bash', title: 'Run npm test?', input: { command: 'npm test' }, options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] }, new AbortController().signal));
      progress({ type: 'text', text: 'Ran' });
      progress({ type: 'text', text: 'Ran the tests.' });
      return ended({ text: 'Ran the tests.' });
    },
    async (_spec, _progress, stopped) => { await new Promise(resolve => stopped.addEventListener('abort', resolve)); return ended({ ok: false, cancelled: true, error: 'Cancelled' }); },
    async () => ended({ ok: false, error: 'Claude Code is not signed in: run claude auth login in a terminal, then send the message again.', runtimeDown: true }),
  ]);
  const found = (program: AgentProgram) => (program === 'claude' ? '/stand-in/claude' : null);
  app = await startApp({ userData: path.join(dir, 'data'), home: dir, port: 17690, ...localProcessors({ codexHome: path.join(dir, 'codex'), find: found, runtime: () => runtime }) });
  const desktop = app.desktop.url;
  const opened = await call(desktop, 'task:create', { id: 'invoices', harness: 'claude', title: 'Invoices' }) as { cwd: string };
  const views = async () => ((await call(desktop, 'activity:restore')) as { tasks: { id: string; views: Shown[]; thread: ThreadItem[] }[] }).tasks[0];
  const turn = call(desktop, 'task:prompt', 'invoices', 'Run the tests.') as Promise<{ stopReason: string; text: string }>;
  const asked = await vi.waitFor(async () => { const v = (await views()).views.find(view => view.ask?.kind === 'permission'); assert.ok(v); return v; });
  assert.equal(app.act('invoices')?.asks[0]?.title, 'Run npm test?');
  app.tasks.get('invoices')!.event({ type: 'action', view: asked.name, name: 'answer', context: { ticket: asked.ask!.ticket, choice: asked.ask!.choices![0], n: 0 } });
  const done = await turn;
  assert.deepEqual([done.stopReason, done.text], ['end_turn', 'Ran the tests.']);
  assert.deepEqual(answers, [{ option: 'allow' }]);
  const [first] = runtime.runs;
  assert.equal(first.cwd, opened.cwd);
  assert.deepEqual([first.purpose, first.model, first.resume, first.mcpServers.map(server => server.name)], ['work', '', false, ['ui']]);
  assert.ok(first.prompt.endsWith('Run the tests.'), 'the person\'s words come last, after what the window says');
  assert.ok(!first.mcpServers[0].url.match(/[a-f0-9]{32}/) && /^Bearer [a-f0-9]{32}$/.test(first.mcpServers[0].headers.Authorization ?? ''),
    'the UI server\'s token is in a header, never in its address');
  const thread = (await views()).thread;
  assert.equal(thread.filter(item => item.kind === 'text').map(item => (item as { text: string }).text).join(''), 'Ran the tests.');
  assert.ok(thread.some(item => item.kind === 'act' && item.event.type === 'call' && item.event.id === '1-c1' && item.event.status === 'completed'));
  assert.deepEqual(app.tasks.get('invoices')!.switches().map(s => [s.id, s.value]), [['model', 'its own model']]);
  assert.deepEqual([app.celler.spent().tokens, app.celler.spent().cost], [10, 0.5]);

  const cancelled = call(desktop, 'task:prompt', 'invoices', 'Again.') as Promise<{ stopReason: string }>;
  await vi.waitFor(() => assert.equal(runtime.runs.length, 2));
  assert.deepEqual([runtime.runs[1].resume, runtime.runs[1].sessionId], [true, 'session-1']);
  await call(desktop, 'task:cancel', 'invoices');
  assert.equal((await cancelled).stopReason, 'cancelled');
  await assert.rejects(call(desktop, 'task:prompt', 'invoices', 'Once more.'), /Claude Code is not signed in: run claude auth login/);
});
