// The Electron window's link with the app's own server process, which it started (the server's src/frame-link.ts): the
// server opens its browser views' pages here, each a page of its own (a WebContentsView) laid over its pane in the
// window that shows it, and drives each over the DevTools protocol, as it drives a page in its own hidden Chromium. The
// link is a socket only this user can open on this computer (a Unix socket in a folder of its own, or a named pipe on
// Windows), and it takes one connection at a time, the one that first sends the token the server was given. Over it,
// one JSON message at a time, each way: the server asks ({ id, m, … }) and is answered ({ id, result } or
// { id, error }); the app tells it the windows it has, each by its key ({ ev: 'windows' }), and what each page's
// DevTools protocol says ({ ev: 'cdp' }). The server's pages go with it when it goes.
// Each of the app's windows has a key, which the app adds to its pages' sockets to the server as they open
// (X-Vindu-Frame, on the request that opens one): so the server knows which of its pages' connections is in which window
// here, and lays a pane's page over that pane, in that window. The pages themselves never see it.
// A page here is sandboxed, with no Node and no preload, in its own session (the person's, kept; or a task's own for the
// model's pages): no camera, microphone, location or notifications, nothing downloaded, no page of its own embedded in it;
// what it would open in a window of its own opens in the same page.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { session, WebContentsView, type BrowserWindow, type Session } from 'electron';

type Rect = { x: number; y: number; w: number; h: number };
type View = { view: WebContentsView; window?: BrowserWindow };
export type Link = {
  /** Where the server reaches it, and the token it has to send first: what the server is given (VINDU_FRAME, VINDU_FRAME_TOKEN). */
  address: string; token: string;
  /** A window of the app's: its key, added to its pages' sockets to the server. */
  mark(win: BrowserWindow): void;
  close(): void;
};

// Only commands used by the host's page driver can reach a page debugger.
const PAGE_COMMANDS = new Set([
  'Accessibility.enable', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree',
  'DOM.enable', 'DOM.describeNode', 'DOM.focus', 'DOM.getContentQuads', 'DOM.getDocument', 'DOM.querySelectorAll', 'DOM.resolveNode', 'DOM.scrollIntoViewIfNeeded',
  'Emulation.clearDeviceMetricsOverride', 'Emulation.setDeviceMetricsOverride', 'Fetch.continueRequest', 'Fetch.enable', 'Fetch.failRequest',
  'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'Input.insertText', 'Log.enable', 'Network.enable',
  'Overlay.enable', 'Overlay.hideHighlight', 'Overlay.setInspectMode', 'Page.captureScreenshot', 'Page.enable', 'Page.getFrameTree',
  'Page.getNavigationHistory', 'Page.handleJavaScriptDialog', 'Page.navigate', 'Page.navigateToHistoryEntry', 'Page.reload',
  'Page.screencastFrameAck', 'Page.startScreencast', 'Page.stopScreencast', 'Runtime.callFunctionOn', 'Runtime.enable', 'Runtime.evaluate', 'Runtime.releaseObject',
]);

