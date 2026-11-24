import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { memoryResults, startVindu, type UiEndpoint, type ViewPresentation } from '@matapao/vindu/server';
import { test } from 'vitest';

async function connect(endpoint: UiEndpoint) {
  const client = new Client({ name: 'consumer', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }));
  return client;
}

test('an independent MCP client uses the registered cards and only the data of its UI session', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vindu-sdk-'));
  const results = memoryResults(dir);
  const secondDir = mkdtempSync(path.join(dir, 'other-'));
  const row = { station: 'North', depth: 12 };
  const source = results.add({ server: 'readings', tool: 'get_depths', value: [row] });
  const provider = await startVindu({ cards: [{ name: 'depth', about: 'Water depth at each station', component: 'DepthGauge', shows: () => ['station', 'depth'] }] });
  const views: ViewPresentation[] = [];
  const session = provider.open({ dir, results }, { onPresentation: view => views.push(view) });
  const other = provider.open({ dir: secondDir, results: memoryResults(secondDir) });
  const clients: Client[] = [];
  try {
    const client = await connect(session.mcpServer);
    clients.push(client);
    const independent = await connect(other.mcpServer);
    clients.push(independent);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'show_view'));
    assert.notEqual(session.mcpServer.url, other.mcpServer.url);
    const displayed = await client.callTool({ name: 'show_view', arguments: {
      name: 'readings', title: 'Water readings', panels: [{ id: 'depths', card: 'depth', from: source.id }],
    } });
    assert.ok(!displayed.isError, JSON.stringify(displayed.content));
    assert.deepEqual(views.at(-1)?.panels[0].rows, [row]);
    session.pane({ name: 'map', title: 'Station map', kind: 'map', about: () => ({ station: row.station }) });
    const account = await client.callTool({ name: 'look', arguments: {} });
    assert.match(JSON.stringify(account.content), /Station map/);
    const separate = await independent.callTool({ name: 'look', arguments: {} });
    assert.doesNotMatch(JSON.stringify(separate.content), /Station map|Water readings/);
    assert.equal(other.shell().views.length, 0);
    session.close();
    session.close();
    assert.equal((await fetch(session.mcpServer.url)).status, 404);
    assert.ok((await independent.listTools()).tools.length > 0);
  } finally {
    try { await Promise.all(clients.map(client => client.close())); }
    finally {
      await Promise.all([provider.close(), provider.close()]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.throws(() => provider.open({ dir, results }), /closed/);
});

test.each(['session', 'provider'])('closing a %s revokes access and releases every watch even when a disposer fails', async mode => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vindu-dispose-'));
  const results = memoryResults(dir);
  const panels = ['North', 'South'].map(station => {
    const source = results.add({ server: 'meter', tool: 'read', input: { station }, value: [{ depth: 12 }] });
    return { id: station.toLowerCase(), card: 'table', from: source.id, live: { every: 30 } };
  });
  const stopped: string[] = [];
  const failure = new Error('The subscription was already disconnected');
  const provider = await startVindu();
  let reentrantClose: Promise<void> | undefined;
  const ui = provider.open({ dir, results }, {
    isRead: () => true,
    watch: source => () => {
      stopped.push(source.after);
      ui.close(); // a consumer can reenter teardown from its unsubscribe callback
      if (mode === 'provider') reentrantClose = provider.close();
      if (source.after === 'r1') throw failure;
    },
  });
  const other = provider.open({ dir: mkdtempSync(path.join(dir, 'other-')), results });
  const client = await connect(ui.mcpServer);
  try {
    const shown = await client.callTool({ name: 'show_view', arguments: { name: 'depths', title: 'Depths', panels } });
    assert.ok(!shown.isError, JSON.stringify(shown.content));
    await client.close();
    const failedUnsubscribe = (error: unknown) => error instanceof AggregateError && error.errors.includes(failure);
    if (mode === 'session') {
      assert.throws(() => ui.close(), failedUnsubscribe);
      assert.equal((await fetch(ui.mcpServer.url)).status, 404);
      const remaining = await connect(other.mcpServer);
      await remaining.close();
    } else {
      const closing = provider.close();
      assert.throws(() => provider.open({ dir, results }), /closed/);
      await assert.rejects(closing, error => error instanceof AggregateError && error.errors.some(failedUnsubscribe));
      assert.equal(reentrantClose, closing);
      assert.equal(other.event({ type: 'window', w: 400, h: 400 }), false);
      await assert.rejects(fetch(other.mcpServer.url));
    }
    ui.close();
    assert.deepEqual(stopped.sort(), ['r1', 'r2']);
  } finally {
    await client.close();
    try { await provider.close(); } catch { /* The throwing disposer is asserted above. */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
