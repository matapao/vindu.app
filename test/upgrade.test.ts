import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { processors } from './consumer.js';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    assert.deepEqual(new URL(app.shell.url).pathname, '/' + old.shell + '/');
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

test('unbound legacy grants and storage require the owner to confirm each exact app and folder', async () => {
  const userData = temporary();
  const installed = ['reports', 'notes', 'new-app'].map(id => {
    const folder = path.join(userData, id);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'app.json'), JSON.stringify({ id, name: id, asks: ['processors', 'storage'], serve: { command: 'node' } }));
    return folder;
  });
  const [reports, notes] = installed;
  const storage = path.join(userData, 'apps', 'notes', 'storage');
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, 'saved.txt'), 'saved by the original app');
  const database = path.join(userData, 'celler');
  fs.mkdirSync(database);
  const db = new DatabaseSync(path.join(database, 'runs.sqlite'));
  try {
    db.exec('CREATE TABLE vindu_apps (id TEXT PRIMARY KEY, grants TEXT NOT NULL, budget TEXT NOT NULL)');
    db.prepare('INSERT INTO vindu_apps VALUES (?,?,?)').run('reports', '["codex"]', '{"tokens":100,"cost":0,"minutes":0}');
  } finally { db.close(); }
  const configure = (restoreFolderAccess: Record<string, string>) => fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ installed, restoreFolderAccess }));
  let app: App | undefined;
  try {
    configure({ reports: notes });
    const options = { userData, home: userData, port: 18744, processors, tailscale: null };
    app = await startApp(options);
    const ids = () => app!.shell.apps().map(a => a.id);
    assert.deepEqual(ids(), ['desktop', 'new-app']);
    assert.deepEqual(app.appAccess('reports'), {});
    assert.deepEqual(app.appAccess('notes'), {});
    configure({ reports, notes });
    assert.deepEqual(ids(), ['desktop', 'reports', 'notes', 'new-app']);
    assert.deepEqual(app.celler.grants('reports'), ['codex']);
    assert.equal(app.celler.budget('reports').tokens, 100);
    const credentials = app.appAccess('notes');
    const access = await (await fetch(credentials.CELLER_URL + '/access', { headers: { authorization: 'Bearer ' + credentials.CELLER_TOKEN } })).json();
    assert.equal(fs.readFileSync(path.join(access.storage, 'saved.txt'), 'utf8'), 'saved by the original app');
    configure({});
    await app.close();
    app = undefined;
    app = await startApp(options);
    assert.deepEqual(ids(), ['desktop', 'reports', 'notes', 'new-app']);
    assert.deepEqual(app.celler.grants('reports'), ['codex']);
  } finally { await app?.close(); fs.rmSync(userData, { recursive: true, force: true }); }
});
