import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startVindu } from '@matapao/vindu/server';
import { openTask } from '../src/task.js';

test('a task with no processor still serves its UI over MCP', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-detached-'));
  const uiProvider = await startVindu();
  const client = new Client({ name: 'independent-client', version: '1' });
  try {
    const task = await openTask({ harness: 'reports', cwd: directory, dataDir: directory, uiProvider, onShow() {}, onText() {} });
    try {
      assert.equal(task.attached, false);
      await assert.rejects(task.prompt('Hello'), /No processor is connected/);
      await client.connect(new StreamableHTTPClientTransport(new URL(task.ui.url)));
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === 'show_view'));
      const result = await client.callTool({ name: 'look', arguments: {} });
      assert.ok(!result.isError);
    } finally { await client.close(); await task.close(); }
  } finally { await uiProvider.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the processor receives the files and cancellation for its turn and releases its session on close', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-processor-turn-'));
  const uiProvider = await startVindu();
  let received!: () => void;
  const ready = new Promise<void>(resolve => { received = resolve; });
  const attachment = path.join(directory, 'note.txt');
  fs.writeFileSync(attachment, 'Note from the person');
  let copy: string | undefined, closes = 0;
  const output: string[] = [];
  try {
    const task = await openTask({ harness: 'reports', cwd: directory, dataDir: directory, uiProvider, onShow() {}, onText: text => output.push(text),
      connect: session => ({
        async send({ text, attachments, signal }) {
          assert.equal(text, 'Read this');
          assert.equal(attachments.length, 1);
          const file = attachments[0];
          copy = file.path;
          assert.notEqual(copy, attachment);
          assert.equal(file.name, 'note.txt');
          assert.equal(file.type, 'text/plain');
          assert.equal(file.size, fs.statSync(attachment).size);
          assert.equal(fs.readFileSync(copy, 'utf8'), 'Note from the person');
          session.text('Reading');
          received();
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
          session.text('Too late');
          return { text: '' };
        },
        close() { closes++; },
      }),
    });
    try {
      const turn = task.prompt('Read this', [{ file: attachment, mime: 'text/plain', name: 'note.txt' }]);
      await Promise.race([ready, turn.then(() => { throw new Error('Turn ended before the file was received'); })]);
      await assert.rejects(task.prompt('Another message'), /already has a running turn/);
      await task.cancel();
      assert.equal((await turn).stopReason, 'cancelled');
      assert.deepEqual(output, ['Reading']);
      assert.ok(copy && !fs.existsSync(copy));
    } finally { await task.close(); }
    await task.close();
    assert.equal(closes, 1);
  } finally { await uiProvider.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
