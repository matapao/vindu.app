// Links in the Electron app, driven by Playwright's Electron: vindu://desktop/<rest> opens Desktop's one window with the
// link in its address's fragment (#vindu-link=…), whichever way the link comes: among the app's arguments as it starts (as
// Windows and Linux give it), as a Mac gives it (open-url, emitted here), or among a second start's arguments
// (second-instance). The page there stays as it is: a fragment loads nothing, and the page hears it change. A link that
// names no window of the app's, or is no link of the app's: Desktop's window comes forward, and nothing else. No scheme
// is registered on this computer for it: the links are given to the app as a system would.
// On ports and in folders of the test's own; its windows show on the screen:
//   pnpm build (in vindu, then here), then pnpm test here
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { launchEnv } from './launch-env.js';

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string; // the package gives its program's path
const FRAME = path.join(import.meta.dirname, '..', '..');
const PORT = 17900;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const check = (cond: unknown, what: string) => { if (!cond) throw new Error(`not ok: ${what}`); console.log(`ok ${++passed} - ${what}`); };
async function until<T>(f: () => Promise<T> | T, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); }
}
const answers = (port: number) => new Promise<boolean>(r => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });

// the server's folder, and the app's
const data = tmp('frame-links-server-'), frameData = tmp('frame-links-app-');
const env = launchEnv({ VINDU_PORT: String(PORT), VINDU_USER_DATA: data, VINDU_FRAME_DATA: frameData });
const ADDRESS = /^http:\/\/localhost:(\d+)\/([\w-]{20,})\/(#.*)?$/;
const linked = (url: string, link: string) => url.endsWith(`/#vindu-link=${encodeURIComponent(link)}`) && ADDRESS.test(url);

let code = 1, app: ElectronApplication | undefined;
try {
  // started by a link (as Windows and Linux start it): the server, then Desktop's window with the link
  const first = 'vindu://desktop/open?task=t-0412&note=a%20b';
  app = await electron.launch({ executablePath: ELECTRON, args: [FRAME, first], env });
  const a = app;
  /** The app's windows: each one's address, and whether it is shown, and minimized. */
  const shown = () => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), visible: w.isVisible(), minimized: w.isMinimized() })));
  const windowAt = (port: number) => async () => (await shown()).find(w => { try { return new URL(w.url).port === String(port); } catch { return false; } });
  // Await native transitions, so the next link never races a minimize animation.
  const minimize = async (port: number) => {
    await a.evaluate(({ BrowserWindow }, port) => {
      const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith(`http://localhost:${port}/`));
      if (!window) throw new Error(`No test window on port ${port}`);
      if (window.isMinimized()) return;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Electron did not minimize the test window')), 30_000);
        window.once('minimize', () => { clearTimeout(timer); resolve(); });
        window.minimize();
      });
    }, port);
  };
  const forwardAgain = (port: number, what: string) => until(async () => {
    const window = await windowAt(port)();
    return window?.visible && !window.minimized;
  }, what);
  const openUrl = (link: string) => a.evaluate(({ app }, l) => { app.emit('open-url', { preventDefault() { /* taken */ } }, l); }, link);
  const startAgain = (link: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(ELECTRON, [FRAME, link], { env, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The second Electron process did not exit within 15 seconds'));
    }, 15_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`The second Electron process exited with ${signal ?? code}`));
    });
  });
  const desk = await a.firstWindow();
  // Drive the fixture through Playwright. Native input belongs to the person using the Mac.
  await a.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setIgnoreMouseEvents(true);
      window.webContents.on('before-input-event', (event) => event.preventDefault());
    }
  });
  const desktopAt = () => `http://localhost:${PORT}/${JSON.parse(fs.readFileSync(path.join(data, 'pages.json'), 'utf8')).desktop}/`;
  await until(() => linked(desk.url(), first), 'Desktop\'s window, with the link', 60_000);
  await desk.waitForSelector('#prompt', { timeout: 30_000 });
  check(desk.url().startsWith(desktopAt()) && (await shown()).length === 1 && await answers(PORT),
    'started by a link to Desktop, the app starts the server and opens Desktop\'s window, the link in its address\'s fragment');

  // a Mac's link (open-url): the window brought forward, the page as it was, the link its fragment now
  await desk.evaluate(() => { const w = window as unknown as { kept: string; heard: string[] }; w.kept = 'this page'; w.heard = []; addEventListener('hashchange', () => w.heard.push(location.hash)); });
  await minimize(PORT);
  const again = 'vindu://desktop/again?x=1';
  await openUrl(again);
  await until(() => linked(desk.url(), again), 'the second link, in Desktop\'s address');
  await forwardAgain(PORT, 'the window, forward again');
  const heard = await desk.evaluate(() => { const w = window as unknown as { kept?: string; heard?: string[] }; return { kept: w.kept, heard: w.heard }; });
  check(heard.kept === 'this page' && heard.heard?.join() === `#vindu-link=${encodeURIComponent(again)}` && (await shown()).length === 1,
    'a Mac\'s link: the window comes forward, the same page (not loaded again), which hears the link as its fragment changes');

  // a second start with a link (second-instance): it leaves at once, and the first takes the link, in the same page
  const enroll = 'vindu://desktop/enroll?code=SYN-4417';
  await startAgain(enroll);
  await until(() => linked(desk.url(), enroll), 'the link of the second start, in Desktop\'s address');
  const kept = await desk.evaluate(() => { const w = window as unknown as { kept?: string; heard?: string[] }; return { kept: w.kept, heard: w.heard }; });
  check(kept.kept === 'this page' && kept.heard?.at(-1) === `#vindu-link=${encodeURIComponent(enroll)}` && (await shown()).length === 1,
    'a second start with a link leaves at once; the first takes it in Desktop\'s window, the same page');

  // a link that names no window of the app's: Desktop's window comes forward, as it is. Other malformed inputs are
  // parser cases, covered without opening a window in link-routing.ts.
  await minimize(PORT);
  await openUrl('vindu://no-such-window/x');
  await forwardAgain(PORT, 'Desktop\'s window, forward for an unknown window');
  check((await shown()).length === 1 && linked(desk.url(), enroll) && await desk.evaluate(() => (window as unknown as { kept?: string }).kept) === 'this page',
    'a link to no window of the app\'s brings Desktop\'s window forward, its page and its link as they were');

  // Quit: the server stops
  const closed = a.waitForEvent('close', { timeout: 30_000 });
  await a.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => undefined);
  await closed; app = undefined;
  await until(async () => !(await answers(PORT)), 'the server stopped', 30_000);
  check(true, 'Quit stops the server');
  console.log(`# ${passed} passed`);
  code = 0;
} catch (e) { console.log(String((e as Error)?.stack ?? e)); } finally {
  await app?.close().catch(() => undefined);
  await sleep(300);
  for (const d of [data, frameData]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(code);
}
