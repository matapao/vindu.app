// A connector that requires OAuth is unavailable until the app has a supported credential configuration.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'vitest';
import { connectorTools } from '../src/connectors.js';

test('OAuth-only MCP connectors fail closed and offer the person a setup notice', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.writeHead(401).end(); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as { port: number };
    const bridge = await connectorTools([{
      name: 'ledger', title: 'Ledger', notes: [], kind: 'mcp',
      mcp: { name: 'ledger', auth: 'oauth', type: 'http', url: `http://127.0.0.1:${port}/mcp` },
    }]);
    assert.equal(requests, 0);
    assert.deepEqual(bridge.nodes, []);
    assert.equal(bridge.adapters.size, 0);
    assert.ok(bridge.notes.some(note => note.includes('Ledger') && /list its tools|OAuth/.test(note)));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
