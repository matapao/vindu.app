// A saved custom endpoint cannot be selected or used by the Celler-backed task host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { OpenTask } from '../src/task.js';
import { startApp } from '../src/app.js';

function call(url: string, ch: string, ...args: unknown[]): Promise<unknown> {
  const { port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}socket`, { headers: { origin: `http://127.0.0.1:${port}` } } as unknown as string[]);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'call', id: 1, ch, a: args }));
    ws.onmessage = event => {
      const reply = JSON.parse(String(event.data)) as { t: string; v?: unknown; e?: string };
      if (reply.t !== 'reply') return;
      ws.close();
      if (reply.e !== undefined) reject(new Error(reply.e));
      else resolve(reply.v);
    };
    ws.onerror = () => reject(new Error('Test page socket did not open'));
  });
}

test('a saved custom endpoint does not appear or start a harness', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-legacy-inference-'));
  const keyFile = path.join(directory, 'model.key');
  fs.writeFileSync(keyFile, 'synthetic-key', { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
    tasksFolder: path.join(directory, 'work'),
    inference: [{ name: 'archive-model', harness: 'claude', base: 'http://127.0.0.1:1', model: 'archive-model', keyFile }],
  }));
  let connectRequests = 0;
  const app = await startApp({ userData: directory, home: directory, port: 17760, processors: [{ id: 'reports', name: 'Reports' }], connect() { connectRequests++; throw new Error('No consumer should be attached'); } });
  try {
    assert.deepEqual(await call(app.desktop.url, 'settings:inference'), []);
    const { processors } = await call(app.shell.url, 'shell:processors') as { processors: { id: string }[] };
    assert.deepEqual(processors.map(processor => processor.id).sort(), ['reports']);
    await assert.rejects(call(app.desktop.url, 'task:create', { id: 'old-model', harness: 'reports', inference: 'archive-model' }), /consumer configures its model endpoint/);
    assert.ok(!app.tasks.has('old-model'));
    assert.equal(connectRequests, 0);
  } finally {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function showJobHook(task: OpenTask, total: number) {
  const client = new Client({ name: 'job-hook-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(task.ui.url)));
    const result = await client.callTool({ name: 'show_view', arguments: {
      name: 'watch', title: 'Watch', panels: [{ id: 'total', card: 'kpi', data: total }],
      hooks: [{ label: 'Check total', when: { crosses: { panel: 'total', above: 10 } }, do: { job: { prompt: 'Check this total.' } } }],
    } });
    const block = result.content[0];
    assert.ok(!result.isError && block.type === 'text');
    return (JSON.parse(block.text) as { hooks: { state: string }[] }).hooks[0].state;
  } finally { await client.close(); }
}

test('the default desktop advertises no processors and can host a detached task', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-view-only-'));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ jobs: { on: true } }));
  const app = await startApp({ userData: directory, home: directory, port: 17760 });
  try {
    const { processors } = await call(app.shell.url, 'shell:processors') as { processors: unknown[] };
    assert.deepEqual(processors, []);
    await call(app.desktop.url, 'task:create', { id: 'read-only' });
    const task = app.tasks.get('read-only')!;
    assert.equal(task.attached, false);
    assert.equal(await showJobHook(task, 0), 'off: jobs are off in this app');
    assert.equal(task.event({ type: 'action', name: 'hook', view: 'watch', context: { n: 0, on: true } }), false);
    await assert.rejects(call(app.desktop.url, 'task:prompt', 'read-only', 'Hello'), /No consumer is attached/);
    await call(app.desktop.url, 'task:close', 'read-only');
  } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a consumer can decline a requested desktop task or a job without leaving it in Activity', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-job-refusal-'));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ jobs: { on: true } }));
  const app = await startApp({ userData: directory, home: directory, port: 17760, processors: [{ id: 'reports', name: 'Reports' }],
    connect: task => task.id === 'parent' ? { send: async () => ({ text: '' }) } : undefined });
  try {
    await assert.rejects(call(app.desktop.url, 'task:create', { id: 'declined', harness: 'reports' }), /No consumer is attached/);
    await call(app.desktop.url, 'task:create', { id: 'parent', harness: 'reports' });
    const parent = app.tasks.get('parent')!;
    assert.equal(await showJobHook(parent, 0), 'off until the person turns it on, in the window');
    assert.ok(parent.event({ type: 'action', name: 'hook', view: 'watch', context: { n: 0, on: true } }));
    await showJobHook(parent, 20);
    const history = path.join(directory, 'tasks', 'parent', 'ui-calls.jsonl');
    await vi.waitFor(() => assert.match(fs.readFileSync(history, 'utf8'), /did not start its job: No consumer is attached/));
    assert.deepEqual([...app.tasks.keys()], ['parent']);
    assert.deepEqual(app.activity().entries.map(entry => entry.id), ['parent']);
  } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('restart retains task identity and its record, rechecks grants and retires pending approvals', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-restore-task-'));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ tasksFolder: path.join(directory, 'work'), jobs: { on: true } }));
  let attachments = 0, messages = 0;
  const connect: NonNullable<Parameters<typeof startApp>[0]>['connect'] = task => {
    attachments++;
    return { send: async message => {
      messages++;
      await task.ask({ call: 'request', tool: 'write', title: 'Allow this request?', options: [
        { optionId: 'decline', kind: 'reject_once', name: 'Decline' }] }, message.signal);
      return { text: '' };
    } };
  };
  const start = () => startApp({ home: directory, userData: directory, port: 17760, processors: [{ id: 'reports', name: 'Reports' }], connect });
  let app = await start();
  try {
    await call(app.desktop.url, 'task:create', { id: 'original', harness: 'reports' });
    const task = app.tasks.get('original')!;
    const stored = task.observe({ connector: 'ledger', tool: 'get', input: {}, result: { content: [{ type: 'text', text: 'Original' }] } });
    await showJobHook(task, 5);
    assert.ok(task.event({ type: 'attach', view: 'watch', on: true }));
    assert.ok(task.event({ type: 'collapse', view: 'watch' }));
    await call(app.desktop.url, 'activity:pin', 'original', true);
    const endpoint = task.ui.url;
    const turn = call(app.desktop.url, 'task:prompt', 'original', 'Review this record.').catch(() => {});
    await vi.waitFor(() => assert.equal(app.act('original')?.asks.length, 1));
    await app.close(); // a shutdown takes a checkpoint before cancelling the pending task
    await turn;
    app = await start();
    assert.equal(attachments, 1);
    assert.equal(messages, 1);
    assert.deepEqual([...app.tasks.keys()], ['original']);
    assert.equal(app.act('original')?.pinned, true);
    assert.deepEqual(app.act('original')?.asks, []);
    assert.equal(app.act('original')?.ended?.stop, 'interrupted');
    assert.equal(app.tasks.get('original')?.record.get(stored)?.kind, 'result');
    const restored = app.tasks.get('original')!;
    assert.notEqual(restored.ui.url, endpoint);
    assert.equal(restored.checkpoint().arrangement.shelf.watch.by, 'person');
    assert.deepEqual(restored.checkpoint().attached, ['watch']);
    const openFile = path.join(directory, 'tasks', 'original', 'open-task.json');
    assert.equal(fs.statSync(openFile).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(openFile, 'utf8').includes(endpoint));
    app.celler.grant('desktop', 'reports', false);
    await app.close(); app = await start();
    assert.equal(app.tasks.size, 0);
    assert.equal(attachments, 1);
    assert.ok(fs.existsSync(openFile));
    await assert.rejects(call(app.desktop.url, 'task:create', { id: 'original' }), /already a task/);
    app.celler.grant('desktop', 'reports', true);
    await app.close(); app = await start();
    await call(app.desktop.url, 'task:close', 'original');
    assert.ok(!fs.existsSync(openFile));
    const archived = JSON.parse(fs.readFileSync(path.join(path.dirname(openFile), 'closed-task.json'), 'utf8'));
    assert.equal(archived.thread.filter((entry: { kind: string }) => entry.kind === 'user').length, 1);
    await app.close(); app = await start();
    assert.equal(app.tasks.size, 0);
    await assert.rejects(call(app.desktop.url, 'task:create', { id: 'original', harness: 'reports' }), /already a task/);
    assert.equal(attachments, 1);
    assert.equal(messages, 1);
  } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
