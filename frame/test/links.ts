// Links in the desktop app, driven by Playwright's Electron: vindu://<app>/<rest> opens that app's tab in the shell's one
// window, as a click on the grid does, with the link in its address's fragment (#vindu-link=…), whichever way the link
// comes: among the app's arguments as it starts (as Windows and Linux give it), as a Mac gives it (open-url, emitted
// here), or among a second start's arguments (second-instance). The page there stays as it is: a fragment loads nothing,
// and the page hears it change. A link to an app not on the grid, or one that is no link of the app's: the shell's window
// comes forward, and nothing else. An app popped out to a window of its own takes its links there, and a click on the
// grid brings that window forward. No scheme is registered on this computer for it: the links are given to the app as a
// system would.
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

// the core's folder, and the app's
const data = tmp('frame-links-core-'), frameData = tmp('frame-links-app-');
const env = launchEnv({ VINDU_PORT: String(PORT), VINDU_USER_DATA: data, VINDU_FRAME_DATA: frameData });
const ADDRESS = /^http:\/\/localhost:(\d+)\/([\w-]{20,})\/(#.*)?$/;
const linked = (url: string, link: string) => url.endsWith(`/#vindu-link=${encodeURIComponent(link)}`) && ADDRESS.test(url);
const tile = (id: string) => `#grid .app[data-app="${id}"]`;

let code = 1, app: ElectronApplication | undefined;
try {
  // started by a link (as Windows and Linux start it): the core, then the shell's window with that app's tab in front
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
  const shell = await a.firstWindow();
  // Drive the fixture through Playwright. Native input belongs to the person using the Mac.
  await a.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setIgnoreMouseEvents(true);
      window.webContents.on('before-input-event', (event) => event.preventDefault());
    }
  });
  const shellAt = () => `http://localhost:${PORT}/${JSON.parse(fs.readFileSync(path.join(data, 'pages.json'), 'utf8')).shell}/`;
  /** The app open in the shell's window at that port: its frame. */
  const frameAt = (port: number) => shell.frames().find(f => f !== shell.mainFrame() && ADDRESS.test(f.url()) && Number(ADDRESS.exec(f.url())![1]) === port);
  const tabs = () => shell.$$eval('.tab', t => t.map(x => `${(x as HTMLElement).dataset.app}${x.getAttribute('aria-selected') === 'true' ? '*' : ''}`).join());
  const desk = await until(() => { const f = frameAt(PORT + 1); return f && linked(f.url(), first) ? f : undefined; }, 'Desktop\'s tab, with the link', 60_000);
  check(shell.url().startsWith(shellAt()) && await tabs() === 'desktop*' && (await shown()).length === 1 && await answers(PORT),
    'started by a link to Desktop, the app starts the core and opens the shell\'s window with Desktop\'s tab in front, the link in its address\'s fragment');

  // a Mac's link (open-url) to the same app: the window brought forward, the page as it was, the link its fragment now
  await desk.evaluate(() => { const w = window as unknown as { kept: string; heard: string[] }; w.kept = 'this page'; w.heard = []; addEventListener('hashchange', () => w.heard.push(location.hash)); });
  await minimize(PORT);
  const again = 'vindu://desktop/again?x=1';
  await openUrl(again);
  await until(() => linked(desk.url(), again), 'the second link, in Desktop\'s address');
  await forwardAgain(PORT, 'the window, forward again');
  const heard = await desk.evaluate(() => { const w = window as unknown as { kept?: string; heard?: string[] }; return { kept: w.kept, heard: w.heard }; });
  check(heard.kept === 'this page' && heard.heard?.join() === `#vindu-link=${encodeURIComponent(again)}` && (await shown()).length === 1 && !shell.url().includes('#'),
    'a Mac\'s link to the same app: the window comes forward, the same page (not loaded again), which hears the link as its fragment changes');

  // a second start with a link (second-instance): it leaves at once, and the first takes the link, in the same page
  const enroll = 'vindu://desktop/enroll?code=SYN-4417';
  await startAgain(enroll);
  await until(() => linked(desk.url(), enroll), 'the link of the second start, in Desktop\'s address');
  const kept = await desk.evaluate(() => { const w = window as unknown as { kept?: string; heard?: string[] }; return { kept: w.kept, heard: w.heard }; });
  check(kept.kept === 'this page' && kept.heard?.at(-1) === `#vindu-link=${encodeURIComponent(enroll)}` && await tabs() === 'desktop*' && (await shown()).length === 1,
    'a second start with a link leaves at once; the first takes it in Desktop\'s tab, the same page, in the same window');

  // An unknown app reaches the grid, which consumes the fragment and keeps the selected tab.
  // Other malformed inputs are parser cases, covered without opening a window in link-routing.ts.
  const unknown = 'vindu://no-such-app/x';
  await Promise.all([
    shell.waitForURL(url => new URLSearchParams(url.hash.slice(1)).get('link') === unknown, { waitUntil: 'commit' }),
    openUrl(unknown),
  ]);
  await shell.waitForURL(shellAt(), { waitUntil: 'commit' });
  check((await shown()).length === 1, 'an unknown app leaves one native window');
  check(await tabs() === 'desktop*', 'an unknown app preserves the selected tab');
  check(linked(desk.url(), enroll), 'an unknown app preserves the Desktop link');

  // Desktop popped out to a window of its own: a link to it goes there, the same page; the grid's click brings it forward
  const [popped] = await Promise.all([a.waitForEvent('window', { timeout: 30_000 }), shell.click('.tab[data-app="desktop"] button[title$="window of its own"]')]);
  await popped.waitForURL(ADDRESS, { timeout: 30_000 });
  await popped.waitForSelector('#prompt', { timeout: 30_000 });
  check((await shown()).length === 2 && await tabs() === '' && Number(ADDRESS.exec(popped.url())![1]) === PORT + 1, 'popped out: Desktop in a window of its own, its tab gone from the shell\'s');
  const later = 'vindu://desktop/later?code=SYN-5521';
  await popped.evaluate(() => { (window as unknown as { kept: string }).kept = 'this page'; });
  await openUrl(later);
  await until(() => linked(popped.url(), later), 'the link, in its window');
  check((await shown()).length === 2 && await tabs() === '' && await popped.evaluate(() => (window as unknown as { kept?: string }).kept) === 'this page',
    'a link to an app popped out goes to its window, the same page, and opens no tab');
  await shell.click('#home');
  await minimize(PORT + 1);
  await shell.click(tile('desktop'));
  await forwardAgain(PORT + 1, 'Desktop\'s window, forward from the grid');
  check((await shown()).length === 2 && await tabs() === '' && await shell.isHidden('#note'), 'a click on the grid on an app popped out brings its window forward, and opens no tab');

  // Quit: the core stops
  const closed = a.waitForEvent('close', { timeout: 30_000 });
  await a.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => undefined);
  await closed; app = undefined;
  await until(async () => !(await answers(PORT)), 'the core stopped', 30_000);
  check(true, 'Quit stops the core');
  console.log(`# ${passed} passed`);
  code = 0;
} catch (e) { console.log(String((e as Error)?.stack ?? e)); } finally {
  await app?.close().catch(() => undefined);
  await sleep(300);
  for (const d of [data, frameData]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(code);
}
