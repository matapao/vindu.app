// The core's network side (network.ts), with a Tailscale of the test's own (its command line, which changes nothing) and a
// push service of its own: the core serves its pages on the tailnet only once the person turns it on, each at its own
// port and the keys page never, and takes them back; a device pairs by a code made on this computer, and opens Desktop
// at its own token, never in a cookie, where no page may frame it; what needs the person reaches the device as a
// notification encrypted for it alone (RFC 8291),
// signed with the core's own keys (VAPID). Synthetic only.
import { afterAll, beforeAll, test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { connectSyntheticProcessor, processors } from './synthetic-processor.js';
import http from 'node:http';
import https from 'node:https';
import { makeLanIdentity, wifiName } from './lan-identity.js';
import os from 'node:os';
import path from 'node:path';
import { startApp, type App } from '../src/app.js';
import { encrypt, pushServiceAllowed, subscriptionOf, vapid } from '../src/push.js';
import { devices } from '../src/devices.js';
import { servedPorts, tailnetOf } from '../src/tailnet.js';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const HOST = 'mac.tail1234.ts.net';

/** A device's browser, as far as push goes: its keys, and what it reads of a message encrypted for it. */
function deviceKeys() {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const open = (body: Buffer) => { // RFC 8291, as the browser does it
    const salt = body.subarray(0, 16), idlen = body[20], as = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
    const h = (ikm: Buffer, s: Buffer, info: Buffer, n: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
    const ikm = h(ecdh.computeSecret(as), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), as]), 32);
    const d = crypto.createDecipheriv('aes-128-gcm', h(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16), h(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
    assert.equal(plain[plain.length - 1], 2); // one record, the last
    return plain.subarray(0, plain.length - 1).toString('utf8');
  };
  return { sub, open };
}
/** The core's signature, as a push service checks it: its key, its audience, and when it ends. */
function checkVapid(header: string, endpoint: string, publicKey: string) {
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
  assert.equal(k, publicKey);
  const [h, p, sig] = jwt.split('.');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(k, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(k, 'base64url').subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as { aud: string; exp: number; sub: string };
  assert.equal(claims.aud, new URL(endpoint).origin); assert.ok(claims.exp > Date.now() / 1000);
  return claims;
}

test('a message for one device: encrypted so only it reads it, signed so its push service knows the core', () => {
  const d = deviceKeys();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const jwk = publicKey.export({ format: 'jwk' });
  const keys = { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url'), privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
  assert.equal(d.open(encrypt(d.sub, Buffer.from('{"title":"Desktop","body":"A task is waiting for you"}'))), '{"title":"Desktop","body":"A task is waiting for you"}');
  assert.equal(checkVapid(vapid(d.sub.endpoint, keys, `https://${HOST}`), d.sub.endpoint, keys.publicKey).sub, `https://${HOST}`);
  assert.ok(pushServiceAllowed(d.sub.endpoint) && pushServiceAllowed('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(!pushServiceAllowed('https://127.0.0.1/x') && !pushServiceAllowed('http://web.push.apple.com/x') && !pushServiceAllowed('https://evil.example/x'));
  assert.deepEqual(subscriptionOf(d.sub), d.sub);
  assert.equal(subscriptionOf({ ...d.sub, keys: { ...d.sub.keys, auth: 'AAAA' } }), null);
});

test('pairing: a code made here pairs one device, five wrong tries end it, and a removed device opens nothing', () => {
  const dir = tmp('devices-'), all = devices(path.join(dir, 'devices.json'));
  assert.ok('error' in all.pair('123456', 'x'));                        // no code made
  const { code } = all.newCode();
  const ok = all.pair(code, 'My phone') as { token: string; id: string };
  assert.ok(ok.token && all.of(ok.token)?.name === 'My phone');
  assert.ok(!fs.readFileSync(path.join(dir, 'devices.json'), 'utf8').includes(ok.token)); // only its hash is kept
  assert.ok('error' in all.pair(code, 'Another'));                      // one code, one device
  const second = all.newCode().code, wrong = second === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) assert.match((all.pair(wrong, 'x') as { error: string }).error, /not the code/);
  assert.match((all.pair(wrong, 'x') as { error: string }).error, /last try/);
  assert.ok('error' in all.pair(second, 'x'));                          // ended
  all.remove(ok.id); assert.equal(all.of(ok.token), undefined);
});

test('what Tailscale says: its step, its name, and what it serves', () => {
  assert.deepEqual(tailnetOf('not json'), { step: 'signin' });
  assert.deepEqual(tailnetOf(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [] })), { step: 'https', host: HOST });
  assert.deepEqual(tailnetOf(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${HOST}.` }, CertDomains: [HOST] })), { step: 'ready', host: HOST });
  const served = servedPorts(JSON.stringify({ TCP: { 7300: { HTTPS: true }, 443: { HTTPS: true } }, Web: { [`${HOST}:7300`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7300' } } }, [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, AllowFunnel: { [`${HOST}:443`]: true } }), HOST);
  assert.deepEqual(served.get(7300), { to: 7300, funnel: false }); assert.deepEqual(served.get(443), { to: 3000, funnel: true });
});

// the core, with Tailscale's command line of the test's own and a push service of its own
let a: App, calls: string, pushed: { endpoint: string; headers: Record<string, string>; body: Buffer }[];
beforeAll(async () => {
  const dir = tmp('tailscale-'); calls = path.join(dir, 'calls.jsonl');
  const cli = path.join(dir, 'tailscale');
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'); const state = ${JSON.stringify(path.join(dir, 'served.json'))}; const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + '\\n');
const served = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : [];
if (a[0] === 'status') { console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: '${HOST}.' }, CertDomains: ['${HOST}'] })); process.exit(0); }
if (a[0] === 'serve' && a[1] === 'status') { console.log(JSON.stringify({ TCP: Object.fromEntries(served.map(p => [p, { HTTPS: true }])), Web: Object.fromEntries(served.map(p => ['${HOST}:' + p, { Handlers: { '/': { Proxy: 'http://127.0.0.1:' + p } } }])) })); process.exit(0); }
const port = Number((a.find(x => x.startsWith('--https=')) || '').slice(8));
if (a[0] === 'serve' && a.includes('--bg')) { fs.writeFileSync(state, JSON.stringify([...served, port])); process.exit(0); }
if (a[0] === 'serve' && a.at(-1) === 'off') { fs.writeFileSync(state, JSON.stringify(served.filter(p => p !== port))); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  pushed = [];
  a = await startApp({ userData: tmp('network-data-'), port: 17700, home: tmp('network-home-'), tailscale: cli,
    push: { allowed: () => true, fetch: (async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => { pushed.push({ endpoint: url, headers: init.headers, body: Buffer.from(init.body) }); return new Response(null, { status: 201 }); }) as unknown as typeof fetch },
    processors, connect: connectSyntheticProcessor });
});
afterAll(async () => { await a?.close(); });

/** A request to one of the core's pages, as it comes through Tailscale's proxy: at the tailnet's name. */
const asTailnet = (port: number, pathname: string, o: { method?: string; body?: string; origin?: string } = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((ok, no) => {
  const r = http.request({ host: '127.0.0.1', port, path: pathname, method: o.method ?? 'GET', headers: { host: `${HOST}:${port}`, ...(o.origin ? { origin: o.origin } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}) } }, res => {
    let body = ''; res.setEncoding('utf8'); res.on('data', d => { body += d; }); res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
  });
  r.on('error', no); if (o.body) r.write(o.body); r.end();
});
/** Desktop's socket, as a page would open it, from where it is (its Host and Origin): the calls it answers. at: the
 *  address it connects to (this computer's loopback, or the Wi-Fi's forwarder's). */
async function socketAs(port: number, pathname: string, host: string, origin: string, at = '127.0.0.1', tls?: ReturnType<typeof makeLanIdentity>) {
  const sock = await new Promise<import('node:net').Socket>((ok, no) => {
    const r = (tls ? https : http).request({ host: at, port, path: pathname, ...tls, headers: { host, origin, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64') } });
    r.on('upgrade', (_res, s) => ok(s)); r.on('response', res => no(new Error(`the socket was refused: ${res.statusCode}`))); r.on('error', no); r.end();
  });
  const send = (text: string) => { // a page's frames are masked
    const data = Buffer.from(text), mask = crypto.randomBytes(4), n = data.length;
    const head = n < 126 ? Buffer.from([0x81, 0x80 | n]) : Buffer.from([0x81, 0x80 | 126, n >> 8, n & 255]);
    sock.write(Buffer.concat([head, mask, Buffer.from(data.map((b, i) => b ^ mask[i & 3]))]));
  };
  let buf = Buffer.alloc(0), n = 0; const waiting = new Map<number, (m: { v?: unknown; e?: string }) => void>();
  const events: { ch: string; a: unknown[] }[] = []; // what the core told the page, as it came
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return; let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (buf.length < at + len) return;
      const op = buf[0] & 0x0f, text = buf.subarray(at, at + len).toString('utf8'); buf = buf.subarray(at + len);
      if (op !== 1) continue;
      const m = JSON.parse(text) as { t: string; id: number; v?: unknown; e?: string; ch?: string; a?: unknown[] }; if (m.t === 'reply') waiting.get(m.id)?.(m);
      if (m.t === 'ev') events.push({ ch: String(m.ch), a: m.a ?? [] });
    }
  });
  const closed = new Promise<void>(resolve => sock.once('close', () => resolve()));
  return { closed, call: (ch: string, ...args: unknown[]) => new Promise<unknown>((ok, no) => { const id = ++n; waiting.set(id, m => (m.e ? no(new Error(m.e)) : ok(m.v))); send(JSON.stringify({ t: 'call', id, ch, a: args })); }), close: () => sock.destroy(), events };
}

test('the core goes on the tailnet only when the person turns it on: Desktop at its port, the keys page never, and back off', async () => {
  const deskPort = a.desktop.port, token = a.desktop.token;
  assert.equal((await asTailnet(deskPort, `/${token}/`)).status, 421); // not served: the tailnet's name opens nothing
  assert.ok(!fs.existsSync(calls) || !fs.readFileSync(calls, 'utf8').includes('--bg'));
  const here = await socketAs(deskPort, `/${token}/socket`, `127.0.0.1:${deskPort}`, `http://127.0.0.1:${deskPort}`);
  const r = await here.call('settings:phone-serve', true) as { ok: boolean; state: { serving: boolean; address: string } };
  assert.ok(r.ok && r.state.serving); assert.equal(r.state.address, `https://${HOST}:${deskPort}`);
  const served = fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]).filter(c => c.includes('--bg'));
  assert.deepEqual(served, [['serve', '--bg', `--https=${deskPort}`, `http://127.0.0.1:${deskPort}`]]);
  assert.ok(!fs.readFileSync(calls, 'utf8').includes('funnel'));
  assert.equal((await asTailnet(deskPort, `/${token}/`)).status, 404); // its name is served now, but only a paired device's token opens anything there
  // a device pairs by the code made here, and opens Desktop at its own token
  const { code } = await here.call('settings:phone-code') as { code: string };
  assert.equal((await asTailnet(deskPort, '/pair', { method: 'POST', origin: 'https://evil.example', body: JSON.stringify({ code, name: 'x' }) })).status, 403);
  const paired = await asTailnet(deskPort, '/pair', { method: 'POST', origin: `https://${HOST}:${deskPort}`, body: JSON.stringify({ code, name: 'My phone' }) });
  assert.equal(paired.status, 200);
  const at = (JSON.parse(paired.body) as { url: string }).url; assert.match(at, /^\/[\w-]{20,}\/$/);
  assert.equal(paired.headers['set-cookie'], undefined); // never in a cookie
  const page = await asTailnet(deskPort, at); assert.equal(page.status, 200);
  assert.match(String(page.headers['content-security-policy']), new RegExp(`frame-src [^;]*https://${HOST.replace(/\./g, '\\.')}:\\*`));
  const phone = await socketAs(deskPort, `${at}socket`, `${HOST}:${deskPort}`, `https://${HOST}:${deskPort}`);
  assert.equal(((await phone.call('settings:state')) as { device: string }).device.length > 0, true);
  await assert.rejects(phone.call('settings:phone-code'), /set up on the computer/); // a device makes no codes
  await assert.rejects(phone.call('pty:new', 'unopened'), /set up on the computer/);
  await assert.rejects(phone.call('task:create', { id: 'new', harness: 'claude', folder: 'unpicked' }), /Choose the working folder/);
  // what Vindu may use is set here, or on an owner device: not on this one, whatever its page shows or calls
  assert.equal(((await phone.call('settings:state')) as { setsUp: boolean }).setsUp, false);
  for (const [ch, ...args] of [['settings:processors'], ['settings:grant', 'codex', true], ['settings:budget'], ['settings:set-budget', { tokens: 1 }]] as [string, ...unknown[]][])
    await assert.rejects(phone.call(ch, ...args), /set on the computer vindu runs on, or on a device paired as its owner/, ch);
  // an owner's code, made here, pairs one that may: it sets Processors as this computer does, and is listed as an owner
  const owner = await here.call('settings:phone-code', { owner: true }) as { code: string; owner: boolean };
  assert.equal(owner.owner, true);
  const laptopAt = (JSON.parse((await asTailnet(deskPort, '/pair', { method: 'POST', origin: `https://${HOST}:${deskPort}`, body: JSON.stringify({ code: owner.code, name: 'My laptop' }) })).body) as { url: string }).url;
  const laptop = await socketAs(deskPort, `${laptopAt}socket`, `${HOST}:${deskPort}`, `https://${HOST}:${deskPort}`);
  assert.equal(((await laptop.call('settings:state')) as { setsUp: boolean }).setsUp, true);
  assert.ok(((await laptop.call('settings:grant', 'codex', false)) as string[]).every(g => g !== 'codex'));
  assert.equal(typeof ((await laptop.call('settings:budget')) as { limits: unknown }).limits, 'object');
  await assert.rejects(laptop.call('settings:phone-code'), /set up on the computer/); // an owner sets Processors, not who else pairs
  await laptop.call('settings:grant', 'codex', true);
  const listed = ((await here.call('settings:phone')) as { devices: { id: string; name: string; owner?: boolean }[] }).devices;
  assert.deepEqual(listed.map(d => [d.name, !!d.owner]), [['My phone', false], ['My laptop', true]]);
  await here.call('settings:phone-remove', listed[1].id);
  await laptop.closed;
  assert.equal(((await phone.call('settings:state')) as { device: string }).device, listed[0].id);

  // Desktop's page lets no page frame it, here or on the tailnet; the keys page is never on the tailnet
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  const keys = new URL(await a.openKeys());
  assert.equal((await asTailnet(Number(keys.port), keys.pathname)).status, 421); // never on the tailnet
  // its notifications: a subscription of its own, and a notice here when the person is not looking reaches it
  const d = deviceKeys();
  assert.equal(await phone.call('settings:push', d.sub), true);
  a.notify('no-task', { what: 'Call the bank', state: 'due' } as never);
  await new Promise(r => setTimeout(r, 300));
  const p = pushed.at(-1)!;
  assert.equal(p.endpoint, d.sub.endpoint); assert.equal(p.headers['Content-Encoding'], 'aes128gcm');
  checkVapid(p.headers.Authorization, d.sub.endpoint, ((await here.call('settings:phone')) as { push: { key: string } }).push.key);
  assert.deepEqual(JSON.parse(d.open(p.body)), { title: 'Reminder', body: 'Call the bank', tag: 'desktop:no-task' });
  // removed, the device opens nothing; and the core comes off the tailnet when the person says
  const id = ((await here.call('settings:phone')) as { devices: { id: string }[] }).devices[0].id;
  await here.call('settings:phone-remove', id);
  await phone.closed;
  assert.equal((await asTailnet(deskPort, at)).status, 404); // removed: every page of the core's closed to it
  const off = await here.call('settings:phone-serve', false) as { state: { serving: boolean } };
  assert.equal(off.state.serving, false);
  const offs = fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]).filter(c => c.at(-1) === 'off');
  assert.deepEqual(offs.map(c => c[1]), [`--https=${deskPort}`]);
  assert.equal((await asTailnet(deskPort, `/${token}/`)).status, 421);
  here.close(); phone.close();
});

