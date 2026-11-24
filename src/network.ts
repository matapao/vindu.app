// The core's network side, for the person's phone and their other devices: its pages on their private network over https
// (Tailscale's address, tailnet.ts), only once they turn it on (Phone, in Desktop's Settings), each page at its own port
// there as here, so each keeps an origin of its own; the keys page never. A device is paired by a code made on this
// computer (devices.ts) and opens Desktop at an address of its own token.
// What needs the person reaches their devices as notifications (Web Push, push.ts), with a few words: the
// rest comes over the private network when they open it. Nothing here is on the internet (never Funnel).
// Wi-Fi access uses the same pairing flow over HTTPS with a certificate the device trusts.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { readLanTls } from './lan-tls.js';
import { requestTarget } from './request-target.js';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { devices } from './devices.js';
import { pushKeys, sendPush, subscriptionOf, type PushResult } from './push.js';
import { runTailscale, serveArgs, serveOffArgs, servedPorts, tailnetOf, tailscaleCli, tailscaleLink, type Tailnet } from './tailnet.js';

export type NetworkSetup = {
  userData: string;
  /** The ports of the pages to serve on the tailnet: Desktop's first, then the doors to Vindu's pages of the tasks open
   *  (page-doors.ts). */
  ports: () => number[];
  /** Tailscale's command line: where its installers put it, by default (a test's own). */
  cli?: string | null;
  /** Where push messages go: the services browsers use, by default (a test's own). */
  push?: { fetch?: typeof fetch; allowed?: (endpoint: string) => boolean };
  log: (e: Record<string, unknown>) => void;
  revoked?: (device: string) => void;
  /** The tailnet's names changed (served, or not), or the Wi-Fi's: pages and apps take the new ones. */
  changed?: () => void;
  /** On the person's own Wi-Fi until they say otherwise (a Pi's core); off, by default. */
  lan?: boolean;
  /** This computer's addresses on the Wi-Fi: its network interfaces' own, by default (a test's own). */
  lanAddresses?: () => string[];
  /** This computer's name on the Wi-Fi: its hostname, as .local, by default (a test's own). */
  lanName?: string;
};
export type Network = ReturnType<typeof startNetwork>;
const PAIR = path.join(import.meta.dirname, '..', '..', 'static');

/** This computer's own addresses on the networks it is on: not its loopback, nor link-local ones, nor Tailscale's (its
 *  interface, 100.64.0.0/10, fd7a:115c:a1e0::/48), which the tailnet serves over https. */
export function lanAddresses(): string[] {
  const out = new Set<string>();
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^tailscale/i.test(name)) continue;
    for (const i of list ?? []) {
      if (i.internal) continue;
      if (i.family === 'IPv4' && !/^(169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(i.address)) out.add(i.address);
      if (i.family === 'IPv6' && !/^(fe80:|fd7a:115c:a1e0:)/i.test(i.address)) out.add(i.address.toLowerCase());
    }
  }
  return [...out];
}
/** An address as a request names it: an IPv6 one in brackets. */
const hostOf = (address: string) => (address.includes(':') ? `[${address}]` : address);

