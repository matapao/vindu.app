// The phone window: a task's views on a phone or tablet's browser, for what is best done there: answering and
// approving, pointing, taking a photo or signing for a slot of the person's. It is off until the person turns it on.
// It listens on this machine only, unless the person's settings say the local network (phone.lan: true); every request
// needs the window's token, which is in its address; every connection, refusal and answer is logged. The phone sends
// only what the person does to what is shown (answers, pointing, opening a bar, operations), never the layout: the
// layout is the computer's. Pages and MCP Apps show on the computer only (each has an origin of its own there);
// photos, video and sound pass through as they are. What the phone sends while offline waits there, in order.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { readLanTls } from './lan-tls.js';
import { requestTarget } from './request-target.js';
import { PHONE_BODY_LIMIT } from './phone-transfer.js';

/** What the phone may send: what the person does to what is shown. */
export const PHONE_EVENTS = new Set(['action', 'select', 'attach', 'drill', 'page', 'operation']);

type PhoneFile = { name: string; mime: string; data: Buffer };
export type RemoteOptions = {
  lan?: boolean;                              // the local network too; by default this machine only
  userData?: string;                          // contains the Wi-Fi certificate and key when LAN access is requested
  lanName?: string;
  lanBind?: string;                           // interface to serve, all IPv4 interfaces by default
  port?: number;                              // 0: any free port
  files: { html: string; js: string };        // the phone's page and its script
  media: { port: number };                    // vindu's page host: media passes through from there, nothing else
  log: (e: Record<string, unknown>) => void;  // every connection, refusal and answer
  /** A task's event from the phone, and the name the person there gave (not verified): false if it did not fit what is shown. */
  onEvent: (task: string, e: Record<string, unknown>, who?: string) => boolean;
  /** Files the person took for a capture: kept as the task's attachments; their ids. */
  onFormFiles?: (task: string, ticket: string, field: string, files: PhoneFile[]) => string[];
  onCapture: (capture: string, files: PhoneFile[], who?: string) => Promise<string[]>;
  /** What a phone that connects is sent first: each task's latest views and layout, the captures waiting, the task shown. */
  replay: () => { event: string; data: unknown }[];
};

export type Remote = { url: string; port: number; lan: boolean; push: (event: string, data: unknown) => void; clients: () => number; close: () => Promise<void> };

