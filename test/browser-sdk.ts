// A consumer's renderer talks to its own UI session using only the public SDK and an ordinary MCP client.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ShellHandle } from '@matapao/vindu';
import { memoryResults, startVindu, type Shown, type ShellEvent } from '@matapao/vindu/server';

declare global { interface Window { meter: { shell: ShellHandle } } }
const dir = mkdtempSync(path.join(os.tmpdir(), 'vindu-sdk-browser-'));
const provider = await startVindu({ cards: [{ name: 'depth', about: 'Water depth at each station', component: 'DepthGauge', shows: () => ['station', 'depth'] }] });
const client = new Client({ name: 'meter', version: '1' });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const results = memoryResults(dir);
  const source = results.add({ server: 'meter', tool: 'readings', value: [{ station: 'North', depth: 12 }, { station: 'South', depth: 19 }] });
  const views: Shown[] = [];
  const suggestions: string[] = [];
  const session = provider.open({ dir, results }, { onView: view => views.push(view), onSuggest: prompt => suggestions.push(prompt) });
  const endpoint = session.mcpServer;
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }));
  const reply = await client.callTool({ name: 'show_view', arguments: {
    name: 'readings', title: 'Water readings', panels: [
      { id: 'stations', card: 'table', from: source.id, columns: ['station', 'depth'] }, { id: 'gauge', card: 'depth', from: source.id },
    ], suggestions: [{ label: 'Compare stations', prompt: 'Compare the two depths.' }],
  } });
  assert.ok(!reply.isError, JSON.stringify(reply.content));
  assert.equal(views.length, 1);
  const { outputFiles } = await build({ entryPoints: ['test/fixtures/sdk-window.ts'], platform: 'browser', bundle: true, write: false, format: 'iife', globalName: 'meter' });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const events: Promise<void>[] = [];
  await page.exposeFunction('sendToSession', (event: ShellEvent) => {
    const accepted = session.event(event);
    if (event.type === 'select' || event.type === 'attach') events.push(page.evaluate(state => window.meter.shell.state(state), session.shell()));
    return accepted;
  });
  await page.setContent('<main style="width:100vw;height:95vh"></main>');
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.evaluate(({ shown, state }) => { window.meter.shell.view(shown); window.meter.shell.state(state); }, { shown: views[0], state: session.shell() });
  await page.getByText('12 m at North', { exact: true }).waitFor();
  assert.equal(await page.locator('station-depth').evaluate(el => getComputedStyle(el).getPropertyValue('--v-accent').trim()), '#315971');
  await page.getByText('South', { exact: true }).click({ modifiers: ['Alt'] });
  await page.getByRole('button', { name: 'In the chat' }).click();
  await page.getByText('Compare stations', { exact: true }).click();
  // Round-trip on the same browser bridge after the click so its preceding event has reached the host.
  await page.evaluate(() => window.sendToSession({ type: 'focus', view: 'readings' }));
  assert.deepEqual(suggestions, ['Compare the two depths.']);
  await Promise.all(events);
  const context = session.context().text;
  assert.match(context, /ctx:r1#\/1/);
  assert.match(context, /South/);
  assert.match(context, /"in_the_chat":\[\{"view":"readings"/);
  console.log('ok - the public browser SDK renders a consumer card and returns the selected row, attached pane and unsent suggestion');
} finally {
  try { await browser?.close(); await client.close(); }
  finally { await provider.close(); rmSync(dir, { recursive: true, force: true }); }
}
