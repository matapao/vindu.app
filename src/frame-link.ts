// The Electron window's link, for the server process it started (frame/src/link.ts): its address and its token come in
// this process's environment, and are taken out of it at once, so nothing the server starts is given them. The address
// is a socket only this user can open on this computer. Over it, the server opens its browser views' pages in the
// Electron app, each a page of its own laid over its pane in a window of the app's, and drives each over the DevTools
// protocol, as it drives a page in its own hidden Chromium (pages.ts). One connection: the token first, then one JSON
// message a line each way. The server asks ({ id, m, … }) and the app answers ({ id, result } or { id, error }); the app
// tells the windows it has, each by its key ({ ev: 'windows' }), and what each page's DevTools protocol says
// ({ ev: 'cdp' }).
import net from 'node:net';
import { isCallId, readObject } from './socket-messages.js';
import type { Cdp } from '@matapao/vindu/server';

/** Where a pane is in its window's page, in CSS pixels. */
export type FrameRect = { x: number; y: number; w: number; h: number };
/** A page in the Electron app. */
export type FrameView = {
  /** Its DevTools protocol, as Vindu's browser views take it. */
  cdp: Cdp;
  /** Its address, as its main frame last said. */
  url(): string;
  title(): Promise<string>;
  /** Laid over its pane, in the app's window of that key; or taken off every window. */
  place(window: string | null, at?: FrameRect): void;
  /** Whether the app it lives in has a window of that key: there, it shows live; elsewhere, pictures. */
  shows(window: string): boolean;
  close(): Promise<void>;
};
export type FrameLink = {
  /** Whether the app has a window of that key now. */
  has(window: string): boolean;
  /** A new page in the app, empty, in that partition's session: the person's, or a task's own for the model's pages. */
  open(partition: string): Promise<FrameView>;
  /** A partition's storage cleared: a task's, once it is gone. */
  clear(partition: string): Promise<void>;
  /** Whether the app is still there. */
  connected(): boolean;
};
/** A link's way: a message out, each message in, and its end. */
type LinkChannel = { send(message: string): void; onMessage(f: (message: string) => void): void; onClose(f: () => void): void };

/** The link over its channel: the server's side of it. */
function linkOver(ch: LinkChannel): FrameLink {
  let live = true, last = 0, windows = new Set<string>();
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  type View = { subs: Map<string, Set<(p: unknown) => void>>; url: string; main?: string };
  const views = new Map<string, View>();
  ch.onMessage(text => {
    const m = readObject(text);
    if (!m) return;
    if (isCallId(m.id)) {
      if (m.error !== undefined && typeof m.error !== 'string') return;
      const w = waiting.get(m.id); waiting.delete(m.id);
      if (m.error !== undefined) w?.fail(new Error(m.error)); else w?.ok(m.result);
      return;
    }
    if (m.ev === 'windows' && Array.isArray(m.keys) && m.keys.every(k => typeof k === 'string')) {
      windows = new Set(m.keys);
    } else if (m.ev === 'cdp' && typeof m.view === 'string' && typeof m.method === 'string' && m.params && typeof m.params === 'object' && !Array.isArray(m.params)) {
      const v = views.get(m.view); if (!v) return;
      const method = m.method, p = m.params as Record<string, unknown>;
      if (method === 'Page.frameNavigated' && p.frame && typeof p.frame === 'object') {
        const frame = p.frame as Record<string, unknown>;
        if (!frame.parentId && typeof frame.id === 'string' && typeof frame.url === 'string') {
          v.main = frame.id;
          v.url = frame.url + (typeof frame.urlFragment === 'string' ? frame.urlFragment : '');
        }
      } else if (method === 'Page.navigatedWithinDocument' && p.frameId === v.main && typeof p.url === 'string') v.url = p.url;
      for (const f of v.subs.get(method) ?? []) { try { f(p); } catch { /* the listener's own */ } }
    }
  });
  ch.onClose(() => { if (!live) return; live = false; windows = new Set(); for (const w of waiting.values()) w.fail(new Error('the Electron app is gone')); waiting.clear(); });
  const call = (m: string, params: Record<string, unknown> = {}) => new Promise<unknown>((ok, fail) => {
    if (!live) { fail(new Error('the Electron app is gone')); return; }
    const id = ++last; waiting.set(id, { ok, fail }); ch.send(JSON.stringify({ id, m, ...params }));
  });
  return {
    has: window => windows.has(window),
    connected: () => live,
    clear: async partition => { await call('clear', { partition }); },
    async open(partition) {
      const { view } = await call('open', { partition }) as { view: string };
      const v: View = { subs: new Map(), url: 'about:blank' }; views.set(view, v);
      const cdp: Cdp = {
        send: (method, params) => call('cdp', { view, method, params: params ?? {} }),
        on: (event, fn) => { let s = v.subs.get(event); if (!s) v.subs.set(event, s = new Set()); s.add(fn); return () => { s!.delete(fn); }; },
      };
      return {
        cdp, url: () => v.url,
        title: async () => String(((await call('info', { view })) as { title?: string }).title ?? ''),
        place: (window, at) => { void call('place', { view, window, ...(at ? { at } : {}) }).catch(() => undefined); },
        shows: window => live && windows.has(window),
        close: async () => { views.delete(view); await call('close', { view }).catch(() => undefined); },
      };
    },
  };
}

/** The Electron app's link, when it started this server and said so in `env`; nothing otherwise. */
export async function frameLink(env: NodeJS.ProcessEnv = process.env): Promise<FrameLink | undefined> {
  const at = env.VINDU_FRAME, token = env.VINDU_FRAME_TOKEN;
  delete env.VINDU_FRAME; delete env.VINDU_FRAME_TOKEN;
  if (!at || !token) return undefined;
  const sock = await new Promise<net.Socket>((ok, fail) => { const s = net.connect(at, () => { s.off('error', fail); ok(s); }); s.once('error', fail); });
  sock.write(`${token}\n`);
  sock.setEncoding('utf8');
  return linkOver({
    send: m => { if (!sock.destroyed) sock.write(`${m}\n`); },
    onMessage: f => { let buf = ''; sock.on('data', (d: string) => { buf += d; let i: number; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) f(line); } }); },
    onClose: f => { sock.on('close', f); sock.on('error', f); },
  });
}
