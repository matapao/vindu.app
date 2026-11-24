import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { startApp, type App } from '../src/app.js';
import { keptToken, upgradePageCredentials } from '../src/page-credentials.js';

const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-upgrade-')));
const token = () => randomBytes(24).toString('base64url');

test('an interrupted legacy token write recovers with fresh credentials', async () => {
  const dir = temporary(), file = path.join(dir, 'pages.json');
  try {
    fs.writeFileSync(file, '{"desktop":"');
    await upgradePageCredentials(file, path.join(dir, 'shell.jsonl'));
    const issued = keptToken(file, 'desktop');
    assert.match(issued, /^[\w-]{32}$/);
    assert.equal(keptToken(file, 'desktop'), issued);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upgrading revokes previously logged local links, redacts old records and preserves fresh bookmarks on restart', async () => {
  const userData = temporary();
  const file = path.join(userData, 'pages.json'), log = path.join(userData, 'shell.jsonl');
  const old = { shell: token(), desktop: token(), keys: token(), 'app:notes': token() };
  fs.writeFileSync(file, JSON.stringify(old));
  const opened = { at: '2026-01-01', app: 'desktop', opened: `http://localhost:8000/${old.desktop}/`, device: 'paired-device' };
  const started = { app: 'notes', started: 'node', port: 8001 };
  fs.writeFileSync(log, [JSON.stringify(opened), JSON.stringify(started), JSON.stringify(opened).slice(0, -3)].join('\n'));
  let app: App | undefined;
  try {
    const options = { userData, home: userData, port: 18740, tailscale: null };
    app = await startApp(options);
    assert.equal((await fetch(new URL('/' + old.desktop + '/', app.desktop.url))).status, 404);
    assert.equal((await fetch(app.desktop.url)).status, 200);
    assert.equal(keptToken(file, 'keys'), old.keys);
    const nextNote = keptToken(file, 'app:notes'); // also revoked when the old log was previously rotated
    assert.notEqual(nextNote, old['app:notes']);
    const nextDesktop = keptToken(file, 'desktop');
    const cleaned = fs.readFileSync(log, 'utf8');
    assert.ok(!cleaned.includes(old.desktop));
    assert.deepEqual(cleaned.trim().split('\n').slice(0, 2).map(line => JSON.parse(line)), [{ ...opened, opened: true }, started]);
    if (process.platform !== 'win32') for (const f of [file, log]) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    await app.close();
    app = undefined;
    app = await startApp(options);
    assert.equal(keptToken(file, 'desktop'), nextDesktop);
    assert.equal(keptToken(file, 'app:notes'), nextNote);
  } finally { await app?.close(); fs.rmSync(userData, { recursive: true, force: true }); }
});
