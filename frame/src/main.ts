// The desktop app: the shell's frame on a computer (the README's "The desktop app"). It starts this computer's
// core, as `pnpm start` does, and keeps it while the person works, in the menu bar; or it uses a core running already
// (started in a terminal), and leaves it running. It shows the core's pages, the same a browser shows, in one window: the
// shell, with each app open in it as a tab of the shell's bar (shell-page.ts, which knows by the window's key that it is
// here). An app popped out of it, or one whose page lets no frame show it, opens in a window of its own (window.open
// from the shell), and that window comes forward when it is open already, whoever opened it. A link to an app
// (vindu://<app>/…, links.ts) opens its tab, by the shell's address (#open=<app>&link=…), or its window when it has one.
// The core it starts has its link (link.ts): that core's browser views' pages live here, each a page of its own laid over
// its pane, where a browser's tab shows pictures of a page the core drives elsewhere.
// Cores elsewhere (a Pi, a Mac mini, a server on the person's tailnet) are added by their address and a code made there
// (cores.ts, add-core.ts), and opened from the menu bar, each in windows of its own with its name in their titles; each
// gives its link too, so its pages live here as well. One out of reach says so in its windows, and is tried again.
// Only the cores' pages load in its windows (this computer's, and those elsewhere the person added); any other page opens in the person's browser, and no page
// gets the camera, the microphone, location or notifications. Every window is sandboxed, with no Node and no preload.
// Closing every window leaves the core running, for automations and the phone; Quit stops it, and all it started.
// A client build (core.ts) has no core here, and starts none: it opens the cores elsewhere it has, each in its window, or
// the window to add one when it has none; its links go to the core elsewhere in front last. Their pages live here all
// the same, over the link it gives each.
import path from 'node:path';
import { app, BrowserWindow, Menu, session, shell, Tray, type BrowserWindowConstructorOptions, type MenuItemConstructorOptions } from 'electron';
import { addCorePage, ADD_SCHEME } from './add-core.js';
import { client, startCore, type Core } from './core.js';
import { coresElsewhere } from './cores.js';
import { trayIcon } from './icon.js';
import { startLink, type Link } from './link.js';
import { appOf, linkIn, withLink } from './links.js';
import { watchUpdates, type Updates } from './update.js';

if (process.env.VINDU_FRAME_DATA) app.setPath('userData', process.env.VINDU_FRAME_DATA); // a test's own, or a second app's
app.enableSandbox();
// one app at a time: started again, the first comes forward (or takes the link the second was started by), and the second leaves
if (!app.requestSingleInstanceLock()) app.quit();
else frame();

