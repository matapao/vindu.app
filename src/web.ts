// A page's server: one page of the app (Desktop, the connector keys), served on this computer only, on an
// origin of its own (a port of its own), with a token in every address. It serves the page and its files, and carries
// the page's calls and the app's events both ways over one WebSocket, in order, as Electron's IPC did. A request has to
// name the token and come to this computer by its own name (localhost or 127.0.0.1, so no other name that resolves here
// reaches it); a socket has to come from the page's own origin, since a page of any other site can open a socket to any
// address. Nothing else is served: no listing, only the files named, and a page's web app manifest and icon when the
// person can install it as an app of its own. Once the person serves the core on their private network (network.ts), a
// page is reached by that https name too, at the same port, and there only at a paired device's token, never its own, so a
// device removed opens nothing. No page frames another of the app's.
// So it is on their own Wi-Fi, once the person says so: by this computer's names there, over HTTPS, as the core's
// forwarder brings those requests here (network.ts), at a paired device's token alone too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { requestTarget } from './request-target.js';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { readPageRequest } from './socket-messages.js';

/** A page connected to its server: what came from it, and the way to it alone. window: the desktop app's window it is in
 *  (its key, which the app adds to the socket's request as X-Vindu-Frame), when it is in one. */
export type Sender = { id: number; send(channel: string, ...a: unknown[]): void; window?: string;
  /** Where the page is: the name it came by (this computer's, the tailnet's, or the Wi-Fi's), whether by https (the
   *  tailnet's), whether from another device (the tailnet's or the Wi-Fi's), and the paired device it is on, if any. */
  via?: { host: string; secure: boolean; away?: boolean; device?: string; token?: string } };
export type Handler = (e: { sender: Sender }, ...a: any[]) => unknown;
export type PageServer = {
  /** The page's address, token and all. */
  url: string; port: number; origin: string; token: string;
  /** A call from the page: what the handler returns (or throws) is its answer. */
  handle(channel: string, f: Handler): void;
  /** A message from the page, with no answer. */
  on(channel: string, f: Handler): void;
  /** An event to every page connected. */
  send(channel: string, ...a: unknown[]): void;
  sendLocal(channel: string, ...a: unknown[]): void;
  revokeDevice(device: string): void;
  clients(): number;
  close(): Promise<void>;
};
export type PageServerOptions = {
  name: string;
  /** The port it takes: another free one when that one is taken; 0 or none: any. */
  port?: number;
  token: string;
  /** The page, at the token's address. */
  page: string;
  /** Its other files, by the name the page asks for them under the token's address. */
  files?: Record<string, string>;
  /** The page's Content-Security-Policy; the socket is added to what it may connect to, and frame-ancestors. */
  csp: string | (() => string);
  /** The https names it is also reached at (the person's tailnet's), at the same port. */
  names?: () => string[];
  /** The names it is reached at on the person's own Wi-Fi (this computer's name there, its addresses), at the same port
   *  over HTTPS, by the core's forwarder (network.ts). */
  lan?: () => string[];
  /** Other tokens it opens for: a paired device's, as its id. */
  devices?: (token: string) => string | undefined;
  /** A desktop app's link from a paired device (the person's other computer), at its token's frame socket. */
  links?: (device: string, ch: { send(message: string): void; onMessage(f: (message: string) => void): void; onClose(f: () => void): void }) => void;
  /** What it serves with no token (Desktop's pairing page); origin: the page's own, as the request reached it. */
  open?: (req: http.IncomingMessage, res: http.ServerResponse, rest: string, origin: string) => boolean | Promise<boolean>;
  /** Its own addresses under the token (an upload, a download): true when it answered. */
  routes?: (req: http.IncomingMessage, res: http.ServerResponse, rest: string) => boolean | Promise<boolean>;
  /** The page as a web app the person can install, in a window of its own: its name and its icon (SVG or PNG), as the
   *  grid shows them, and the colours of its bar (theme) and of its window before the page draws (background), its
   *  light ones. The page links manifest.webmanifest and app-icon, both served under the token. */
  app?: WebApp;
  /** What a page on another device (by the tailnet's name or the Wi-Fi's) is told in place of what a page here is told:
   *  each event and answer as it goes to that page, still in order. Desktop's: Vindu's pages' addresses, which only this
   *  computer reaches, as that device reaches them (page-doors.ts). */
  away?: (via: NonNullable<Sender['via']>, v: unknown) => unknown;
  onConnect?: (s: Sender) => void;
  onClose?: (s: Sender) => void;
};

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json' };
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024;