test('a desktop app on another computer, paired, gives the core its link: a page the person opens lives in that app', async () => {
  const deskPort = a.desktop.port;
  const here = await socketAs(deskPort, `/${a.desktop.token}/socket`, `127.0.0.1:${deskPort}`, `http://127.0.0.1:${deskPort}`);
  const { code } = await here.call('settings:phone-code') as { code: string };
  const paired = JSON.parse((await new Promise<string>((ok, no) => { // pairing, as the app does it, at this computer's own name in a test
    const r = http.request({ host: '127.0.0.1', port: deskPort, path: '/pair', method: 'POST', headers: { host: `localhost:${deskPort}`, origin: `http://localhost:${deskPort}`, 'content-type': 'application/json' } }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => ok(b)); });
    r.on('error', no); r.end(JSON.stringify({ code, name: 'The laptop' }));
  }))) as { url: string };
  const device = paired.url.split('/')[1];
  // the other computer's app: its link at its own token, its window, and what the core asks of it
  const asked: { m: string; partition?: string }[] = [];
  const link = await new Promise<import('node:net').Socket>((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port: deskPort, path: `/${device}/frame`, headers: { host: `localhost:${deskPort}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64') } });
    r.on('upgrade', (_res, s) => ok(s)); r.on('response', res => no(new Error(`refused: ${res.statusCode}`))); r.on('error', no); r.end();
  });
  const out = (m: unknown) => { const data = Buffer.from(JSON.stringify(m)), mask = crypto.randomBytes(4), n = data.length; link.write(Buffer.concat([n < 126 ? Buffer.from([0x81, 0x80 | n]) : Buffer.from([0x81, 0x80 | 126, n >> 8, n & 255]), mask, Buffer.from(data.map((b, i) => b ^ mask[i & 3]))])); };
  let buf = Buffer.alloc(0);
  link.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return; let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      if (buf.length < at + len) return;
      const op = buf[0] & 0x0f, text = buf.subarray(at, at + len).toString('utf8'); buf = buf.subarray(at + len); if (op !== 1) continue;
      const m = JSON.parse(text) as { id: number; m: string; partition?: string; method?: string };
      asked.push({ m: m.m, ...(m.partition ? { partition: m.partition } : {}) });
      out({ id: m.id, result: m.m === 'open' ? { view: 'v1' } : m.m === 'info' ? { title: 'Blank' } : {} });
    }
  });
  out({ ev: 'windows', keys: ['laptop-window-1'] });
  // a task, and the person's own page in it, from Desktop's page
  const desk = here;
  const t = await desk.call('task:create', { id: 'remote-1', harness: 'claude', title: 'A page elsewhere' }) as { id: string };
  void desk.call('browser:new', t.id, 'about:blank').catch(() => undefined); // the page's own loading is the app's: here, where it opens
  const end = Date.now() + 5000; while (!asked.some(x => x.m === 'cdp') && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(asked.find(x => x.m === 'open'), { m: 'open', partition: 'persist:vindu-person' }); // in the other computer's app, the person's own session there
  assert.ok(asked.some(x => x.m === 'cdp'), 'driven over the DevTools protocol, through the link');
  link.destroy(); // the other computer's app goes: what was open there is gone with it
  await Promise.race([desk.call('task:close', t.id), new Promise(r => setTimeout(r, 3000))]);
  here.close();
});

/** A request through the TLS forwarder on the test Wi-Fi or directly to the local backend. */
const wifiRequests = (tls: ReturnType<typeof makeLanIdentity> | undefined) => (at: string, port: number, pathname: string, o: { host?: string; method?: string; body?: string; origin?: string; cookie?: string } = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((ok, no) => {
    const wifi = at === '::1';
    const r = (wifi ? https : http).request({ ...(wifi ? tls : {}), host: at, port, path: pathname, method: o.method ?? 'GET', headers: { host: o.host ?? `${wifiName}:${port}`, ...(o.origin ? { origin: o.origin } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', d => { body += d; }); res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', no); if (o.body) r.write(o.body); r.end();
  });

test('on the Wi-Fi, once on there: each page at its own port over HTTPS, a paired device alone, the keys page never, and off again', async () => {
  // a core of its own, whose Wi-Fi is this computer's IPv6 loopback, so nothing opens on the real network
  const WIFI = wifiName, A = '::1', userData = tmp('lan-data-');
  let tls: ReturnType<typeof makeLanIdentity> | undefined;
  const w = await startApp({ userData, port: 17800, home: tmp('lan-home-'), tailscale: null, lanAddresses: () => [A], lanName: WIFI,
    processors, connect: connectSyntheticProcessor });
  const deskPort = w.desktop.port, token = w.desktop.token;
  let ask = wifiRequests(tls);
  /** The person's own command here, as main.ts gives it: Desktop's token, this computer's name, no page's origin. */
  const control = async (q: Record<string, unknown>) => JSON.parse((await ask('127.0.0.1', deskPort, `/${token}/control`, { host: `127.0.0.1:${deskPort}`, method: 'POST', body: JSON.stringify(q) })).body) as Record<string, any>;
  const refused = (port: number) => ask(A, port, '/').then(() => false, (e: NodeJS.ErrnoException) => e.code === 'ECONNREFUSED');
  try {
    // off, by default (a Mac's core): nothing listens on the Wi-Fi, and its name opens nothing here
    assert.ok(await refused(deskPort));
    assert.equal((await ask('127.0.0.1', deskPort, `/${token}/`)).status, 421);
    assert.match(String((await control({ do: 'lan', on: true })).error), /TLS certificate/);
    assert.ok(await refused(deskPort));
    assert.equal((await ask('127.0.0.1', deskPort, `/${token}/`, { host: `127.0.0.1:${deskPort}` })).status, 200);
    tls = makeLanIdentity(userData);
    ask = wifiRequests(tls);
    const on = await control({ do: 'lan', on: true });
    assert.equal(on.ok, true);
    assert.equal(on.state.lan.address, `https://${WIFI}:${deskPort}`);
    // An old HTTP link cannot send a request through this listener. Exercise it without any credentials.
    await assert.rejects(new Promise((ok, no) => http.get({ host: A, port: deskPort, path: '/pair' }, ok).on('error', no)));
    assert.equal((await ask(A, deskPort, '*')).status, 400);
    await assert.rejects(socketAs(deskPort, '*', `${WIFI}:${deskPort}`, `https://${WIFI}:${deskPort}`, A, tls), /400/);
    // through the forwarder: by the Wi-Fi's names alone, and the core's own token never; localhost's name turned away
    assert.equal((await ask(A, deskPort, `/${token}/`)).status, 404);
    assert.equal((await ask(A, deskPort, `/${token}/`, { host: `localhost:${deskPort}` })).status, 421);
    assert.equal((await ask(A, deskPort, `/${token}/`, { host: `127.0.0.1:${deskPort}` })).status, 421);
    assert.equal((await ask(A, deskPort, '/pair', { host: `[${A}]:${deskPort}` })).status, 200); // its address is one of its names there
    // a device pairs by a code made here, from the pairing page's own origin (HTTPS, at the Wi-Fi's name)
    const made = await control({ do: 'code' });
    assert.equal(made.lanAt, `https://${WIFI}:${deskPort}/pair`); assert.equal(made.at, null);
    assert.equal((await ask(A, deskPort, '/pair', { method: 'POST', origin: `http://${WIFI}:${deskPort}`, body: JSON.stringify({ code: made.code, name: 'x' }) })).status, 403);
    const paired = await ask(A, deskPort, '/pair', { method: 'POST', origin: `https://${WIFI}:${deskPort}`, body: JSON.stringify({ code: made.code, name: 'The phone' }) });
    assert.equal(paired.status, 200);
    const at = (JSON.parse(paired.body) as { url: string }).url;
    const page = await ask(A, deskPort, at); assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), new RegExp(`frame-src [^;]*https://${WIFI.replace(/\./g, '\\.')}:\\*`));
    assert.match(String(page.headers['content-security-policy']), new RegExp(`connect-src [^;]*wss://${WIFI.replace(/\./g, '\\.')}:${deskPort}`));
    // its socket, through the forwarder: from another device, so it sets nothing up
    await assert.rejects(socketAs(deskPort, `${at}socket`, `${WIFI}:${deskPort}`, `http://evil.example`, A, tls));
    const phone = await socketAs(deskPort, `${at}socket`, `${WIFI}:${deskPort}`, `https://${WIFI}:${deskPort}`, A, tls);
    const s = await phone.call('settings:state') as { away: boolean; setsUp: boolean; device: string };
    assert.equal(s.away, true); assert.equal(s.setsUp, false); assert.ok(s.device);
    await assert.rejects(phone.call('settings:phone-code'), /set up on the computer/);
    await assert.rejects(phone.call('settings:processors'), /set on the computer vindu runs on, or on a device paired as its owner/);
    // Desktop's page, at the device's token, which no page may frame; its own token opens nothing there
    assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal((await ask(A, deskPort, `/${w.desktop.token}/`)).status, 404);
    // the keys page is on no network: nothing listens for it on the Wi-Fi
    assert.ok(await refused(Number(new URL(await w.openKeys()).port)));
    phone.close();
    // off again: the forwarder gone, and the Wi-Fi's name opens nothing here
    const off = await control({ do: 'lan', on: false });
    assert.equal(off.state.lan.on, false);
    assert.ok(await refused(deskPort));
    assert.equal((await ask('127.0.0.1', deskPort, at)).status, 421);
  } finally { await w.close(); }
});

