// The test app receives the selected processor and an exact prompt from the real desktop UI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../src/app.js';
import { openDesktop } from './browse.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-browser-processors-'));
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
  tasksFolder: path.join(directory, 'work'),
  inference: [{ name: 'old-endpoint', harness: 'claude', base: 'http://127.0.0.1:1', model: 'old-model' }],
}));
const runs: { processor: string; prompt: string; context: string; servers: string[] }[] = [];
let connections = 0;
const start = () => startApp({ userData: directory, home: directory, port: 17770,
  processors: [{ id: 'writing', name: 'Writing' }, { id: 'records', name: 'Records' }],
  connect: task => { connections++; return {
    async send(message) {
      runs.push({ processor: task.processor, prompt: message.text, context: message.context, servers: task.mcpServers.map(server => server.name) });
      if (message.text === 'Use the selected processor.') {
        const from = task.observe({ connector: 'reports', tool: 'list', input: {}, result: {
          content: [{ type: 'text', text: JSON.stringify([{ number: 'INV-0042', status: 'Open' }]) }],
        } });
        const endpoint = task.mcpServers.find(server => server.name === 'ui')!;
        const client = new Client({ name: 'report-app', version: '1' });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }));
          const result = await client.callTool({ name: 'show_view', arguments: { name: 'invoices', title: 'Invoices',
            panels: [{ id: 'list', card: 'table', from, columns: ['number', 'status'] }] } });
          assert.ok(!result.isError);
        } finally { await client.close(); }
      }
      const text = message.text === 'Use this invoice.' ? 'Received the invoice.' : `Reply from ${task.processor} fixture`;
      task.text(text);
      return { text };
    },
  }; },
});
let app = await start();
let desktop: Awaited<ReturnType<typeof openDesktop>> | undefined;
try {
  desktop = await openDesktop(app);
  const { page } = desktop;
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#harness option')).some(option => (option as HTMLOptionElement).value === 'records'));
  assert.deepEqual(await page.locator('#harness option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ['writing', 'records']);
  assert.ok(await page.locator('#inference-pick').isHidden());
  console.log('ok 1 - the task bar offers the registered processors and hides the old endpoint');
  await page.locator('#harness').selectOption('records');
  await page.locator('#prompt').fill('Use the selected processor.');
  await page.locator('#send').click();
  await page.locator('#list .act-go', { hasText: 'Use the selected processor.' }).click();
  await page.waitForFunction(() => document.getElementById('thread')?.textContent?.includes('Reply from records fixture'));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].processor, 'records');
  assert.equal(runs[0].prompt, 'Use the selected processor.');
  assert.ok(runs[0].servers.includes('ui'));
  console.log('ok 2 - the chosen processor receives the UI endpoint and its reply appears in the thread');
  const pane = page.locator('.vindu-pane[data-view="invoices"]');
  await pane.getByText('INV-0042', { exact: true }).click({ modifiers: ['Alt'] });
  await page.locator('#chips .chip', { hasText: 'INV-0042' }).waitFor();
  await page.locator('#prompt').fill('Use this invoice.');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.getElementById('thread')?.textContent?.includes('Received the invoice.'));
  assert.equal(runs[1]?.prompt, 'Use this invoice.');
  assert.match(runs[1].context, /INV-0042/);
  assert.match(runs[1].context, /ctx:r1/);
  console.log('ok 3 - the consumer renders an exact result over MCP and receives the selected row with the next message');
  const [id] = app.tasks.keys();
  await page.reload();
  await page.locator('#thread .said', { hasText: 'Received the invoice.' }).waitFor();
  assert.deepEqual(await page.locator('#thread .you').allTextContents(), ['Use the selected processor.', 'Use this invoice.']);
  assert.equal(await page.locator('#thread .said').count(), 2);
  await pane.getByText('INV-0042', { exact: true }).waitFor();
  assert.equal(runs.length, 2);
  console.log('ok 4 - refreshing the open thread restores both messages and the invoice pane');
  await desktop.close(); desktop = undefined;
  await app.close(); app = await start();
  assert.deepEqual([...app.tasks.keys()], [id]);
  assert.equal(connections, 1);
  assert.equal(runs.length, 2);
  desktop = await openDesktop(app);
  const reopened = desktop.page;
  await reopened.locator('#list .act-go', { hasText: 'Use the selected processor.' }).click();
  await reopened.locator('.vindu-pane[data-view="invoices"]').getByText('INV-0042', { exact: true }).waitFor();
  assert.equal(await reopened.locator('#thread .said').count(), 2);
  assert.deepEqual(await reopened.locator('#thread .you').allTextContents(), ['Use the selected processor.', 'Use this invoice.']);
  await reopened.locator('#prompt').fill('A new message after restart.');
  await reopened.locator('#send').click();
  await reopened.waitForFunction(() => document.querySelectorAll('#thread .said').length === 3);
  assert.equal(connections, 2);
  assert.deepEqual(runs.map(run => run.prompt), ['Use the selected processor.', 'Use this invoice.', 'A new message after restart.']);
  console.log('ok 5 - restarting the core restores the same task and connects only for a new message');
  console.log('# 5 passed');
} finally {
  await desktop?.close();
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
