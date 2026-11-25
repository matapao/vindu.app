// The Electron app: Desktop's window on this computer. It starts the app's own server process, as `pnpm start` does, and
// keeps it while the person works, in the menu bar; or it uses one running already on this computer (started in a
// terminal), and leaves it running. It shows Desktop's page, the same a browser shows, in one window; another of the
// server's pages Desktop opens (the keys page) comes in a window of its own. A link (vindu://desktop/…, links.ts) comes
// to Desktop's window, in its address's fragment (#vindu-link=…), which loads nothing: the page as it is hears it.
// The server it starts has its link (link.ts): that server's browser views' pages live here, each a page of its own laid
// over its pane, where a browser's tab shows pictures of a page the server drives in its own Chromium.
// Only the server's pages load in its windows (this computer's loopback); any other page opens in the person's browser,
// and no page gets the camera, the microphone, location or notifications. Every window is sandboxed, with no Node and no
// preload. Closing every window leaves the server running, for reminders and jobs; Quit stops it, and all it started.
import { app, BrowserWindow, Menu, session, shell, Tray, type BrowserWindowConstructorOptions, type MenuItemConstructorOptions } from 'electron';
import { trayIcon } from './icon.js';
import { startLink, type Link } from './link.js';
import { linkIn, windowOf, withLink } from './links.js';
import { startServer, type AppServer } from './server.js';
import { watchUpdates, type Updates } from './update.js';

if (process.env.VINDU_FRAME_DATA) app.setPath('userData', process.env.VINDU_FRAME_DATA); // a test's own, or a second app's
app.enableSandbox();
// one app at a time: started again, the first comes forward (or takes the link the second was started by), and the second leaves
if (!app.requestSingleInstanceLock()) app.quit();
else frame();

