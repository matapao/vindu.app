// Vindu's pages on the person's other devices. Vindu serves a task's pages on this computer's loopback, each task at an
// origin of its own (http://<key>.localhost:<port>, an MCP App's at app-<key>.localhost, and the working folder's at
// work-<key>.localhost or work-<key>-<grant>.localhost: Vindu's pages.ts), which no
// other device reaches: a browser there looks for <key>.localhost on itself, and its frame stays empty. So each such
// origin gets a door here, a port of its own on this computer, which the core serves on the person's Wi-Fi and tailnet
// as it serves its pages (network.ts), and which hands each request on to Vindu's page host as that origin: a port per
// origin keeps an origin per task on the device too. What a page on another device is told (web.ts's away) names each
// of Vindu's addresses as that device reaches it, through its door; a page here is told them as they are.
// A door opens for a paired device alone, by a key made here for that device (never its token, which no app is given):
// the address the device is told carries it once (?vindu-door=…), and the door keeps it in a cookie (HttpOnly,
// SameSite=Strict) and sends the page on without it, so the page's own requests (its scripts, its data, its events)
// carry it and no page sees it. A device removed opens nothing; nor does this computer's own name, by which Vindu's page
// host is reached as it is. The keys are made again each time the core starts.
import crypto from 'node:crypto';
import http from 'node:http';
import { requestTarget } from './request-target.js';
import type { Duplex } from 'node:stream';

/** Where a page on another device is, as its page server says (web.ts's Sender.via). */
export type Away = { host: string; secure: boolean; device?: string };

export type PageDoorsSetup = {
  /** Vindu's page host's port, on 127.0.0.1. */
  hostPort: number;
  /** The paired devices' ids: a door opens for these alone. */
  devices: () => string[];
  /** The names the core is reached at on the tailnet (https) and on the Wi-Fi (https), at each door's port. */
  names: () => string[];
  lan: () => string[];
  /** A door opened or closed: the core serves its port there, or no longer. A door is told to no device before this is done. */
  changed: () => Promise<{ ok: boolean } | void>;
  log?: (e: Record<string, unknown>) => void;
};
export type PageDoors = ReturnType<typeof pageDoors>;

const PARAM = 'vindu-door';
const head = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
type Door = { port: number; server: http.Server; clients: Map<Duplex, string> };

/** A cookie's value from a request's Cookie header. */
const cookie = (header: string | undefined, name: string) => {
  for (const part of (header ?? '').split(';')) { const at = part.indexOf('='); if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim(); }
  return undefined;
};
/** Every string in a value (a page server's event or answer), and the same value with each string as f makes it. */
function strings(v: unknown, f: (s: string) => void): void {
  if (typeof v === 'string') f(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, f);
  else if (plain(v)) for (const x of Object.values(v)) strings(x, f);
}
function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map(x => mapStrings(x, f));
  if (plain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));

