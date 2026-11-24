// A page's end of its server's socket (web.ts): calls with their answers, messages, and the app's events, in the order
// they were sent. Calls made before the socket opens wait for it. If the app stops, the page says so and, once the app is
// back, loads again from it: what it shows is always what the app has now.
import { isCallId, readObject } from './socket-messages.js';

export type Off = () => void;
export type Socket = {
  invoke(channel: string, ...a: unknown[]): Promise<any>;
  post(channel: string, ...a: unknown[]): void;
  on(channel: string, cb: (...a: any[]) => void): Off;
  /** The page's own address under its token, for its files and uploads. */
  base: string;
};

export function connect(): Socket {
  const base = location.pathname.replace(/[^/]*$/, '');
  const address = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}socket`;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>(); let n = 0;
  const listeners = new Map<string, Set<(...a: any[]) => void>>();
  const queue: string[] = [];
  let ws: WebSocket, tries = 0;
  const say = (text: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(text); else queue.push(text); };
  const gone = () => {
    let note = document.getElementById('socket-gone');
    if (!note) {
      note = document.createElement('div'); note.id = 'socket-gone'; note.setAttribute('role', 'status');
      note.textContent = 'The app has stopped. This page comes back by itself when it is running again.';
      note.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:8px;font:13px system-ui,sans-serif;background:#b3261e;color:#fff;box-shadow:0 2px 12px rgb(0 0 0/.3)';
      document.body.append(note);
    }
  };
  const open = () => {
    ws = new WebSocket(address);
    ws.onopen = () => {
      if (tries > 0) { location.reload(); return; } // back after a stop: everything as the app has it now
      for (const text of queue.splice(0)) ws.send(text);
    };
    ws.onmessage = e => {
      if (typeof e.data !== 'string') return;
      const m = readObject(e.data);
      if (m?.t === 'reply' && isCallId(m.id) && (m.e === undefined || typeof m.e === 'string')) {
        const w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id);
        if (m.e !== undefined) w.reject(new Error(m.e)); else w.resolve(m.v);
      } else if (m?.t === 'ev' && typeof m.ch === 'string' && Array.isArray(m.a)) {
        for (const cb of [...(listeners.get(m.ch) ?? [])]) { try { cb(...m.a); } catch (err) { console.error(err); } }
      }
    };
    ws.onclose = () => {
      queue.length = 0; // calls reported as failed must never execute on reconnect
      for (const w of waiting.values()) w.reject(new Error('the app stopped before it answered')); waiting.clear();
      gone();
      setTimeout(open, Math.min(5000, 300 * 2 ** tries++));
    };
  };
  open();
  return {
    base,
    invoke: (channel, ...a) => new Promise((resolve, reject) => { const id = ++n; waiting.set(id, { resolve, reject }); say(JSON.stringify({ t: 'call', id, ch: channel, a })); }),
    post: (channel, ...a) => say(JSON.stringify({ t: 'post', ch: channel, a })),
    on: (channel, cb) => { let s = listeners.get(channel); if (!s) listeners.set(channel, s = new Set()); s.add(cb); return () => { s!.delete(cb); }; },
  };
}