/** A port, as preferred: that one when it is free, else any. */
async function listen(server: http.Server, port: number): Promise<number> {
  const at = (p: number) => new Promise<number>((resolve, reject) => {
    const fail = (e: Error) => { server.off('listening', ok); reject(e); };
    const ok = () => { server.off('error', fail); resolve((server.address() as { port: number }).port); };
    server.once('error', fail); server.once('listening', ok); server.listen(p, '127.0.0.1');
  });
  if (!port) return at(0);
  try { return await at(port); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e; return at(0); }
}

/** A page as a web app: its name, its icon, and the colours of its bar and of its window before it draws. */
export type WebApp = { name: string; icon: string; theme?: string; background?: string };
/** A page's web app manifest, made from its name and icon: installed, the page opens at its token's address, which is all
 *  it holds, in a window of its own. A browser takes an icon with its size: a picture's own (PNG), or any for a drawing
 *  (SVG); an icon of another kind is left out. A drawing's pictures beside it (its name-192.png and name-512.png, and its
 *  maskable ones, full-bleed for a phone to cut to its own shape, made by scripts/icons.mjs) are given too, for what
 *  takes no drawing. */
export function webManifest(app: WebApp) {
  const png = /\.png$/i.test(app.icon) ? pngSize(app.icon) : undefined;
  const icon = png ? { sizes: png, type: 'image/png' } : /\.svg$/i.test(app.icon) ? { sizes: 'any', type: 'image/svg+xml' } : undefined;
  const pictures = Object.keys(picturesOf(app.icon)).flatMap(n => { const m = /^app-icon-(maskable-)?(\d+)$/.exec(n); return m ? [{ src: n, sizes: `${m[2]}x${m[2]}`, type: 'image/png', ...(m[1] ? { purpose: 'maskable' } : {}) }] : []; });
  return { name: app.name, short_name: app.name, start_url: './', scope: './', display: 'standalone', ...(app.theme ? { theme_color: app.theme } : {}), ...(app.background ? { background_color: app.background } : {}),
    icons: [...(icon ? [{ src: 'app-icon', ...icon }] : []), ...pictures] };
}
/** A drawing's pictures beside it, by the names a page asks for them under: app-icon-192, app-icon-512, their maskable
 *  ones (app-icon-maskable-192, -512), and apple-touch-icon (180, full-bleed: Safari's Home Screen and Dock). */
export function picturesOf(icon: string): Record<string, string> {
  if (!/\.svg$/i.test(icon)) return {};
  const at = (n: string) => icon.replace(/\.svg$/i, `-${n}.png`);
  return Object.fromEntries([['apple-touch-icon', at('180')], ['app-icon-192', at('192')], ['app-icon-512', at('512')], ['app-icon-maskable-192', at('maskable-192')], ['app-icon-maskable-512', at('maskable-512')]]
    .filter(([, f]) => fs.existsSync(f)));
}

/** A PNG's size from its header, as a manifest gives it ("512x512"), or nothing when the file is not one. */
function pngSize(file: string): string | undefined {
  try {
    const head = Buffer.alloc(24), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, 24, 0); } finally { fs.closeSync(fd); }
    return head.toString('latin1', 12, 16) === 'IHDR' ? `${head.readUInt32BE(16)}x${head.readUInt32BE(20)}` : undefined;
  } catch { return undefined; }
}