export function pageDoors(o: PageDoorsSetup) {
  const secret = crypto.randomBytes(32);
  const mac = (device: string, scope: string) => crypto.createHmac('sha256', secret).update(JSON.stringify([scope, device])).digest('base64url');
  const keyOf = (device: string, scope: string) => `${device}.${mac(device, scope)}`;
  const whose = (key: string | undefined, scope: string): string | undefined => {
    const at = key?.lastIndexOf('.') ?? -1; if (!key || at < 1) return undefined;
    const device = key.slice(0, at), code = Buffer.from(key.slice(at + 1)), want = Buffer.from(mac(device, scope));
    return code.length === want.length && crypto.timingSafeEqual(code, want) && o.devices().includes(device) ? device : undefined;
  };
  /** An address of Vindu's page host: an origin's name (a task's key, or app-<key>) and the rest of it. */
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from constants and the host's own port, a number
  const ORIGIN = new RegExp(`^http://((?:app-[a-f0-9]{32}|work-[a-f0-9]{32}(?:-[a-f0-9]{24})?|[a-f0-9]{32}))\\.localhost:${o.hostPort}(/\\S*)?$`);
  const doors = new Map<string, Promise<Door>>(); // by the origin's name
  const open = new Map<string, Door>();
  const retiring = new Set<Door>(); // hold the old port until network forwarding has been withdrawn
  const shown = new Map<string, Set<string>>(); // the origins each task showed: their doors close with it
  let closed = false;

  // Each origin has its own cookie name and credential.
  const door = (scope: string) => {
    const clients = new Map<Duplex, string>();
    const cookieName = `${PARAM}-${scope}`, target = `${scope}.localhost:${o.hostPort}`;
    const originOf = (req: http.IncomingMessage) => {
      if (open.get(scope)?.server !== server) return undefined;
      const port = (server.address() as { port: number } | null)?.port;
      const host = (req.headers.host ?? '').toLowerCase();
      return [...o.names(), ...o.lan()].some(n => host === `${n.toLowerCase()}:${port}`) ? `https://${host}` : undefined;
    };
    const track = (socket: Duplex, device: string) => {
      if (!clients.has(socket)) socket.once('close', () => clients.delete(socket));
      clients.set(socket, device);
    };
    const headersFor = (req: http.IncomingMessage) => {
      const headers = { ...req.headers, host: target };
      delete headers.cookie;
      // A web app does not receive a token-bearing address of a parent or a referring task.
      delete headers.referer;
      return headers;
    };
    const server = http.createServer((req, res) => {
      const origin = originOf(req);
      if (!origin) { res.writeHead(421, head).end(); return; }
      const raw = req.url ?? '/', q = raw.indexOf('?'), pathname = q < 0 ? raw : raw.slice(0, q);
      if (!requestTarget(req.url)) { res.writeHead(400, head).end(); return; }
      const parts = q < 0 ? [] : raw.slice(q + 1).split('&'), given = parts.find(p => p.startsWith(`${PARAM}=`));
      const kept = parts.filter(p => p && !p.startsWith(`${PARAM}=`)), onward = `${pathname}${kept.length ? `?${kept.join('&')}` : ''}`;
      if (given !== undefined) {
        let key = ''; try { key = decodeURIComponent(given.slice(PARAM.length + 1)); } catch { /* invalid key */ }
        if (!whose(key, scope) || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(403, head).end(); return; }
        res.writeHead(302, { ...head, Location: onward, 'Set-Cookie': `${cookieName}=${key}; Path=/; HttpOnly; SameSite=Strict${origin.startsWith('https:') ? '; Secure' : ''}` }).end();
        return;
      }
      const device = whose(cookie(req.headers.cookie, cookieName), scope);
      if (!device || (!['GET', 'HEAD'].includes(req.method ?? '') && req.headers.origin !== origin)) { res.writeHead(403, head).end(); return; }
      track(req.socket, device);
      const up = http.request({ host: '127.0.0.1', port: o.hostPort, method: req.method, path: onward, headers: headersFor(req) }, r => {
        const headers = { ...r.headers };
        delete headers['set-cookie']; delete headers['clear-site-data']; headers['referrer-policy'] = 'no-referrer';
        res.writeHead(r.statusCode ?? 502, headers); r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502, head); res.end(); });
      res.on('close', () => up.destroy());
      req.pipe(up);
    });
    return { server, clients };
  };
  /** The door of an origin, opened now if it is not yet, and served on the Wi-Fi and the tailnet before it is told. */
  const doorOf = (name: string): Promise<Door> => {
    let d = doors.get(name);
    if (!d) {
      d = (async () => {
        if (closed) throw new Error('the core is stopping');
        const { server, clients } = door(name);
        await new Promise<void>((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => { server.off('error', no); ok(); }); });
        if (closed || doors.get(name) !== d) { server.close(); throw new Error('The view was closed'); }
        const opened = { port: (server.address() as { port: number }).port, server, clients };
        open.set(name, opened); o.log?.({ door: 'open', port: opened.port });
        await refresh();
        if (open.get(name) !== opened) throw new Error('The view was closed');
        return opened;
      })();
      doors.set(name, d); d.catch(() => { if (doors.get(name) === d && shut(name)) void refresh().catch(() => undefined); });
    }
    return d;
  };
  const names = (v: unknown) => { const found = new Set<string>(); strings(v, s => { const m = ORIGIN.exec(s); if (m) found.add(m[1]); }); return found; };
  const shut = (name: string) => {
    const d = open.get(name); doors.delete(name);
    if (!d) return false;
    open.delete(name); retiring.add(d);
    for (const socket of d.clients.keys()) socket.destroy();
    d.server.closeAllConnections(); o.log?.({ door: 'closed', port: d.port }); return true;
  };
  const refresh = async () => {
    const pending = [...retiring];
    if ((await o.changed())?.ok === false) return;
    for (const door of pending) if (retiring.delete(door)) door.server.close();
  };

  return {
    /** The doors' ports, for the core to serve on the Wi-Fi and the tailnet. */
    ports: () => [...open.values()].map(d => d.port),
    /** A value as a page on another device is told it: each of Vindu's addresses in it as that device reaches it, through
     *  its origin's door, with the device's key; the rest as it is. */
    async through(via: Away, v: unknown): Promise<unknown> {
      if (!via.device) return v;
      const wanted = names(v); if (!wanted.size) return v;
      const ports = new Map(await Promise.all([...wanted].map(async n => [n, (await doorOf(n)).port] as const)));
      const at = `${via.secure ? 'https' : 'http'}://${via.host.replace(/:\d+$/, '')}`, device = via.device;
      return mapStrings(v, s => {
        const m = ORIGIN.exec(s); if (!m) return s;
        const rest = m[2] ?? '/', hash = rest.indexOf('#'), before = hash < 0 ? rest : rest.slice(0, hash);
        return `${at}:${ports.get(m[1])}${before}${before.includes('?') ? '&' : '?'}${PARAM}=${encodeURIComponent(keyOf(device, m[1]))}${hash < 0 ? '' : rest.slice(hash)}`;
      });
    },
    revokeDevice(id: string) { for (const d of open.values()) for (const [socket, device] of d.clients) if (device === id) socket.destroy(); },
    /** The origins a task's view names, so their doors close with the task. */
    note(task: string, v: unknown) { const n = names(v); if (n.size) shown.set(task, new Set([...(shown.get(task) ?? []), ...n])); },
    /** A task closed: its origins' doors with it. */
    async release(task: string) {
      const n = shown.get(task); shown.delete(task); if (!n) return;
      let any = false; for (const name of n) any = shut(name) || any;
      if (any) await refresh();
    },
    /** Every door, as the core stops. */
    close() {
      closed = true; for (const name of [...open.keys()]) shut(name);
      for (const door of retiring) door.server.close();
      retiring.clear();
    },
  };
}
