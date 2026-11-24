// Desktop's processors and its day's budget, through the Celler host, as its Settings set them: what it may use from the
// start, its usage counted, and the next turn refused once it reaches the daily limit the person sets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processors } from './synthetic-processor.js';
import os from 'node:os';
import path from 'node:path';
import type { TaskConnection, TaskProcessor } from '../src/task.js';
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
const desktopCall = (ch: string, ...args: unknown[]) => pageCall(app.desktop.url, ch, ...args);

function connect(task: TaskConnection): TaskProcessor {
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
  assert.deepEqual(app.celler.grants(), ['claude', 'codex']);
  const listed = await desktopCall('settings:processors') as { processors: { id: string }[]; granted: string[] };
  assert.deepEqual([listed.processors.map(p => p.id), listed.granted], [['claude', 'codex'], ['claude', 'codex']]);
  assert.deepEqual(await desktopCall('settings:grant', 'codex', false), ['claude']);
  assert.deepEqual(await desktopCall('app:processors'), [{ id: 'claude', name: 'Claude Code' }]); // Desktop's picker follows
  assert.deepEqual(await desktopCall('settings:grant', 'codex', true), ['claude', 'codex']);
  await assert.rejects(desktopCall('settings:grant', 'connector:accounts', true), /No access/);
  await assert.rejects(desktopCall('settings:grant', 'missing', true), /No access/);
});

test('Desktop usage is counted and the next turn is refused at the daily limit', async () => {
  await desktopCall('task:create', { id: 'own1', harness: 'claude', title: 'Usage fixture' });
  await desktopCall('task:prompt', 'own1', 'First turn');
  assert.equal(app.celler.spent().tokens, 10);
  assert.equal(app.celler.spent().cost, 0.25);
  try {
    const set = await desktopCall('settings:set-budget', { tokens: 10 }) as { limits: { tokens: number }; over?: string };
    assert.equal(set.limits.tokens, 10); assert.equal(set.over, 'Daily tokens budget reached');
    const before = specs.length;
    await assert.rejects(desktopCall('task:prompt', 'own1', 'Refused turn'), /Daily tokens budget reached/);
    assert.equal(specs.length, before);
    assert.equal((await desktopCall('settings:budget') as { limits: { tokens: number } }).limits.tokens, 10);
  } finally {
    await desktopCall('settings:set-budget', {});
    await desktopCall('task:close', 'own1');
  }
});