test("on the Wi-Fi, a task's page reaches a paired device through a door of its own, and a computer with no browser shows it unchecked", async () => {
  // as above, a core whose Wi-Fi is this computer's IPv6 loopback; and, as a Pi 3's core, no browser to check pages in
  const WIFI = wifiName, A = '::1', userData = tmp('doors-data-');
  const tls = makeLanIdentity(userData);
  const w = await startApp({ userData, port: 17820, home: tmp('doors-home-'), tailscale: null, lanAddresses: () => [A], lanName: WIFI,
    pageBrowser: () => Promise.reject(new Error("browserType.launch: Executable doesn't exist at /nowhere/headless_shell")),
    processors, connect: connectSyntheticProcessor });
  const deskPort = w.desktop.port, token = w.desktop.token;
  const ask = wifiRequests(tls);
  const control = async (q: Record<string, unknown>) => JSON.parse((await ask('127.0.0.1', deskPort, `/${token}/control`, { host: `127.0.0.1:${deskPort}`, method: 'POST', body: JSON.stringify(q) })).body) as Record<string, any>;
  const until = async (f: () => boolean | Promise<boolean>, what: string) => { const end = Date.now() + 10_000; while (!(await f())) { if (Date.now() > end) throw new Error(`waited for ${what}`); await new Promise(r => setTimeout(r, 50)); } };
  const findFile = (dir: string, name: string): string | undefined => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isFile() && e.name === name) return p; if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; } }
    return undefined;
  };
  try {
    await control({ do: 'lan', on: true });
    const made = await control({ do: 'code' });
    const paired = await ask(A, deskPort, '/pair', { method: 'POST', origin: `https://${WIFI}:${deskPort}`, body: JSON.stringify({ code: made.code, name: 'The phone' }) });
    const at = (JSON.parse(paired.body) as { url: string }).url;
    // Desktop's page on the phone may frame, and show, what comes from the core's names on the Wi-Fi
    const deskThere = await ask(A, deskPort, at);
    for (const d of ['frame-src', 'img-src', 'media-src']) assert.match(String(deskThere.headers['content-security-policy']), new RegExp(`${d} [^;]*https://${WIFI.replace(/\./g, '\\.')}:\\*`));
    // Desktop's page here, and on the phone (through the Wi-Fi's forwarder)
    const here = await socketAs(deskPort, `/${w.desktop.token}/socket`, `127.0.0.1:${deskPort}`, `http://127.0.0.1:${deskPort}`);
    const phone = await socketAs(deskPort, `${at}socket`, `${WIFI}:${deskPort}`, `https://${WIFI}:${deskPort}`, A, tls);
    await here.call('task:create', { id: 'pages-1', harness: 'claude', title: 'A page' });
    await here.call('task:prompt', 'pages-1', '[echo] a page that sends');
    // shown, though nothing here could check it, and the model is told why
    const calls = fs.readFileSync(findFile(userData, 'ui-calls.jsonl')!, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { tool: string; ok: boolean; account?: { panels: { page?: unknown }[] } });
    const shown = calls.find(c => c.tool === 'show_view');
    assert.equal(shown?.ok, true);
    assert.equal(shown?.account?.panels[0].page, "not checked: this computer has no browser to check pages in (Playwright's Chromium is not installed here)");
    // here, the page at Vindu's own address; on the phone, at its door on the Wi-Fi, with the phone's key to it
    const page = (s: { events: { ch: string; a: unknown[] }[] }, re: RegExp) => s.events.filter(e => e.ch === 'view' && e.a[0] === 'pages-1').map(e => re.exec(JSON.stringify(e.a))?.[0]).find(Boolean);
    const THERE = /https:\/\/testbox\.local:\d+\/view\/[^"]+/;
    await until(() => !!page(phone, THERE), 'the view on the phone');
    assert.ok(page(here, /http:\/\/[a-f0-9]{32}\.localhost:\d+\/view\/[^"]+/), 'here, as vindu serves it');
    assert.equal(page(here, THERE), undefined);
    const told = new URL(page(phone, THERE)!), door = Number(told.port);
    assert.ok(told.searchParams.get('vindu-door'));
    // at the door, through the Wi-Fi's forwarder: the key once, kept in a cookie, then the page itself; nothing without it
    const entry = await ask(A, door, `${told.pathname}${told.search}`);
    assert.equal(entry.status, 302);
    assert.match(String(entry.headers['set-cookie']), /; Secure$/);
    const cookie = String(entry.headers['set-cookie']).split(';')[0];
    const there = await ask(A, door, String(entry.headers.location), { cookie });
    assert.equal(there.status, 200); assert.match(there.body, /<title>Run<\/title>/);
    assert.equal((await ask(A, door, String(entry.headers.location))).status, 403);
    // the task closed: its door with it, on the Wi-Fi too
    await here.call('task:close', 'pages-1');
    await until(() => ask(A, door, '/', { cookie }).then(() => false, (e: NodeJS.ErrnoException) => e.code === 'ECONNREFUSED'), 'the door to close');
    here.close(); phone.close();
  } finally { await w.close(); }
});