function frame() {
  let server: AppServer | undefined, tray: Tray | undefined, desktop: BrowserWindow | undefined, link: Link | undefined, updates: Updates | undefined;
  let stopped = '', newer = '', quitting = false;
  /** Links that came before the server was up: the one the app was started by (in its arguments on Windows and Linux; on
   *  a Mac, as an event of its own), taken once the server is, in place of opening Desktop plain. */
  const waiting: string[] = [];
  const started = linkIn(process.argv); if (started) waiting.push(started);
  /** Whether a page is the server's: on this computer's loopback. Only they load in the app's windows. */
  const local = (url: string) => { try { const u = new URL(url); return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'); } catch { return false; } };
  let localPages: { desktop: string; pagesPort: number } | undefined;
  // Vindu gives each task's pages, and each MCP App, an origin of its own on its page server.
  const taskFrame = (url: string, parent: string | undefined) => {
    if (!localPages || !parent) return false;
    try {
      const target = new URL(url);
      return new URL(parent).origin === localPages.desktop && target.protocol === 'http:'
        && target.port === String(localPages.pagesPort) && /^(?:app-[0-9a-f]{32}|work-[0-9a-f]{32}(?:-[0-9a-f]{24})?|[0-9a-f]{32})\.localhost$/.test(target.hostname);
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

  /** Desktop: its window, the one open brought forward, or a new one; with a link, in its address's fragment. */
  const showDesktop = (l?: string) => {
    if (!server) return;
    const at = l ? withLink(server.url, l) : server.url;
    if (desktop && !desktop.isDestroyed()) { if (l) void desktop.webContents.loadURL(at).catch(() => undefined); forward(desktop); return; }
    desktop = new BrowserWindow({ ...windows, width: 1280, height: 820 });
    link?.mark(desktop);
    void desktop.loadURL(at);
  };

  /** A link (links.ts): Desktop's window, with the link in its address's fragment (a fragment loads nothing, and the
   *  page hears it). A link that names no window of the app's, or is no link of the app's: Desktop's window comes
   *  forward, and nothing else. */
  const take = (l: string) => {
    if (!server) { waiting.push(l); return; }
    const given = windowOf(l) === 'desktop' ? l : undefined;
    if (!given) console.error('vindu: a link that names no window of vindu\'s opens Desktop as it is');
    showDesktop(given);
  };

  const menu = () => tray?.setContextMenu(Menu.buildFromTemplate([
    { label: server ? `vindu is running${server.owned ? '' : ', started outside the app'}` : stopped ? `vindu stopped (${stopped})` : 'vindu is starting…', enabled: false },
    { label: 'Open', enabled: !!server, click: () => showDesktop() },
    ...(stopped ? [{ label: 'Start it again', click: () => void start() } satisfies MenuItemConstructorOptions] : []),
    ...(newer && updates ? [{ label: `Update to vindu ${newer}, and restart`, click: () => updates?.install() } satisfies MenuItemConstructorOptions] : []),
    { type: 'separator' },
    // at login: the app as installed, never a build being worked on (its Electron would start at login)
    ...(app.isPackaged ? [{ label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) } satisfies MenuItemConstructorOptions] : []),
    { label: 'Quit vindu', click: () => app.quit() },
  ]));

  const start = async () => {
    stopped = ''; menu();
    try { server = await startServer({ ...(link ? { link } : {}), onExit: why => { server = undefined; stopped = why; menu(); } }); }
    catch (e) { stopped = String((e as Error).message ?? e); menu(); return; }
    localPages = undefined;
    try {
      const response = await fetch(new URL('control', server.url), { method: 'POST', redirect: 'error', body: JSON.stringify({ do: 'frame-origins' }), signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const settings = await response.json();
        if (typeof settings?.desktop === 'string' && Number.isInteger(settings.pagesPort)) localPages = settings;
      }
    } catch { /* Desktop shows all the same; a task's page stays in the frame it loaded in. */ }
    menu();
    if (waiting.length) for (const l of waiting.splice(0)) take(l); else showDesktop();
  };

  // every page of the server's: a window it opens is one of the server's pages (the keys page) in a window of the app's
  // own, or any other page in the person's browser; where it goes, the same; and no page embeds a page of its own
  // (<webview>). A browser view's page, in a session of its own, is the link's to look after.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.session !== session.defaultSession) return;
    wc.setWindowOpenHandler(({ url }) => {
      // a page first opens it blank, then sends it on (the keys page's tab); a window stays when the page that opened it
      // closes, as a browser's tab does
      if (url === '' || url === 'about:blank' || local(url)) return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: windows };
      elsewhere(url); return { action: 'deny' };
    });
    wc.on('did-create-window', win => { link?.mark(win); });
    const away = (e: { preventDefault(): void }, url: string) => { if (!local(url)) { e.preventDefault(); elsewhere(url); } };
    wc.on('will-navigate', away);
    wc.on('will-redirect', details => {
      if (!details.isMainFrame && taskFrame(details.url, details.frame?.parent?.url)) return;
      away(details, details.url);
    });
    // a frame of Desktop's page going to another site: that page in the person's browser, the frame as it is
    wc.on('will-frame-navigate', d => { if (!d.isMainFrame && !local(d.url) && !taskFrame(d.url, d.frame?.parent?.url) && /^https?:/i.test(d.url)) { d.preventDefault(); elsewhere(d.url); } });
    wc.on('will-attach-webview', e => e.preventDefault());
  });
  // nothing a page could ask the person for: copying to the clipboard and a video's full screen only
  const may = new Set(['clipboard-sanitized-write', 'fullscreen']);
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, answer) => answer(may.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => may.has(permission));
    tray = new Tray(trayIcon()); tray.setToolTip('vindu');
    if (process.platform !== 'darwin') tray.on('click', () => showDesktop()); // a Mac's menu bar shows the menu
    link = await startLink().catch(e => { console.error(`vindu: no link for the server (${String((e as Error)?.message ?? e)}): its pages are pictured, as in a browser`); return undefined; });
    await start();
    updates = watchUpdates({ onNewer: v => { newer = v; menu(); } }); // the app as installed only, once its server is up (or would not start)
  });
  app.on('will-quit', () => link?.close());
  app.on('open-url', (e, url) => { e.preventDefault(); take(url); }); // a Mac's links: at a start too, before the server is up
  app.on('second-instance', (_e, argv) => { const l = linkIn(argv); if (l) take(l); else showDesktop(); });
  app.on('activate', () => showDesktop()); // a Mac's Dock icon, clicked
  app.on('window-all-closed', () => undefined); // the server goes on, in the menu bar
  // Quit: the server this app started stops first, with all it started; one started outside the app goes on
  app.on('before-quit', e => {
    if (quitting || !server?.owned) return;
    e.preventDefault(); quitting = true;
    void server.stop().finally(() => app.quit());
  });
}
