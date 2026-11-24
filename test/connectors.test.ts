// Local stand-ins verify that connector effects are decided by Celler and credentials stay in the host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { openCellerHost } from '../src/celler-host.js';
import { test } from 'vitest';
import { configuredServers, connectorTools, loadConnectors } from '../src/connectors.js';

const KEY = 'synthetic-connector-key';

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-connectors-'));
  const requests: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: req.url }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const dir = path.join(directory, 'accounts');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'connector.json'), JSON.stringify({
    name: 'accounts', title: 'Accounts', kind: 'http',
    http: { base, auth: { type: 'bearer', secret: 'accounts-key' }, reads: ['POST /search'] },
  }));
  return { directory, base, requests, async close() {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

test('the connector host stages the exact write for the person to review and permits declared reads', async () => {
  const api = await fixture();
  const host = openCellerHost(path.join(api.directory, 'host'));
  const { connectors, failed } = loadConnectors(api.directory);
  assert.equal(Object.keys(failed).length, 0);
  const bridge = await connectorTools(connectors, { key: () => KEY });
  assert.deepEqual(bridge.nodes.map(node => node.id), ['accounts.read', 'accounts.write']);
  assert.ok(!JSON.stringify(bridge.nodes).includes(KEY));
  const [read, write] = bridge.nodes;
  host.register('records', ['review', 'connector:accounts']);
  const common = { owner: 'records', processor: 'review', cwd: api.directory, adapters: bridge.adapters };
  try {
    const result = await host.callTool({ ...common, node: read, input: { method: 'POST', path: '/search', body: { filter: 'open' } } });
    assert.ok(!result.isError);
    const refused = await host.callTool({ ...common, node: read, input: { method: 'POST', path: '/send' } });
    assert.equal(refused.isError, true);
    let reviewed = false;
    const written = await host.callTool({ ...common, node: write, input: { method: 'PATCH', path: '/send', body: '{"message":"exact"}', contentType: 'text/plain' },
      async ask(question) {
        assert.deepEqual(api.requests, [{ method: 'POST', url: '/v1/search', auth: `Bearer ${KEY}`, body: '{"filter":"open"}' }]);
        const packet = question.input as { destination: string; operation: string; content: { body: string } };
        assert.equal(packet.destination, `${api.base}/send`);
        assert.equal(packet.operation, 'PATCH');
        assert.equal(packet.content.body, '{"message":"exact"}');
        assert.ok(!JSON.stringify(question).includes(KEY));
        reviewed = true;
        return { option: 'allow' };
      },
    });
    assert.ok(reviewed);
    assert.ok(!written.isError);
    assert.deepEqual(api.requests.at(-1), { method: 'PATCH', url: '/v1/send', auth: `Bearer ${KEY}`, body: '{"message":"exact"}' });
    const db = new DatabaseSync(path.join(api.directory, 'host', 'runs.sqlite'), { readOnly: true });
    try {
      const events = db.prepare('SELECT kind, detail FROM events').all();
      assert.ok(events.some(event => event.kind === 'ended'));
      assert.ok(!JSON.stringify(events).includes(KEY));
    } finally { db.close(); }
  } finally { await host.close(); await api.close(); }
});

test('two owners can read concurrently through one connector with their own grants and results', async () => {
  const api = await fixture();
  const host = openCellerHost(path.join(api.directory, 'host'));
  const bridge = await connectorTools(loadConnectors(api.directory).connectors, { key: () => KEY, readsOnly: true });
  const requests = [{ owner: 'billing', path: '/invoices' }, { owner: 'purchasing', path: '/orders' }];
  const checked = new Set<string>();
  try {
    const replies = await Promise.all(requests.map(({ owner, path: resource }) => {
      host.register(owner, ['review']);
      return host.callTool({ owner, processor: 'review', cwd: api.directory, node: bridge.nodes[0], adapters: bridge.adapters,
        input: { path: resource }, mayUse: connector => { checked.add(owner); return connector === 'accounts'; } });
    }));
    assert.deepEqual([...checked].sort(), ['billing', 'purchasing']);
    replies.forEach((reply, index) => {
      assert.ok(!reply.isError);
      assert.ok(JSON.stringify(reply.content).includes(requests[index].path));
    });
    assert.deepEqual(api.requests.map(request => request.url).sort(), ['/v1/invoices', '/v1/orders']);
  } finally { await host.close(); await api.close(); }
});

test('read-only connector bindings do not provide write adapters and external paths are refused', async () => {
  const api = await fixture();
  try {
    const { connectors } = loadConnectors(api.directory);
    const bridge = await connectorTools(connectors, { key: () => KEY, readsOnly: true });
    assert.deepEqual(bridge.nodes.map(node => node.id), ['accounts.read']);
    const binding = bridge.nodes[0];
    assert.ok('adapter' in binding.target);
    const adapter = bridge.adapters.get(binding.target.adapter);
    assert.ok(adapter && 'call' in adapter);
    const run = { id: 'fixture', owner: 'person', revision: 'fixture', entry: 'fixture', workspace: api.directory, parent: null };
    for (const requested of ['/../../escape', '//elsewhere.test/path', '/%2fetc', '/a%5c..', '/x#fragment']) {
      await assert.rejects(adapter.call(run, { path: requested }, new AbortController().signal));
    }
    assert.deepEqual(api.requests, []);
  } finally {
    await api.close();
  }
});


test('Vindu can load only a selected MCP App resource and Celler binds each tool to its declared audience', async () => {
  const uri = 'ui://example/dashboard';
  const other = 'ui://example/private';
  const legacy = 'ui://example/legacy';
  const server = http.createServer(toNodeHandler(createMcpHandler(() => {
    const mcp = new McpServer({ name: 'fixture', version: '1' });
    mcp.registerResource('Dashboard', uri, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
      contents: [{ uri, text: '<main>Dashboard</main>' }, { uri: other, text: 'Another resource' }],
    }));
    mcp.registerResource('Legacy', legacy, { mimeType: 'text/html;profile=mcp-app' }, async () => ({
      contents: [{ uri: legacy, text: '<main>Legacy</main>' }],
    }));
    mcp.registerResource('Unlisted', other, { mimeType: 'text/html' }, async () => ({
      contents: [{ uri: other, text: 'Do not read through the App bridge' }],
    }));
    for (const [tool, visibility] of [['open', ['model']], ['lookup', ['app']], ['refresh', undefined]] as const) {
      mcp.registerTool(tool, {
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
        _meta: { ui: { ...(tool === 'open' ? { resourceUri: uri } : {}), ...(visibility ? { visibility } : {}) } },
      }, async () => ({ content: [{ type: 'text', text: tool }] }));
    }
    for (const [tool, meta] of [
      ['legacy', { 'ui/resourceUri': legacy, ui: { visibility: [] } }],
      ['invalid', { 'ui/resourceUri': other, ui: { resourceUri: null, visibility: 'app' } }],
    ] as const) {
      mcp.registerTool(tool, { inputSchema: z.object({}), _meta: meta }, async () => ({ content: [] }));
    }
    mcp.registerTool('unsafe-diagnostic', { description: KEY, inputSchema: z.object({}) }, async () => ({ content: [] }));
    return mcp;
  })));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const connectors = configuredServers([{
      type: 'http',
      name: 'fixture',
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
      secrets: [{ name: 'Authorization', value: `Bearer ${KEY}` }],
    }]);
    let grant = true;
    const bridge = await connectorTools(connectors, { mayUse: () => grant });
    assert.deepEqual(bridge.notes, []);
    assert.deepEqual(bridge.nodes.map(node => node.id).sort(), ['fixture.open', 'fixture.refresh']);
    assert.deepEqual(bridge.appNodes.map(node => node.id).sort(), ['fixture.lookup', 'fixture.refresh']);
    assert.deepEqual((await bridge.read('fixture', uri)).contents.map(item => item.uri), [uri]);
    assert.deepEqual((await bridge.read('fixture', legacy)).contents.map(item => item.uri), [legacy]);
    await assert.rejects(bridge.read('fixture', other));
    await assert.rejects(bridge.read('unknown', uri));
    grant = false;
    assert.equal(bridge.tools('fixture'), undefined);
    await assert.rejects(bridge.read('fixture', uri));
    await bridge.close();
  } finally {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
