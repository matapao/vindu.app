// Vindu's pages on the person's other devices (page-doors.ts), against a stand-in for Vindu's page host: a door per
// origin, told to a device elsewhere by the name it came by, opened by that device's key alone (kept in a cookie, never
// sent on), handing each request to vindu as the task's origin, and closed with the task. Synthetic only.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pageDoors } from '../src/page-doors.js';

/** Vindu's page host, as far as a door sees it: what it was asked, by which name. */
async function standIn() {
  const seen: { host?: string; url?: string; cookie?: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url, cookie: req.headers.cookie });
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Security-Policy': "default-src 'self'", 'Set-Cookie': 'session=page-host' }).end(`page at ${req.headers.host}${req.url}`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, seen, close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }) };
}
const ask = (port: number, pathname: string, o: { host: string; cookie?: string; method?: string }) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, path: pathname, method: o.method ?? 'GET', agent: false, headers: { host: o.host, ...(o.cookie ? { cookie: o.cookie } : {}) } }, res => {
    let body = ''; res.setEncoding('utf8'); res.on('data', d => { body += d; }); res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
  });
  r.on('error', no); r.end();
});

test('a door per origin: told to a device elsewhere, opened by its key alone, to vindu as that origin, closed with its task', async () => {
  const host = await standIn();
  let devices = ['d1'], changes = 0;
  const doors = pageDoors({ hostPort: host.port, devices: () => devices, names: () => ['mini.tail1234.ts.net'], lan: () => ['mini.local'], changed: async () => { changes++; } });
  const key = 'a'.repeat(32), origin = `http://${key}.localhost:${host.port}`;
  try {
    const view = { name: 'v', panels: [{ url: `${origin}/view/a.html?v=2#top` }, { url: `${origin}/media/a1` }], near: `${origin}x`, other: 'http://b.localhost:1/view/x.html', words: 'as they are', n: 3 };
    // a device on the Wi-Fi: each of Vindu's addresses at its origin's door, by the name the device came by, with its key
    const told = await doors.through({ host: 'mini.local:7301', secure: true, device: 'd1' }, view) as typeof view;
    const [port] = doors.ports(); assert.ok(port); assert.equal(changes, 1, 'served before any device is told it');
    const m = /^https:\/\/mini\.local:(\d+)\/view\/a\.html\?v=2&vindu-door=([^#&]+)#top$/.exec(told.panels[0].url);
    assert.ok(m, told.panels[0].url); assert.equal(Number(m[1]), port);
    assert.match(told.panels[1].url, new RegExp(`^https://mini\\.local:${port}/media/a1\\?vindu-door=`));
    assert.equal(told.near, view.near); assert.equal(told.other, view.other); assert.equal(told.words, 'as they are'); assert.equal(told.n, 3);
    // on the tailnet: the same door, by https; one door per origin
    const tls = await doors.through({ host: 'mini.tail1234.ts.net:7301', secure: true, device: 'd1' }, view) as typeof view;
    assert.match(tls.panels[0].url, new RegExp(`^https://mini\\.tail1234\\.ts\\.net:${port}/view/a\\.html\\?v=2&vindu-door=`));
    assert.deepEqual(doors.ports(), [port]); assert.equal(changes, 1);
    // a page with no device (this computer's): as it is
    assert.equal(await doors.through({ host: 'localhost:7301', secure: false }, view), view);

    const k = decodeURIComponent(m[2]), wifi = `mini.local:${port}`;
    // the key, once: kept in a cookie for this name, and the page sent on without it
    const entry = await ask(port, `/view/a.html?v=2&vindu-door=${m[2]}`, { host: wifi });
    assert.equal(entry.status, 302); assert.equal(entry.headers.location, '/view/a.html?v=2');
    assert.match(String(entry.headers['set-cookie']), /^vindu-door-[a-f0-9]{32}=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
    assert.match(String((await ask(port, `/x?vindu-door=${m[2]}`, { host: `mini.tail1234.ts.net:${port}` })).headers['set-cookie']), /; Secure$/);
    // with it: on to vindu as the task's origin, the address as it was, and the key kept here
    const taskCookie = String(entry.headers['set-cookie']).split(';')[0];
    const page = await ask(port, '/view/a.html?v=2', { host: wifi, cookie: `other=1; ${taskCookie}` });
    assert.equal(page.status, 200); assert.equal(page.body, `page at ${key}.localhost:${host.port}/view/a.html?v=2`);
    assert.equal(host.seen.at(-1)?.cookie, undefined); assert.equal(page.headers['content-security-policy'], "default-src 'self'");
    assert.equal(page.headers['set-cookie'], undefined, 'no cookie of the page host reaches the device');
    // without it, with a key not made here, another device's, by this computer's own name, or by a name it has not: nothing
    assert.equal((await ask(port, '/view/a.html', { host: wifi })).status, 403);
    assert.equal((await ask(port, '/view/a.html', { host: wifi, cookie: `vindu-door-${key}=d1.${'x'.repeat(43)}` })).status, 403);
    assert.equal((await ask(port, `/view/a.html?vindu-door=d2.${k.split('.')[1]}`, { host: wifi })).status, 403);
    assert.equal((await ask(port, '/view/a.html', { host: `localhost:${port}`, cookie: taskCookie })).status, 421);
    assert.equal((await ask(port, '/view/a.html', { host: `127.0.0.1:${port}`, cookie: taskCookie })).status, 421);
    assert.equal((await ask(port, '/view/a.html', { host: `evil.example:${port}`, cookie: taskCookie })).status, 421);
    // the device removed: its key opens nothing
    devices = []; assert.equal((await ask(port, '/view/a.html', { host: wifi, cookie: taskCookie })).status, 403); devices = ['d1'];
    // the task closed: its door with it, and the core told
    doors.note('t1', view); await doors.release('t1');
    assert.deepEqual(doors.ports(), []); assert.equal(changes, 2);
    await assert.rejects(ask(port, '/view/a.html', { host: wifi, cookie: taskCookie }));
  } finally { doors.close(); await host.close(); }
});