export async function startPageServer(o: PageServerOptions): Promise<PageServer> {
  const handlers = new Map<string, { answer: boolean; f: Handler }>();
  const sockets = new Map<number, { socket: Duplex; event: (channel: string, a: unknown[], shared?: () => string) => void }>(); let last = 0;
  const linked = new Set<Duplex>(); // desktop apps' links (o.links)
  const upgraded = new Map<Duplex, string | undefined>(); // includes desktop frame links
  let port = 0;
  const names = () => [...(o.names?.() ?? []), ...(o.lan?.() ?? [])].map(n => n.toLowerCase());
  const hosts = () => new Set([`localhost:${port}`, `127.0.0.1:${port}`, ...names().map(n => `${n}:${port}`)]);
  const origins = () => new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, ...names().map(n => `https://${n}:${port}`)]);
  /** By this computer's own name: here, where the page's own token opens it; by any other (the tailnet's, the Wi-Fi's), a
   *  paired device's token alone. */
  const local = (host: string) => host.startsWith('localhost:') || host.startsWith('127.0.0.1:');
  /** Both remote transports use HTTPS; the loopback listener is HTTP. */
  const tls = (host: string) => names().some(n => host === `${n}:${port}`);
  const csp = () => `${typeof o.csp === 'function' ? o.csp() : o.csp}`
    .replace(/connect-src [^;]*/, m => `${m.replace(/'none'/, '').trim()} ws://localhost:${port} ws://127.0.0.1:${port}${names().map(n => ` wss://${n}:${port}`).join('')}`)
    + "; frame-ancestors 'none'";
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
  const secure = { ...base, 'X-Frame-Options': 'DENY' }; // no page frames these
  const serve = (res: http.ServerResponse, file: string, page = false) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, secure).end(); return; }
      res.writeHead(200, { ...secure, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', ...(page ? { 'Content-Security-Policy': csp() } : {}) });
      fs.createReadStream(file).pipe(res);
    });
  };
  const server = http.createServer((req, res) => {
    const url = requestTarget(req.url);
    if (!url) { res.writeHead(400, secure).end(); return; }
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts().has(host)) { res.writeHead(421, secure).end(); return; }
    const [, tok, ...rest] = url.pathname.split('/');
    const away = !local(host); // by the tailnet's name or the Wi-Fi's: a device's token only
    if ((tok !== o.token || away) && !(tok && o.devices?.(tok))) {
      const origin = `${tls(host) ? 'https' : 'http'}://${host}`;
      void Promise.resolve(o.open?.(req, res, url.pathname.slice(1), origin) ?? false).then(done => { if (!done) res.writeHead(404, secure).end(); }, () => { if (!res.headersSent) res.writeHead(500, secure).end(); });
      return;
    }
    const name = rest.join('/');
    void (async () => {
      if (o.routes && await o.routes(req, res, name)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, secure).end(); return; }
      if (!name) { serve(res, o.page, true); return; }
      if (o.app && name === 'manifest.webmanifest') { res.writeHead(200, { ...secure, 'Content-Type': 'application/manifest+json' }).end(JSON.stringify(webManifest(o.app))); return; }
      if (o.app && name === 'app-icon') { serve(res, o.app.icon); return; }
      const picture = o.app ? picturesOf(o.app.icon)[name] : undefined; if (picture) { serve(res, picture); return; }
      const file = o.files?.[name]; if (file) { serve(res, file); return; }
      res.writeHead(404, secure).end();
    })().catch(e => { if (!res.headersSent) res.writeHead(500, secure); res.end(String((e as Error)?.message ?? e)); });
  });
  server.on('upgrade', (req, socket) => {
    const url = requestTarget(req.url);
    if (!url) { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    const key = req.headers['sec-websocket-key'];
    const [, tok, rest] = url.pathname.split('/'), host = (req.headers.host ?? '').toLowerCase();
    const away = !local(host);
    const device = tok === o.token && !away ? undefined : tok ? o.devices?.(tok) : undefined;
    const linking = rest === 'frame' && !!device && !!o.links; // a paired computer's desktop app, giving its link: not a page's socket
    if (((tok !== o.token || away) && !device) || (rest !== 'socket' && !linking) || url.pathname.split('/').length !== 3 || !hosts().has(host) || (!linking && !origins().has(String(req.headers.origin))) || typeof key !== 'string') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    upgraded.set(socket, device); socket.once('close', () => upgraded.delete(socket));
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const id = ++last;
    const frame = (op: number, data: Buffer) => {
      const n = data.length, head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
      if (!socket.destroyed) socket.write(Buffer.concat([head, data]));
    };
    const send = (text: string) => frame(0x1, Buffer.from(text));
    const window = /^[\w-]{8,}$/.exec(String(req.headers['x-vindu-frame'] ?? ''))?.[0]; // the desktop app's, which says which keys it has
    const via = { host, secure: tls(host), away, ...(device ? { device, token: tok } : {}) };
    // to a page on another device, each event and answer as that device reaches it (o.away), one after another, so they
    // reach it in the order they were sent; to a page here, as it is
    let queue = Promise.resolve();
    const tell = (v: unknown, write: (v: unknown) => string, shared?: () => string) => {
      if (!away || !o.away) { send(shared ? shared() : write(v)); return; }
      queue = queue.then(async () => { let x = v; try { x = await o.away!(via, v); } catch { /* as it is: the page shows what it can */ } send(write(x)); });
    };
    const event = (channel: string, a: unknown[], shared?: () => string) => tell(a, x => JSON.stringify({ t: 'ev', ch: channel, a: x }), shared);
    const sender: Sender = { id, send: (channel, ...a) => event(channel, a), ...(window ? { window } : {}), via };
    const heard: ((m: string) => void)[] = [], ended: (() => void)[] = [];
    if (linking) { linked.add(socket); o.links!(device!, { send, onMessage: f => { heard.push(f); }, onClose: f => { ended.push(f); } }); } // its messages to the link, never a page's events
    else sockets.set(id, { socket, event });
    const answer = (n: number, v: unknown, e?: unknown) => (e === undefined ? tell(v ?? null, x => JSON.stringify({ t: 'reply', id: n, v: x ?? null }))
      : tell(null, () => JSON.stringify({ t: 'reply', id: n, e: String((e as Error)?.message ?? e) })));
    const message = (text: string) => {
      const m = readPageRequest(text);
      if (!m) return;
      const h = handlers.get(m.ch);
      if (m.t === 'call') {
        if (!h?.answer) { answer(m.id, undefined, new Error(`no "${m.ch}" here`)); return; }
        try { void Promise.resolve(h.f({ sender }, ...m.a)).then(v => answer(m.id, v), e => answer(m.id, undefined, e)); } catch (e) { answer(m.id, undefined, e); }
      } else if (h && !h.answer) {
        try { void Promise.resolve(h.f({ sender }, ...m.a)).catch(() => undefined); } catch { /* the page hears nothing back */ }
      }
    };
    // frames as they come: a message may come in pieces (continuations), and a frame across reads
    let buf = Buffer.alloc(0); let parts: Buffer[] = []; let size = 0;
    const ping = setInterval(() => frame(0x9, Buffer.alloc(0)), 25_000);
    const gone = () => { clearInterval(ping); if (linked.delete(socket)) for (const f of ended.splice(0)) f(); if (sockets.delete(id)) o.onClose?.(sender); };
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0; let n = buf[1] & 0x7f, at = 2;
        if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; }
        else if (n === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE)) { socket.destroy(); return; } n = Number(big); at = 10; }
        if (!masked) { socket.destroy(); return; } // a page's frames are always masked
        if (buf.length < at + 4 + n) return;
        const mask = buf.subarray(at, at + 4), data = Buffer.from(buf.subarray(at + 4, at + 4 + n));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        buf = buf.subarray(at + 4 + n);
        if (op === 0x8) { frame(0x8, Buffer.alloc(0)); socket.end(); return; }
        if (op === 0x9) { frame(0xa, data); continue; }
        if (op === 0xa) continue;
        size += data.length; if (size > MAX_MESSAGE) { socket.destroy(); return; }
        parts.push(data);
        if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; size = 0; if (linking) for (const f of heard) f(text); else message(text); }
      }
    });
    socket.on('close', gone); socket.on('error', gone); socket.on('end', () => { gone(); socket.destroy(); }); // ended there: gone here too, not left half open
    if (!linking) o.onConnect?.(sender);
  });
  port = await listen(server, o.port ?? 0);
  const origin = `http://localhost:${port}`;
  return {
    url: `${origin}/${o.token}/`, port, origin, token: o.token,
    handle: (channel, f) => { handlers.set(channel, { answer: true, f }); },
    on: (channel, f) => { handlers.set(channel, { answer: false, f }); },
    send: (channel, ...a) => { let text: string | undefined; for (const s of sockets.values()) s.event(channel, a, () => (text ??= JSON.stringify({ t: 'ev', ch: channel, a }))); },
    sendLocal: (channel, ...args) => { for (const client of sockets.values()) if (!upgraded.get(client.socket)) client.event(channel, args); },
    clients: () => sockets.size,
    revokeDevice(device) { for (const [socket, owner] of upgraded) if (owner === device) socket.destroy(); },
    close: () => new Promise<void>(r => { for (const s of upgraded.keys()) s.destroy(); server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

export { keptToken } from './page-credentials.js';

/** A request's body, up to a limit. */
export const bodyOf = (req: http.IncomingMessage, max: number) => new Promise<Buffer>((resolve, reject) => {
  const parts: Buffer[] = []; let n = 0;
  req.on('data', (c: Buffer) => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
  req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject);
});
