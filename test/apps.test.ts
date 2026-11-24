// Exercise app registration, grants, connector tools and usage through the Celler host with an in-process fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processors } from './consumer.js';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import type { TaskConnection, TaskConsumer } from '../src/task.js';
import { afterAll, beforeAll, test } from 'vitest';
import { startApp, type App } from '../src/app.js';

const KEY = 'synthetic-accounts-key';
const seen: string[] = [];
const specs: { cwd: string; processor: string; prompt: string; servers: string[] }[] = [];
let app: App, directory: string, userData: string, api: http.Server;

function pageCall(url: string, ch: string, ...args: unknown[]): Promise<unknown> {
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
    ws.onerror = () => reject(new Error('The test page socket did not open'));
  });
}
const shellCall = (ch: string, ...args: unknown[]) => pageCall(app.shell.url, ch, ...args);
const desktopCall = (ch: string, ...args: unknown[]) => pageCall(app.desktop.url, ch, ...args);

function folderApp(id: string, name: string, asks: string[]) {
  const dir = path.join(directory, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ id, name, asks, icon: 'icon.svg', serve: { command: process.execPath, args: ['server.mjs'] } }));
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
  fs.writeFileSync(path.join(dir, 'server.mjs'), `import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const url = process.env.HARNESS_URL, token = process.env.HARNESS_TOKEN;
const access = url && token ? await (await fetch(url + '/access', { headers: { authorization: 'Bearer ' + token } })).json() : null;
http.createServer((req, res) => {
  if (process.env.VINDU_KEY_TEST_CREDENTIAL) return void res.writeHead(500).end();
  if (req.url !== '/' + process.env.APP_TOKEN + '/') return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access, shell: !!process.env.SHELL_ORIGINS && process.env.SHELL_ORIGINS === process.env.VINDU_SHELL }));
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
  return dir;
}

function connect(task: TaskConnection): TaskConsumer {
  return {
    async send(message) {
      let text = message.text;
      specs.push({ cwd: task.cwd, processor: task.processor, prompt: text, servers: task.mcpServers.map(endpoint => endpoint.name) });
      if (text === 'read invoices') {
        assert.ok(task.callTool);
        const read = await task.callTool('accounts', 'read', { path: '/invoices' });
        assert.ok(!read.isError);
        text = JSON.stringify(read);
      }
      task.text(text);
      return { text, usage: { totalTokens: 10 }, costUsd: 0.25 };
    },
  };
}

beforeAll(async () => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-apps-')));
  userData = path.join(directory, 'data');
  const connectors = path.join(userData, 'connectors', 'accounts');
  fs.mkdirSync(connectors, { recursive: true });
  api = http.createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    res.writeHead(req.headers.authorization === `Bearer ${KEY}` ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify({ number: 'INV-0412' }));
  });
  await new Promise<void>((resolve, reject) => {
    api.once('error', reject);
    api.listen(0, '127.0.0.1', resolve);
  });
  fs.writeFileSync(path.join(connectors, 'connector.json'), JSON.stringify({ name: 'accounts', kind: 'http', http: {
    base: `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`, auth: { type: 'bearer', secret: 'accounts-key' },
  } }));
  const installed = [folderApp('workshop', 'Workshop', ['processors', 'connectors', 'storage']), folderApp('other', 'Other', ['processors']), folderApp('plain', 'Plain', [])];
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ installed, tasksFolder: path.join(directory, 'work') }));
  fs.writeFileSync(path.join(userData, 'keys.json'), JSON.stringify({ 'accounts-key': 'memory' }));
  app = await startApp({ userData, home: directory, port: 17640, processors, connect,
    secrets: { available: async () => true, set: async () => 'memory', clear: async () => undefined, get: async key => key === 'accounts-key' ? KEY : undefined } });
  await shellCall('shell:grant', 'workshop', 'claude', true);
  await shellCall('shell:grant', 'workshop', 'connector:accounts', true);
});
afterAll(async () => {
  await app?.close();
  if (api) await new Promise<void>(resolve => api.close(() => resolve()));
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('the grid grants processors and connectors only to apps that request them', async () => {
  assert.deepEqual(app.shell.apps().map(item => [item.id, item.asks]), [
    ['desktop', ['processors', 'connectors']], ['workshop', ['processors', 'connectors', 'storage']], ['other', ['processors']], ['plain', []],
  ]);
  assert.deepEqual(app.celler.grants('desktop'), ['claude', 'codex']);
  assert.deepEqual(app.celler.grants('workshop'), ['claude', 'connector:accounts']);
  assert.deepEqual(app.celler.grants('other'), []);
  await assert.rejects(shellCall('shell:grant', 'plain', 'claude', true));
  await assert.rejects(shellCall('shell:grant', 'other', 'connector:accounts', true));
  const workshop = app.shell.apps().find(item => item.id === 'workshop')!;
  const prior = process.env.VINDU_KEY_TEST_CREDENTIAL;
  process.env.VINDU_KEY_TEST_CREDENTIAL = 'synthetic-for-this-test';
  let workshopUrl: string;
  try { workshopUrl = await workshop.start!(); }
  finally { if (prior === undefined) delete process.env.VINDU_KEY_TEST_CREDENTIAL; else process.env.VINDU_KEY_TEST_CREDENTIAL = prior; }
  const { access, shell } = await (await fetch(workshopUrl)).json();
  assert.equal(shell, true);
  assert.deepEqual(access.processors.map((processor: { id: string }) => processor.id), ['claude']);
  assert.deepEqual(access.connectors, ['accounts']);
  assert.equal(access.storage, path.join(userData, 'apps', 'workshop', 'storage'));
  const plain = app.shell.apps().find(item => item.id === 'plain')!;
  assert.deepEqual(await (await fetch(await plain.start!())).json(), { access: null, shell: true });
  assert.deepEqual(app.appAccess('plain'), {});
});

test('a folder app forwards the exact prompt to its granted consumer and uses its chosen connector', async () => {
  const { CELLER_URL, CELLER_TOKEN } = app.appAccess('workshop');
  const run = (processor: string, connectors: string[]) => fetch(`${CELLER_URL}/runs`, {
    method: 'POST', headers: { authorization: `Bearer ${CELLER_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ processor, prompt: 'read invoices', connectors }),
  });
  const before = specs.length;
  assert.equal((await run('codex', [])).status, 400);
  assert.equal((await run('claude', ['missing'])).status, 400);
  assert.equal(specs.length, before);
  const response = await run('claude', ['accounts']);
  const reply = await response.json();
  assert.equal(response.status, 200, JSON.stringify(reply));
  assert.equal(reply.stopReason, 'end_turn');
  assert.equal(typeof reply.task, 'string');
  assert.ok(specs.at(-1)!.cwd.startsWith(path.join(directory, 'work', 'workshop') + path.sep));
  assert.equal(specs.at(-1)!.processor, 'claude');
  assert.equal(specs.at(-1)!.prompt, 'read invoices');
  assert.ok(specs.at(-1)!.servers.includes('ui'));
  assert.ok(!JSON.stringify(specs.at(-1)).includes(KEY));
  assert.deepEqual(seen, [`Bearer ${KEY}`]);
  assert.equal(app.celler.spent('workshop').tokens, 10);
  assert.equal(app.celler.spent('workshop').cost, 0.25);
  const db = new DatabaseSync(path.join(userData, 'celler', 'runs.sqlite'), { readOnly: true });
  try {
    const events = db.prepare(`SELECT events.kind, events.detail FROM events JOIN runs ON events.run = runs.id
      WHERE json_extract(runs.body, '$.owner') = ?`).all('workshop');
    assert.ok(events.some(event => event.kind === 'ended'));
    assert.ok(!JSON.stringify(events).includes(KEY));
  } finally { db.close(); }
});