function frame() {
  let core: Core | undefined, tray: Tray | undefined, grid: BrowserWindow | undefined, link: Link | undefined, updates: Updates | undefined;
  let stopped = '', newer = '', quitting = false;
  /** A client's start done: the app ready, and its link there for the cores elsewhere it opens. */
  let up = false;
  /** Links that came before the core was up: the one the app was started by (in its arguments on Windows and Linux; on a
   *  Mac, as an event of its own), taken once the core is (a client's, once it is up), in place of the grid. */
  const waiting: string[] = [];
  const started = linkIn(process.argv); if (started) waiting.push(started);
  /** Whether a page is on this computer: this computer's core's are. A client has no core here: a page on this computer
   *  is any other page to it. */
  const local = (url: string) => { if (client) return false; try { const u = new URL(url); return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'); } catch { return false; } };
  /** The cores elsewhere the person added, and each one's link, once a window of it opened. */
  const cores = coresElsewhere(path.join(app.getPath('userData'), 'cores.json'));
  const linked = new Map<string, { close(): void }>();
  /** Each window of a core elsewhere's, by its page's id: its grid's, and every window that grid's pages opened. */
  const whose = new Map<number, string>();
  const coreOf = (wc: { id: number }) => { const id = whose.get(wc.id); return id ? cores.list().find(c => c.id === id) : undefined; };
  /** Whether a page is a core's: this computer's, or one elsewhere the person added. Only they load in the app's windows. */
  const here = (contents: { id: number }, url: string) => {
    const remote = coreOf(contents);
    if (!remote) return !whose.has(contents.id) && local(url);
    try {
      const target = new URL(url), host = new URL(remote.address);
      return host.hostname === target.hostname && host.protocol === target.protocol;
    } catch { return false; }
  };
  let localPages: { desktop: string; pagesPort: number } | undefined;
  // Vindu issues a separate origin for each task and app on its own page server.
  const taskFrame = (url: string, parent: string | undefined) => {
    if (!localPages || !parent) return false;
    try {
      const target = new URL(url);
      return new URL(parent).origin === localPages.desktop && target.protocol === 'http:'
        && target.port === String(localPages.pagesPort) && /^(?:app-)?[0-9a-f]{16}\.localhost$/.test(target.hostname);
    } catch { return false; }
  };
  /** Any other page: in the person's own browser (web addresses only). */
  const elsewhere = (url: string) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); };
  const windows: BrowserWindowConstructorOptions = { width: 1440, height: 900, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } };
  /** A window brought forward: a minimized one shown and focused once it is restored, after the system's own animation. */
  const forward = (w: BrowserWindow) => {
    if (w.isMinimized()) { w.once('restore', () => { if (!w.isDestroyed()) { w.show(); w.focus(); } }); w.restore(); return; }
    w.show(); w.focus();
  };

  /** Each app's window, by its core and the app's id: the one a grid opened for it (window.open(…, 'vindu-app-<id>')), or a link. */
  const apps = new Map<string, BrowserWindow>();
  const appIn = (frameName: string, opener: { id: number }) => { const id = /^vindu-app-([\w-]+)$/.exec(frameName)?.[1]; return id ? `${whose.get(opener.id) ?? 'here'}|${id}` : undefined; };
  const windowOf = (id: string | undefined) => { const w = id === undefined ? undefined : apps.get(id); return w && !w.isDestroyed() ? w : undefined; };
  const keep = (id: string, w: BrowserWindow) => { apps.set(id, w); w.once('closed', () => { if (apps.get(id) === w) apps.delete(id); }); };

  /** The shell's window: the one open, brought forward, or a new one; hash: what it is told in its address (a link). */
  const gridWith = (hash = '') => {
    if (!core) return;
    if (grid && !grid.isDestroyed()) { if (hash) void grid.webContents.loadURL(`${core.url}${hash}`).catch(() => undefined); forward(grid); return; }
    grid = new BrowserWindow({ ...windows, width: 1280, height: 820 });
    link?.mark(grid, 'local');
    void grid.loadURL(`${core.url}${hash}`);
  };
  const showGrid = () => gridWith();
  /** A core elsewhere's grid, in its own window; its link to this app, from then on. */
  const grids = new Map<string, BrowserWindow>();
  const showElsewhere = (id: string, hash = '') => {
    const was = grids.get(id); if (was && !was.isDestroyed()) { if (hash) void was.webContents.loadURL(`${cores.shell(id)}${hash}`).catch(() => undefined); forward(was); return; }
    if (link && !linked.has(id)) linked.set(id, link.attach(cores.linkAt(id), id));
    const w = new BrowserWindow({ ...windows, width: 1100, height: 760 }); grids.set(id, w); whose.set(w.webContents.id, id); link?.mark(w, id);
    w.once('closed', () => { if (grids.get(id) === w) grids.delete(id); });
    void w.loadURL(`${cores.shell(id)}${hash}`).catch(() => undefined);
  };
  /** The core elsewhere whose window was in front last, or the first added: where a client's links go. */
  let front: string | undefined;
  const lastElsewhere = () => { const all = cores.list(); return (all.find(c => c.id === front) ?? all[0])?.id; };
  /** The app opened again (its Dock icon, or started again with no link): this computer's grid; in a client, its cores
   *  elsewhere, each in its window, or the window to add one when it has none. */
  const reopen = () => {
    if (!client) { showGrid(); return; }
    if (!up) return;
    const all = cores.list(); if (!all.length) { openAdd(); return; }
    for (const c of all) showElsewhere(c.id);
  };
  /** A core elsewhere taken off: its link, its windows, and its token. */
  const removeElsewhere = (id: string) => {
    linked.get(id)?.close(); linked.delete(id);
    for (const w of BrowserWindow.getAllWindows()) if (whose.get(w.webContents.id) === id) w.close();
    cores.remove(id); menu();
  };
  /** The window where the person adds a core elsewhere: a form whose answer the app takes before it loads (add-core.ts). */
  let adding: BrowserWindow | undefined;
  const openAdd = () => {
    if (adding && !adding.isDestroyed()) { forward(adding); return; }
    const w = adding = new BrowserWindow({ ...windows, width: 500, height: 480, title: 'Add a core' });
    void w.loadURL(addCorePage());
    w.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(ADD_SCHEME)) return;
      e.preventDefault();
      const q = new URL(url).searchParams, address = q.get('address') ?? '', name = q.get('name') ?? '';
      void cores.add(address, q.get('code') ?? '', name).then(c => {
        menu(); void w.loadURL(addCorePage({ said: `${c.name} is added: it opens now, and from the menu bar from now on.`, done: true })); showElsewhere(c.id);
      }, (err: Error) => { void w.loadURL(addCorePage({ address, name, said: err.message })); });
    });
  };
  /** A core elsewhere out of reach, in its window: said, and its page tried again every few seconds; the work stays there. */
  const outOfReach = (name: string) => `data:text/html;base64,${Buffer.from(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${name.replace(/[<>&"]/g, '')}: out of reach</title><body style="font:15px system-ui,sans-serif;padding:32px;color:#898781;background:light-dark(#fcfcfb,#1a1a19);color-scheme:light dark"><b>${name.replace(/[<>&"]/g, '')}</b> is out of reach. vindu tries again every few seconds; nothing is lost, the work stays there.</body>`).toString('base64')}`;

  /** A link (links.ts): its app's tab in the shell's window, told by the shell's address, which opens it with the link in
   *  its address's fragment (shell-page.ts); or its window, when it was popped out to one, at the address it is at with
   *  the link in its fragment. A link that is no link of the app's, or names no app on the grid: the shell comes forward,
   *  and nothing else. In a client, the same in the shell of the core elsewhere in front last; with none yet, the window
   *  to add one comes forward. */
  const take = async (l: string) => {
    if (client ? !up : !core) { waiting.push(l); return; }
    const id = appOf(l);
    if (id === 'add-core') { openAdd(); return; } // vindu://add-core: the window to add a core elsewhere
    const to = client ? lastElsewhere() : 'here'; if (!to) { openAdd(); return; }
    const show = (hash = '') => (to === 'here' ? gridWith(hash) : showElsewhere(to, hash));
    if (!id) { console.error('vindu: a link that names no app opens the grid'); show(); return; }
    const out = windowOf(`${to}|${id}`), at = out?.webContents.getURL() ?? ''; // popped out to a window of its own: there
    if (out && (to === 'here' ? local(at) : cores.of(at)?.id === to)) { void out.webContents.loadURL(withLink(at, l)).catch(() => undefined); forward(out); return; }
    show(`#${new URLSearchParams({ open: id, link: l })}`); // its tab: the shell opens it, or tells nothing for an app not on its grid
  };

  const menu = () => tray?.setContextMenu(Menu.buildFromTemplate([
    ...(client ? [] : [ // a client has no core here: its cores elsewhere only
      { label: core ? `vindu is running${core.owned ? '' : ', started elsewhere'}` : stopped ? `vindu stopped (${stopped})` : 'vindu is starting…', enabled: false },
      { label: 'Open', enabled: !!core, click: showGrid },
    ] satisfies MenuItemConstructorOptions[]),
    ...cores.list().map(c => ({ label: `Open ${c.name}`, click: () => showElsewhere(c.id) } satisfies MenuItemConstructorOptions)),
    { label: 'Add a core elsewhere…', click: openAdd },
    ...(cores.list().length ? [{ label: 'Remove a core elsewhere', submenu: cores.list().map(c => ({ label: c.name, click: () => removeElsewhere(c.id) })) } satisfies MenuItemConstructorOptions] : []),
    ...(stopped ? [{ label: 'Start it again', click: () => void start() } satisfies MenuItemConstructorOptions] : []),
    ...(newer && updates ? [{ label: `Update to vindu ${newer}, and restart`, click: () => updates?.install() } satisfies MenuItemConstructorOptions] : []),
    { type: 'separator' },
    // at login: the app as installed, never a build being worked on (its Electron would start at login)
    ...(app.isPackaged ? [{ label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) } satisfies MenuItemConstructorOptions] : []),
    { label: 'Quit vindu', click: () => app.quit() },
  ]));

  const start = async () => {
    if (client) { up = true; menu(); if (waiting.length) for (const l of waiting.splice(0)) void take(l); else reopen(); return; } // no core here to start
    stopped = ''; menu();
    try { core = await startCore({ ...(link ? { link } : {}), onExit: why => { core = undefined; stopped = why; menu(); } }); }
    catch (e) { stopped = String((e as Error).message ?? e); menu(); return; }
    localPages = undefined;
    try {
      const response = await fetch(new URL('control', core.url), { method: 'POST', redirect: 'error', body: JSON.stringify({ do: 'frame-origins' }), signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const settings = await response.json();
        if (typeof settings?.desktop === 'string' && Number.isInteger(settings.pagesPort)) localPages = settings;
      }
    } catch { /* Older cores still serve the ordinary desktop. */ }
    menu();
    if (waiting.length) for (const l of waiting.splice(0)) void take(l); else showGrid();
  };

  // every window of the app's: its key, on its pages' sockets to the core, for the core to lay a pane's page over its pane there
  app.on('browser-window-created', (_e, win) => {
    // a core elsewhere's window says whose it is
    const page = win.webContents.id; win.once('closed', () => whose.delete(page));
    win.on('page-title-updated', (e, title) => { const c = coreOf(win.webContents); if (c) { e.preventDefault(); win.setTitle(`${title} — ${c.name}`); } });
  });
  // the core elsewhere in front last: a client's links go there
  app.on('browser-window-focus', (_e, win) => { const id = whose.get(win.webContents.id); if (id) front = id; });
  // every page of the core's: a window it opens is one of the core's pages (an app, the keys) in a window of the app's
  // own, or any other page in the person's browser; where it goes, the same; and no page embeds a page of its own
  // (<webview>). A browser view's page, in a session of its own, is the link's to look after.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.session !== session.defaultSession) return;
    wc.setWindowOpenHandler(({ url, frameName }) => {
      // the shell's word that an app popped out is to come forward (shell-page.ts): its window, and no new one
      const ahead = /^vindu-forward-([\w-]+)$/.exec(frameName)?.[1];
      if (ahead) { const w = windowOf(`${whose.get(wc.id) ?? 'here'}|${ahead}`); if (w) forward(w); return { action: 'deny' }; }
      // a page first opens it blank, then sends it on; for an app whose window is open already (a link's, or a grid's
      // before this one), that one comes forward, and this one, never shown, closes at once (a page that may not open
      // it would tell the person their pop-ups are blocked). A window stays when the page that opened it closes, as a
      // browser's tab does: an app's window when the grid's closes.
      if (url === '' || url === 'about:blank' || here(wc, url)) return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: windowOf(appIn(frameName, wc)) ? { ...windows, show: false } : windows };
      elsewhere(url); return { action: 'deny' };
    });
    wc.on('did-create-window', (win, { frameName }) => {
      const from = whose.get(wc.id); if (from) whose.set(win.webContents.id, from); // a core elsewhere's page opened it: that core's
      link?.mark(win, from ?? 'local');
      const id = appIn(frameName, wc), was = windowOf(id); if (!id) return;
      if (was && was !== win) { win.destroy(); forward(was); } else keep(id, win);
    });
    const away = (e: { preventDefault(): void }, url: string) => { if (!here(wc, url)) { e.preventDefault(); elsewhere(url); } };
    wc.on('will-navigate', away);
    wc.on('will-redirect', details => {
      if (!details.isMainFrame && !whose.has(wc.id) && taskFrame(details.url, details.frame?.parent?.url)) return;
      away(details, details.url);
    });
    // an app's page in the shell's frame, going to another site: that page in the person's browser, the frame as it is
    wc.on('will-frame-navigate', d => { if (!d.isMainFrame && !here(wc, d.url) && (whose.has(wc.id) || !taskFrame(d.url, d.frame?.parent?.url)) && /^https?:/i.test(d.url)) { d.preventDefault(); elsewhere(d.url); } });
    wc.on('will-attach-webview', e => e.preventDefault());
    // a core elsewhere out of reach: said in its window, and tried again
    wc.on('did-fail-load', (_e, code, what, url, main) => {
      const c = main && code !== -3 ? coreOf(wc) : undefined; if (!c) return; // -3: a load called off, not a failure
      console.error(`vindu: ${c.name} is out of reach (${what}): tried again in a few seconds`);
      void wc.loadURL(outOfReach(c.name)).catch(() => undefined);
      setTimeout(() => { if (!wc.isDestroyed() && wc.getURL().startsWith('data:')) void wc.loadURL(url).catch(() => undefined); }, 5000);
    });
  });
  // nothing a page could ask the person for: copying to the clipboard and a video's full screen only
  const may = new Set(['clipboard-sanitized-write', 'fullscreen']);
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, answer) => answer(may.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => may.has(permission));
    tray = new Tray(trayIcon()); tray.setToolTip('vindu');
    if (process.platform !== 'darwin') tray.on('click', reopen); // a Mac's menu bar shows the menu
    link = await startLink().catch(e => { console.error(`vindu: no link for the core (${String((e as Error)?.message ?? e)}): its pages are pictured, as in a browser`); return undefined; });
    await start();
    updates = watchUpdates({ onNewer: v => { newer = v; menu(); } }); // the app as installed only, once its core is up (or would not start)
  });
  app.on('will-quit', () => link?.close());
  app.on('open-url', (e, url) => { e.preventDefault(); void take(url); }); // a Mac's links: at a start too, before the core is up
  app.on('second-instance', (_e, argv) => { const l = linkIn(argv); if (l) void take(l); else reopen(); });
  app.on('activate', reopen); // a Mac's Dock icon, clicked
  app.on('window-all-closed', () => undefined); // the core goes on, in the menu bar
  // Quit: the core this app started stops first, with all it started; one started elsewhere goes on
  app.on('before-quit', e => {
    if (quitting || !core?.owned) return;
    e.preventDefault(); quitting = true;
    void core.stop().finally(() => app.quit());
  });
}
