// A server's keys as the settings name them: by the name of a key the app keeps, never the key itself. Each becomes one
// of the server's secrets, which the connector host gives to the server and never to the harness; a server whose key is not set
// is not started, and a key written out in the settings is told. All keys here are synthetic.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectorKeyIndex } from '../src/secrets.js';
import type { ServerSpec } from '../src/connectors.js';
import { envName, serverKeys, withKeys } from '../src/keyrefs.js';

const kept: Record<string, string> = { crm: 'k-crm-synthetic', db: 'k-db-synthetic' };
const keyNamed = async (n: string) => kept[n];
const settings = [
  { type: 'http', name: 'crm', url: 'https://crm.example/mcp', headers: [{ name: 'Authorization', key: 'crm', prefix: 'Bearer ' }, { name: 'X-Tenant', value: 'north' }] },
  { name: 'db', command: 'mcp-server-db', args: [], env: [{ name: 'DB_KEY', key: 'db' }, { name: 'DB_REGION', value: 'west' }] },
] as unknown as ServerSpec[];

test('a key the settings name goes to the server as one of its secrets, and what is not a key stays as it is', async () => {
  const { servers, notes } = await withKeys(settings, keyNamed);
  assert.deepEqual(notes, []);
  const [crm, db] = servers as unknown as { headers?: unknown[]; env?: unknown[]; secrets?: unknown[] }[];
  assert.deepEqual(crm.headers, [{ name: 'X-Tenant', value: 'north' }]);
  assert.deepEqual(crm.secrets, [{ name: 'Authorization', value: 'Bearer k-crm-synthetic' }]);
  assert.deepEqual(db.env, [{ name: 'DB_REGION', value: 'west' }]);
  assert.deepEqual(db.secrets, [{ name: 'DB_KEY', value: 'k-db-synthetic' }]);
  assert.deepEqual(serverKeys(settings), [{ key: 'crm', title: 'crm (Authorization)' }, { key: 'db', title: 'db (DB_KEY)' }]);
});

test('a server whose key is not set is not started, and the note says where to set it', async () => {
  const { servers, notes } = await withKeys(settings, async n => (n === 'db' ? undefined : kept[n]));
  assert.deepEqual(servers.map(s => s.name), ['crm']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /the server "db" takes the key "db" \(for DB_KEY\), which is not set yet: set it on the Connector Keys page \(the key button in Activity\), or as VINDU_KEY_DB in the app's environment\. It is not started/);
  assert.equal(envName('my-crm.key'), 'VINDU_KEY_MY_CRM_KEY');
});

test('a key written out in the settings still goes as it is, with a note to keep it with the app\'s keys', async () => {
  const written = [{ type: 'http', name: 'crm', url: 'https://crm.example/mcp', headers: [{ name: 'Authorization', value: 'Bearer written-synthetic' }] }] as unknown as ServerSpec[];
  const { servers, notes } = await withKeys(written, keyNamed);
  assert.deepEqual((servers[0] as unknown as { headers: unknown[] }).headers, [{ name: 'Authorization', value: 'Bearer written-synthetic' }]);
  assert.match(notes.join(), /the server "crm" has Authorization written out in settings\.json: keep it with the app's keys instead/);
  assert.ok(!notes.join().includes('written-synthetic'), 'the note never says the key');
});

test('concurrent key saves and clears preserve the other keys, including after a failed operation and restart', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-key-index-'));
  const file = path.join(folder, 'keys.json');
  try {
    const index = connectorKeyIndex(file);
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const first = index.update('first', async () => { await pause; return 'first-marker'; });
    const second = index.update('second', async () => 'second-marker');
    release();
    await Promise.all([first, second]);
    assert.deepEqual({ ...connectorKeyIndex(file).read() }, { first: 'first-marker', second: 'second-marker' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const failed = index.update('second', async () => { throw new Error('store unavailable'); });
    const clear = index.update('first', async previous => { assert.equal(previous, 'first-marker'); return undefined; });
    await assert.rejects(failed, /store unavailable/);
    await clear;
    assert.deepEqual({ ...index.read() }, { second: 'second-marker' });
    fs.writeFileSync(file, '{');
    await assert.rejects(index.update('third', async () => 'third-marker'));
    assert.equal(fs.readFileSync(file, 'utf8'), '{');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