test('Desktop usage is counted and the next turn is refused at the daily limit', async () => {
  await desktopCall('task:create', { id: 'own1', harness: 'claude', title: 'Usage fixture' });
  await desktopCall('task:prompt', 'own1', 'First turn');
  assert.equal(app.celler.spent('desktop').tokens, 10);
  assert.equal(app.celler.spent('desktop').cost, 0.25);
  try {
    await shellCall('shell:budget', 'desktop', { tokens: 10 });
    const before = specs.length;
    await assert.rejects(desktopCall('task:prompt', 'own1', 'Refused turn'), /Daily tokens budget reached/);
    assert.equal(specs.length, before);
    const all = await shellCall('shell:budgets') as { app: string; limits: { tokens: number } }[];
    assert.equal(all.find(row => row.app === 'desktop')?.limits.tokens, 10);
    await assert.rejects(shellCall('shell:budget', 'missing', {}), /no app/);
  } finally {
    await shellCall('shell:budget', 'desktop', {});
    await desktopCall('task:close', 'own1');
  }
});


test('a different installed folder with an existing app ID cannot receive its grants or storage', async () => {
  const settingsFile = path.join(userData, 'settings.json');
  const original = fs.readFileSync(settingsFile, 'utf8');
  const settings = JSON.parse(original) as { installed: string[] };
  const replacement = fs.mkdtempSync(path.join(directory, 'replacement-'));
  fs.writeFileSync(path.join(replacement, 'app.json'), fs.readFileSync(path.join(directory, 'workshop', 'app.json')));
  try {
    settings.installed = [replacement];
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    assert.equal(app.shell.apps().some(a => a.id === 'workshop'), false);
    await assert.rejects(shellCall('shell:open', 'workshop'), /no app/);
  } finally { fs.writeFileSync(settingsFile, original); }
  assert.deepEqual(app.celler.grants('workshop'), ['claude', 'connector:accounts']);
});