export function startNetwork(o: NetworkSetup) {
  const file = path.join(o.userData, 'network.json');
  const read = (): { serve?: boolean; host?: string; served?: number[]; lan?: boolean } => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as never; } catch { return {}; } };
  const write = (v: ReturnType<typeof read>) => { fs.mkdirSync(o.userData, { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`); };
  const cli = o.cli === undefined ? tailscaleCli() : o.cli;
  const paired = devices(path.join(o.userData, 'devices.json'), o.revoked);
  const keys = () => pushKeys(path.join(o.userData, 'push.json'));
  /** Where Tailscale is now. */
  const look = async (): Promise<Tailnet> => { if (!cli) return { step: 'install' }; const r = await runTailscale(cli, ['status', '--json']); return r.ok ? tailnetOf(r.out) : { step: 'signin' }; };
  /** The names the core's pages are reached at besides this computer's own: the tailnet's, while served. */
  const names = () => { const v = read(); return v.serve && v.host ? [v.host] : []; };
  /** Each page's port served there, at the same port, and one the core served before that no page has now (the door of a
   *  task's pages, closed with it) taken back; one of someone else's, or one on the internet, is left alone and said. One
   *  at a time, so two never read and write what is served at once. */
  let stopping = false;
  let serving: Promise<unknown> = Promise.resolve();
  const serveAll = (): Promise<{ ok: boolean; said?: string; link?: string }> => { const r = serving.then(serveNow, serveNow); serving = r.catch(() => undefined); return r; };
  const serveNow = async (): Promise<{ ok: boolean; said?: string; link?: string }> => {
    const v = read(), owned = new Set(v.served ?? []);
    const wanted = new Set(v.serve && !stopping ? o.ports() : []);
    if (!wanted.size && !owned.size) return { ok: true };
    const t = await look();
    if (!cli || t.step !== 'ready' || !t.host) return { ok: false, said: 'Tailscale is unavailable or HTTPS serving is not ready' };
    const status = await runTailscale(cli, ['serve', 'status', '--json']);
    if (!status.ok) return { ok: false, said: 'Could not check the existing Tailscale routes' };
    const routes = servedPorts(status.out, t.host);
    const remember = () => write({ ...read(), host: t.host, served: [...owned] });
    for (const port of owned) {
      if (wanted.has(port)) continue;
      const route = routes.get(port);
      if (route?.to === port && !route.funnel) {
        const r = await runTailscale(cli, serveOffArgs(port)); o.log({ tailnet: 'off', port, ok: r.ok });
        if (!r.ok) return { ok: false, said: `Could not withdraw port ${port} from Tailscale` };
      }
      owned.delete(port); remember();
    }
    for (const port of wanted) {
      const route = routes.get(port);
      if (route?.funnel) return { ok: false, said: `Port ${port} is exposed by Tailscale Funnel` };
      if (route && (route.to !== port || !owned.has(port))) return { ok: false, said: `Port ${port} has an existing Tailscale route` };
      if (route) continue;
      const r = await runTailscale(cli, serveArgs(port)); o.log({ tailnet: 'serve', port, ok: r.ok });
      if (!r.ok) return { ok: false, said: r.out.trim().split('\n')[0]?.slice(0, 200), link: tailscaleLink(r.out) ?? undefined };
      owned.add(port); remember();
    }
    o.changed?.(); return { ok: true };
  };

  // the Wi-Fi: each page's port on this computer's addresses there, forwarded to that port here alone
  let identity: ReturnType<typeof readLanTls> | undefined;
  const lanRequested = () => read().lan ?? o.lan ?? false;
  if (lanRequested()) {
    try { identity = readLanTls(o.userData, o.lanName); }
    catch (error) { o.log({ lan: 'unavailable', error: (error as Error).message }); }
  }
  const lanOn = () => !!identity && lanRequested();
  const addresses = () => (o.lanAddresses ?? lanAddresses)();
  const lan = () => {
    if (!identity || !lanOn()) return [];
    const desktopPort = o.ports()[0];
    const active = addresses().filter(address => forwards.has(`${address} ${desktopPort}`));
    if (!active.length) return [];
    const ips = active.filter(a => !a.startsWith('127.') && identity!.leaf.checkIP(a));
    return [identity.hostname, ...ips.map(hostOf)];
  };
  const head = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
  /** A request by one of this computer's names on the Wi-Fi, at the port it came to: never localhost's, which only this
   *  computer's own programs use, nor the tailnet's, which is Tailscale's and https. */
  const there = (req: http.IncomingMessage, port: number) => !stopping && o.ports().includes(port) && lan().some(n => (req.headers.host ?? '').toLowerCase() === `${n}:${port}`);
  const forwarder = (port: number, tls: ReturnType<typeof readLanTls>) => {
    const server = https.createServer(tls.options, (req, res) => {
      if (!requestTarget(req.url)) { res.writeHead(400, head).end(); return; }
      if (!there(req, port)) { res.writeHead(421, head).end(); return; }
      const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, r => {
        res.writeHead(r.statusCode ?? 502, r.rawHeaders); r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502, head); res.end(); });
      req.pipe(up);
    });
    const clients = new Set<Duplex>();
    server.on('connection', socket => { clients.add(socket); socket.once('close', () => clients.delete(socket)); });
    server.on('upgrade', (req, socket, early: Buffer) => { // a page's socket: its request as it came, then both ways as they are
      if (!requestTarget(req.url)) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
      if (!there(req, port)) { socket.end('HTTP/1.1 421 Misdirected Request\r\n\r\n'); return; }
      const up = connect(port, '127.0.0.1', () => {
        const lines = []; for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`); if (early.length) up.write(early);
        up.pipe(socket); socket.pipe(up);
      });
      up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy()); socket.on('close', () => up.destroy());
    });
    return { server, close() { server.close(); for (const socket of clients) socket.destroy(); } };
  };
  const forwards = new Map<string, ReturnType<typeof forwarder>>(); // by address and port
  let lanSaid = '';
  /** What is forwarded, as it should be now: each page's port on each address while on, nothing while off; one at a
   *  time, so two never take the same port. */
  let settling = Promise.resolve();
  const reconcile = () => (settling = settling.then(settle, settle));
  const settle = async () => {
    const want = new Set(!stopping && lanOn() ? addresses().flatMap(a => o.ports().map(p => `${a} ${p}`)) : []);
    for (const [k, s] of forwards) if (!want.has(k)) { forwards.delete(k); s.close(); }
    for (const k of want) {
      if (forwards.has(k) || !identity) continue;
      const address = k.slice(0, k.lastIndexOf(' ')), port = Number(k.slice(k.lastIndexOf(' ') + 1)), s = forwarder(port, identity);
      try {
        await new Promise<void>((ok, no) => { s.server.once('error', no); s.server.listen(port, address, () => { s.server.off('error', no); ok(); }); });
        forwards.set(k, s);
      } catch (e) { o.log({ lan: 'not forwarded', address, port, error: (e as Error).message }); }
    }
    const now = lan().join(' '); if (now !== lanSaid) { lanSaid = now; o.changed?.(); } // a new address: pages and apps take it
  };
  const watch = setInterval(() => void reconcile(), 30_000); watch.unref(); // the Wi-Fi's addresses change (a new network, a new lease)
  void reconcile();
  void serveAll().catch(error => o.log({ tailnet: 'restore', error: String(error) }));

  return {
    names, lan, devices: paired,
    /** On the Wi-Fi or off it, as the person says: kept, and each page's port forwarded there, or taken back. */
    async lanServe(on: boolean) {
      if (on && !lanOn()) identity = readLanTls(o.userData, o.lanName);
      write({ ...read(), lan: on }); await reconcile();
      return { ok: true };
    },
    /** Turned on or off by the person: on, each page is served there; off, what the core served is taken back. */
    async serve(on: boolean) {
      write({ ...read(), serve: on });
      const r = await serveAll();
      if (on && !r.ok) { write({ ...read(), serve: false }); await serveAll(); }
      o.changed?.(); return r;
    },
    /** Each page that starts later (a door to a task's pages) is served too, while serving is on, and
     *  forwarded on the Wi-Fi; one that closed is taken back from both. */
    refresh: async () => { await reconcile(); return serveAll(); },
    async state() {
      const t = await look(), v = read(), lanHosts = lan();
      return { step: t.step, host: t.host ?? null, serving: !!v.serve && t.step === 'ready', address: v.serve && v.host ? `https://${v.host}:${o.ports()[0]}` : null, code: paired.code(), devices: paired.list(), push: { key: keys().publicKey },
        lan: { on: lanOn(), address: lanHosts[0] ? `https://${lanHosts[0]}:${o.ports()[0]}` : null, addresses: lanHosts.slice(1).map(n => `https://${n}:${o.ports()[0]}`) } };
    },
    /** The Wi-Fi's forwarding taken back, as the core stops. */
    async close() {
      stopping = true; clearInterval(watch);
      await reconcile();
      const r = await serveAll(); if (!r.ok) o.log({ tailnet: 'shutdown', error: r.said });
    },
    /** The pairing page, at Desktop's port with no token: its form, and the code it sends. */
    async pairPage(req: http.IncomingMessage, res: http.ServerResponse, rest: string, origin: string): Promise<boolean> {
      const head = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' };
      if (rest === 'pair' && req.method === 'GET') { res.writeHead(200, { ...head, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" }); fs.createReadStream(path.join(PAIR, 'pair.html')).pipe(res); return true; }
      if (rest === 'pair.js' && req.method === 'GET') { res.writeHead(200, { ...head, 'Content-Type': 'text/javascript; charset=utf-8' }); fs.createReadStream(path.join(PAIR, 'pair.js')).pipe(res); return true; }
      if (rest === 'pair' && req.method === 'POST') {
        if (req.headers.origin !== origin) { res.writeHead(403, head).end(); return true; }
        let body = ''; for await (const c of req) { body += String(c); if (body.length > 4096) { res.writeHead(413, head).end(); return true; } }
        let q: { code?: unknown; name?: unknown } = {}; try { q = JSON.parse(body) as typeof q; } catch { /* nothing typed */ }
        const r = paired.pair(String(q.code ?? ''), String(q.name ?? ''));
        o.log({ pair: 'error' in r ? 'refused' : r.id });
        res.writeHead('error' in r ? 403 : 200, { ...head, 'Content-Type': 'application/json' }).end(JSON.stringify('error' in r ? r : { url: `/${r.token}/` }));
        return true;
      }
      return false;
    },
    /** A few words to every device that takes notifications: gone ones forget theirs. */
    async notify(message: { title: string; body: string; url?: string; tag?: string; urgent?: boolean }): Promise<PushResult[]> {
      const v = read(), subject = v.host ? `https://${v.host}` : 'mailto:core@vindu.invalid';
      return Promise.all(paired.subscribed().map(async d => {
        const r = await sendPush(d.push, { title: message.title.slice(0, 80), body: message.body.slice(0, 180), ...(message.url ? { url: message.url } : {}), ...(message.tag ? { tag: message.tag } : {}) }, keys(), subject, { ...o.push, urgent: !!message.urgent });
        o.log({ push: d.id, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
        if (r.outcome === 'gone') paired.subscribe(d.id, null);
        return r;
      }));
    },
    /** The core's public key, for a device's browser to subscribe with. */
    pushKey: () => keys().publicKey,
    /** A device's subscription, as its browser handed it over. */
    subscribe(device: string, sub: unknown) { const s = sub === null ? null : subscriptionOf(sub); if (sub !== null && !s) throw new Error('not a push subscription'); return paired.subscribe(device, s); },
  };
}
