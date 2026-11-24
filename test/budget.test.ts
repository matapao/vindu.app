// Desktop's processors and its day's budget, through the Celler host: what it may use from the start, its usage counted,
// and the next turn refused once it reaches the daily limit the person sets under Processors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processors } from './consumer.js';
import os from 'node:os';
import path from 'node:path';
import type { TaskConnection, TaskConsumer } from '../src/task.js';
import { afterAll, beforeAll, test } from 'vitest';
import { startApp, type App } from '../src/app.js';

const specs: { prompt: string }[] = [];
let app: App, directory: string;

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

function connect(task: TaskConnection): TaskConsumer {
  return {
    async send(message) {
      specs.push({ prompt: message.text });
      task.text(message.text);
      return { text: message.text, usage: { totalTokens: 10 }, costUsd: 0.25 };
    },
  };
}

beforeAll(async () => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-budget-')));
  const userData = path.join(directory, 'data');
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ tasksFolder: path.join(directory, 'work') }));
  app = await startApp({ userData, home: directory, port: 17640, processors, connect });
});
afterAll(async () => {
  await app?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('Desktop has the registered processors, and connectors are chosen for each task', async () => {
  assert.deepEqual(app.shell.apps().map(item => item.id), ['desktop']);
  assert.deepEqual(app.celler.grants('desktop'), ['claude', 'codex']);
  await assert.rejects(shellCall('shell:grant', 'desktop', 'connector:accounts', true), /gives each task the connectors the person chooses/);
  await assert.rejects(shellCall('shell:grant', 'desktop', 'missing', true), /No access/);
  await assert.rejects(shellCall('shell:open', 'workshop'), /no app/);
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
