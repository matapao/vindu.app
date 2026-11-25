// The app's pages listen on this computer's loopback alone: Desktop's page and the keys page answer at 127.0.0.1, by
// this computer's own names, with their token, and at none of the computer's addresses on any other network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { startApp, type App } from '../src/app.js';

let app: App, directory: string, keys: string;
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-loopback-'));
  app = await startApp({ userData: directory, home: directory, port: 17740 });
  keys = await app.openKeys();
});
afterAll(async () => {
  await app?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

/** Whether a connection opens at that address and port. */
const opens = (host: string, port: number) => new Promise<boolean>(resolve => {
  const socket = net.connect({ host, port });
  socket.setTimeout(2000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
});
/** What a page server answers at 127.0.0.1 for that path, asked by that name. */
const status = (port: number, pathname: string, host: string) => new Promise<number>((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname, headers: { host } }, res => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
});

test('Desktop and the keys page answer at 127.0.0.1, and at none of this computer\'s other addresses', async () => {
  const others = Object.values(os.networkInterfaces()).flat().flatMap(a => (a && !a.internal ? [a.address] : []));
  for (const url of [app.url, keys]) {
    const port = Number(new URL(url).port);
    assert.ok(await opens('127.0.0.1', port), `port ${port} on 127.0.0.1`);
    assert.equal(await opens('::1', port), false, `port ${port} on ::1`);
    for (const address of others) assert.equal(await opens(address, port), false, `port ${port} on ${address}`);
  }
});

test('a page answers by this computer\'s own names with its token, and nothing else', async () => {
  const { port, pathname } = new URL(app.url);
  assert.equal(await status(Number(port), pathname, `127.0.0.1:${port}`), 200);
  assert.equal(await status(Number(port), pathname, `localhost:${port}`), 200);
  assert.equal(await status(Number(port), pathname, `vindu.example.test:${port}`), 421);
  for (const other of ['/', '/pair', '/not-the-token/']) assert.equal(await status(Number(port), other, `127.0.0.1:${port}`), 404, other);
});