export async function startRemote(o: RemoteOptions): Promise<Remote> {
  if (o.lan && !o.userData) throw new Error('Wi-Fi access needs the certificate and key from Vindu’s data folder.');
  const identity = o.lan ? readLanTls(o.userData!, o.lanName) : undefined;
  const host = identity?.hostname ?? '127.0.0.1';
  const protocol = identity ? 'https' : 'http';
  const token = crypto.randomBytes(24).toString('base64url');
  const streams = new Set<http.ServerResponse>();
  const say = (res: http.ServerResponse, event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const body = (req: http.IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = []; let n = 0;
    const tooLarge = () => { parts.length = 0; reject(new Error('too large')); };
    if (Number(req.headers['content-length']) > PHONE_BODY_LIMIT) { req.resume(); tooLarge(); return; }
    req.on('data', (chunk: Buffer) => {
      if (n > PHONE_BODY_LIMIT) return;
      n += chunk.length;
      if (n > PHONE_BODY_LIMIT) tooLarge(); else parts.push(chunk);
    });
    req.on('end', () => { if (n <= PHONE_BODY_LIMIT) resolve(Buffer.concat(parts)); });
    req.on('error', reject);
  });
  const json = (res: http.ServerResponse, status: number, v: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(v)); };
  const from = (req: http.IncomingMessage) => req.socket.remoteAddress ?? '?';

  const handle: http.RequestListener = (req, res) => {
    const url = requestTarget(req.url);
    if (!url) { res.writeHead(400).end(); return; }
    if (identity && req.headers.host?.toLowerCase() !== `${host}:${port}`) { res.writeHead(421).end(); return; }
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `${protocol}://${req.headers.host}`) { res.writeHead(403).end(); return; }
    const [, tok, what = ''] = url.pathname.split('/');
    if (tok !== token) { o.log({ phone: 'refused', from: from(req) }); res.writeHead(404).end(); return; }
    const secure = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
    if (req.method === 'GET' && what === '') {
      res.writeHead(200, { ...secure, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" })
        .end(fs.readFileSync(o.files.html)); return;
    }
    if (req.method === 'GET' && what === 'phone.js') { res.writeHead(200, { ...secure, 'Content-Type': 'text/javascript; charset=utf-8' }).end(fs.readFileSync(o.files.js)); return; }
    if (req.method === 'GET' && what === 'events') { // what the window shows, as it changes
      res.writeHead(200, { ...secure, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      streams.add(res); o.log({ phone: 'connected', from: from(req) });
      for (const m of o.replay()) say(res, m.event, m.data);
      const alive = setInterval(() => res.write(': still here\n\n'), 20_000);
      req.on('close', () => { clearInterval(alive); streams.delete(res); o.log({ phone: 'left', from: from(req) }); });
      return;
    }
    if (req.method === 'POST' && what === 'event') {
      void body(req).then(b => {
        const m = JSON.parse(b.toString('utf8')) as { task?: unknown; e?: Record<string, unknown>; who?: unknown };
        const e = m.e && typeof m.e === 'object' ? m.e : {};
        if (typeof m.task !== 'string' || (e.type === 'action' && e.name === 'pick_file') || !PHONE_EVENTS.has(String(e.type))) { o.log({ phone: 'ignored', from: from(req), type: String(e.type ?? '') }); json(res, 400, { ok: false }); return; }
        const who = typeof m.who === 'string' && m.who.trim() ? m.who.trim().slice(0, 80) : undefined;
        const { by: _by, ...own } = e; // who answered or pointed is the phone's name field to say, never the event's own by or from
        const ok = o.onEvent(m.task, String(e.type) === 'action' ? own : { ...e, ...(String(e.type) === 'select' ? { from: undefined } : {}) }, who);
        o.log({ phone: 'event', from: from(req), task: m.task, type: e.type, name: e.name ?? null, ...(who ? { who } : {}), ok });
        json(res, 200, { ok }); // one that no longer fits (an ask answered elsewhere) is done with too
      }, () => json(res, 413, { ok: false })).catch(() => json(res, 400, { ok: false }));
      return;
    }
    if (req.method === 'POST' && what === 'capture') {
      void body(req).then(async b => {
        const m = JSON.parse(b.toString('utf8')) as { id?: unknown; form?: { task: string; ticket: string; field: string }; files?: { name?: unknown; mime?: unknown; data?: unknown }[]; who?: unknown };
        const files = (m.files ?? []).filter(f => typeof f?.data === 'string').map(f => ({ name: String(f.name ?? 'capture').replace(/[^\w. -]/g, '_').slice(0, 80) || 'capture', mime: String(f.mime ?? 'application/octet-stream'), data: Buffer.from(String(f.data), 'base64') }));
        const who = typeof m.who === 'string' && m.who.trim() ? m.who.trim().slice(0, 80) : undefined;
        const target = m.form;
        const ids = target ? (typeof target.task === 'string' && typeof target.ticket === 'string' && typeof target.field === 'string'
          ? o.onFormFiles?.(target.task, target.ticket, target.field, files) ?? [] : []) : await o.onCapture(String(m.id ?? ''), files, who);
        o.log({ phone: 'capture', from: from(req), capture: m.id, files: files.length, kept: ids });
        json(res, 200, { ids });
      }, () => json(res, 413, { ids: [] })).catch(e => json(res, 400, { ids: [], error: String((e as Error).message ?? e) }));
      return;
    }
    if (req.method === 'GET' && what === 'media') { // a photo, a video, a sound from the page host, as it is
      let u: URL; try { u = new URL(url.searchParams.get('u') ?? ''); } catch { res.writeHead(400).end(); return; }
      if (u.protocol !== 'http:' || !/^[a-f0-9]{32}\.localhost$/.test(u.hostname) || Number(u.port) !== o.media.port || !u.pathname.startsWith('/media/')) { o.log({ phone: 'refused', from: from(req) }); res.writeHead(404).end(); return; }
      const up = http.request({ host: '127.0.0.1', port: o.media.port, path: u.pathname + u.search, method: 'GET', headers: { host: u.host, ...(req.headers.range ? { range: req.headers.range } : {}) } }, r => {
        const keep = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
        res.writeHead(r.statusCode ?? 502, { ...secure, 'Content-Security-Policy': 'sandbox', ...Object.fromEntries(Object.entries(r.headers).filter(([k]) => keep.includes(k))) });
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      up.end(); return;
    }
    res.writeHead(404).end();
  };
  const lan = !!identity;
  const server = identity ? https.createServer(identity.options, handle) : http.createServer(handle);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(o.port ?? 0, lan ? o.lanBind ?? '0.0.0.0' : '127.0.0.1', () => resolve()); });
  const port = (server.address() as { port: number }).port;
  o.log({ phone: 'on', lan, port });
  return {
    url: `${protocol}://${host}:${port}/${token}/`, port, lan,
    push: (event, data) => { for (const s of streams) say(s, event, data); },
    clients: () => streams.size,
    close: () => new Promise<void>(resolve => { for (const s of streams) s.end(); streams.clear(); server.close(() => resolve()); server.closeAllConnections?.(); o.log({ phone: 'off' }); }),
  };
}