export async function startLink(): Promise<Link> {
  const token = randomBytes(24).toString('base64url');
  const dir = process.platform === 'win32' ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-frame-')); // made for this user only (0700)
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\vindu-frame-${randomBytes(12).toString('hex')}` : path.join(dir, 'link.sock');
  type KeyedWindow = { win: BrowserWindow; key: string };
  const windows = new Map<string, KeyedWindow>();
  const byContents = new Map<number, KeyedWindow>();
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket -- URL patterns whose requests lose a header, not a connection
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://*/*', 'wss://*/*'] }, (request, done) => {
    const window = byContents.get(request.webContentsId ?? -1);
    const url = new URL(request.url);
    const local = url.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(url.hostname); // the server's pages, on this computer
    const headers = { ...request.requestHeaders };
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'x-vindu-frame') delete headers[name];
    if (window && local) headers['X-Vindu-Frame'] = window.key;
    done({ requestHeaders: headers });
  });
  /** The server's link while it is there: its way to it. */
  let send: ((message: string) => void) | undefined;
  let n = 0;
  const tellWindows = () => send?.(JSON.stringify({ ev: 'windows', keys: [...windows.keys()] }));

  const guarded = new Set<string>();
  const sessionFor = (partition: string): Session => {
    const s = session.fromPartition(partition);
    if (!guarded.has(partition)) {
      guarded.add(partition);
      s.setPermissionRequestHandler((_wc, _p, answer) => answer(false)); s.setPermissionCheckHandler(() => false);
      s.on('will-download', e => e.preventDefault());
      s.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (_request, done) => done({ cancel: true }));
    }
    return s;
  };
  // Electron may destroy the native contents while its window is closing, before the
  // server's socket reports that it closed. Both shutdown paths release the same view.
  const closeView = (view: View) => {
    const wc = view.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (view.window && !view.window.isDestroyed()) view.window.contentView.removeChildView(view.view);
    view.window = undefined;
    if (wc.debugger.isAttached()) wc.debugger.detach();
    wc.close();
  };
  const views = new Map<string, View>(); // the server's pages here
  /** The server's link: its pages, what it asks, and its end, which takes its pages with it. */
  const serve = (write: (message: string) => void) => {
    send = write;
    const tell = (m: unknown) => write(JSON.stringify(m));
    const partitionFor = (partition: string) => {
      if (partition === 'persist:vindu-person' || /^vindu-model-[\w-]+$/.test(partition)) return partition;
      throw new Error('Unknown browser session');
    };
    const open = (partition: string) => {
      const view = new WebContentsView({ webPreferences: { session: sessionFor(partitionFor(partition)), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, safeDialogs: true } });
      const id = `v${++n}`, wc = view.webContents;
      views.set(id, { view });
      wc.debugger.attach('1.3');
      wc.debugger.on('message', (_e, method: string, params: unknown) => tell({ ev: 'cdp', view: id, method, params }));
      // what the page would open in a window of its own opens here instead, through the same gate as its other moves
      wc.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) void wc.loadURL(url).catch(() => undefined); return { action: 'deny' }; });
      wc.on('will-attach-webview', e => e.preventDefault());
      void wc.loadURL('about:blank').catch(() => undefined);
      return { view: id };
    };
    const need = (id: unknown) => { const v = views.get(String(id)); if (!v) throw new Error(`no page ${String(id)}`); return v; };
    /** Over its pane in the window of that key, at the pane's place in the window's page (times the page's zoom); or off. */
    const place = (v: View, key: string | null, at?: Rect) => {
      const target = key ? windows.get(key) : undefined;
      if (key && !target) throw new Error('That window has closed');
      const win = target?.win;
      if (v.window && v.window !== win && !v.window.isDestroyed()) v.window.contentView.removeChildView(v.view);
      if (!win || !at || win.isDestroyed()) { v.window = undefined; return; }
      if (v.window !== win) { win.contentView.addChildView(v.view); v.window = win; }
      const z = win.webContents.getZoomFactor();
      v.view.setBounds({ x: Math.round(at.x * z), y: Math.round(at.y * z), width: Math.max(1, Math.round(at.w * z)), height: Math.max(1, Math.round(at.h * z)) });
    };
    const close = (id: string) => {
      const v = views.get(id); if (!v) return; views.delete(id);
      closeView(v);
    };
    const answer = (id: unknown, result?: unknown, error?: unknown) => tell(error === undefined ? { id, result: result ?? null } : { id, error: String((error as Error)?.message ?? error) });
    tellWindows();
    return {
      async heard(text: string) {
        let m: Record<string, unknown>; try { m = JSON.parse(text) as Record<string, unknown>; } catch { return; }
        if (!m || typeof m !== 'object' || Array.isArray(m) || !Number.isSafeInteger(m.id)) return;
        try {
          if (m.m === 'open') answer(m.id, open(String(m.partition)));
          else if (m.m === 'cdp') {
            const method = String(m.method);
            if (!PAGE_COMMANDS.has(method)) throw new Error('Unsupported page command');
            const params = (m.params ?? {}) as Record<string, unknown>;
            if (method === 'Page.navigate' && params.url !== 'about:blank' && !['https:', 'http:'].includes(new URL(String(params.url)).protocol)) throw new Error('A page must use a web address');
            if (method === 'Fetch.continueRequest' && Object.keys(params).some(key => key !== 'requestId')) throw new Error('A paused request can only continue as submitted');
            answer(m.id, await need(m.view).view.webContents.debugger.sendCommand(method, params));
          }
          else if (m.m === 'place') { place(need(m.view), m.window ? String(m.window) : null, m.at as Rect | undefined); answer(m.id); }
          else if (m.m === 'info') { const wc = need(m.view).view.webContents; answer(m.id, { url: wc.getURL(), title: wc.getTitle() }); }
          else if (m.m === 'close') { close(String(m.view)); answer(m.id); }
          else if (m.m === 'clear') { if (m.partition !== 'persist:vindu-person') await sessionFor(partitionFor(String(m.partition))).clearStorageData(); answer(m.id); }
          else answer(m.id, undefined, `no "${String(m.m)}" here`);
        } catch (e) { answer(m.id, undefined, e); }
      },
      /** The server went: so do its pages. */
      gone() { send = undefined; for (const id of [...views.keys()]) close(id); },
    };
  };

  let local: net.Socket | undefined;
  const server = net.createServer(sock => {
    if (local) { sock.destroy(); return; } // one server: the one this app started
    let buf = '', served: ReturnType<typeof serve> | undefined;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      buf += d; let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!served) { if (line !== token || local) { sock.destroy(); return; } local = sock; served = serve(m => { if (!sock.destroyed) sock.write(`${m}\n`); }); continue; }
        void served.heard(line);
      }
    });
    sock.on('error', () => undefined);
    sock.on('close', () => { if (local !== sock) return; local = undefined; served?.gone(); });
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(address, () => { server.off('error', fail); ok(); }); });
  return {
    address, token,
    mark(win) {
      const id = win.webContents.id;
      if (byContents.has(id)) return;
      const key = randomBytes(12).toString('base64url'), entry = { win, key };
      windows.set(key, entry); byContents.set(id, entry); tellWindows();
      win.once('closed', () => { windows.delete(key); byContents.delete(id); for (const v of views.values()) if (v.window === win) v.window = undefined; tellWindows(); });
    },
    close() {
      local?.destroy();
      for (const view of views.values()) closeView(view);
      views.clear();
      server.close();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
