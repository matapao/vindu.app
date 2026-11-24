// The desktop app as the person meets it, driven by Playwright's Electron (playwright-core). It starts this computer's
// core, here on a port and in a folder of the test's own (the person's own core, and their data, stay as they are), and
// opens the shell in its one window. A click on an app opens it in a tab of the shell's there, the same tab on a second
// click, its page kept as it is while the grid is in front; an app popped out goes to a window of its own. A page of
// another site opens in the person's browser (here, a list the test keeps), never in a window or a frame of the app's.
// Every window closed, the core goes on; Quit stops it. A core running already (from a terminal) is used, and left
// running as the app quits; a second start of the app leaves at once, and the first comes forward. Its windows show on
// the screen while it runs:
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
const FRAME = path.join(import.meta.dirname, '..', '..'), CORE = path.join(FRAME, '..', 'dist', 'src', 'main.js');
const PORT = 17800;
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
const data = tmp('frame-core-'), frameData = tmp('frame-app-');
const env = launchEnv({ VINDU_PORT: String(PORT), VINDU_USER_DATA: data, VINDU_FRAME_DATA: frameData });
const launch = () => electron.launch({ executablePath: ELECTRON, args: [FRAME], env });
const windows = (a: ElectronApplication) => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const quit = async (a: ElectronApplication) => { const closed = a.waitForEvent('close', { timeout: 30_000 }); await a.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => undefined); await closed; };
const tile = (id: string) => `#grid .app[data-app="${id}"]`;
const ADDRESS = /^http:\/\/localhost:(\d+)\/([\w-]{20,})\/$/;

let code = 1;
const terminal: { kill?: () => void } = {};
try {
  // the app starts the core, and opens the grid in its window
  const app = await launch();
  const grid = await app.firstWindow();
  await grid.waitForURL(ADDRESS, { timeout: 60_000 });
  const shellAt = `http://localhost:${PORT}/${JSON.parse(fs.readFileSync(path.join(data, 'pages.json'), 'utf8')).shell}/`;
  check(grid.url() === shellAt && await answers(PORT), 'the app starts this computer\'s core and opens its grid in a window of its own, at the shell\'s address');
  await grid.waitForSelector(`${tile('desktop')} img`);
  check((await grid.$$eval('#grid .app span', s => s.map(x => x.textContent))).join() === 'Vindu', 'the grid, as in a browser: Vindu (Desktop)');
  // an app, in a tab of the shell's one window
  const frameAt = (port: number) => grid.frames().find(f => f !== grid.mainFrame() && ADDRESS.test(f.url()) && Number(ADDRESS.exec(f.url())![1]) === port);
  const tabs = () => grid.$$eval('.tab', t => t.map(x => `${(x as HTMLElement).dataset.app}${x.getAttribute('aria-selected') === 'true' ? '*' : ''}`).join());
  await grid.click(tile('desktop'));
  const desk = await until(() => frameAt(PORT + 1), 'Desktop, in its tab');
  await desk.waitForSelector('#prompt', { timeout: 30_000 });
  check(await tabs() === 'desktop*' && await grid.title() === 'Vindu' && await windows(app) === 1, 'a click on Desktop opens it in a tab of the shell\'s window, at its address, and the window says which app is in front');
  await desk.evaluate(() => { (window as unknown as { kept: string }).kept = 'this page'; });
  await grid.click('#home'); await grid.click(tile('desktop')); await sleep(600);
  check(await windows(app) === 1 && await tabs() === 'desktop*' && frameAt(PORT + 1) === desk && await desk.evaluate(() => (window as unknown as { kept?: string }).kept) === 'this page', 'clicked again: its tab, not another, its page as it was');
  // another site, from a tab's page in a frame of the shell's window: in the person's browser
  await app.evaluate(({ shell }) => { const opened: string[] = []; (globalThis as { opened?: string[] }).opened = opened; shell.openExternal = async (url: string) => { opened.push(url); }; });
  await desk.evaluate(() => { window.open('https://example.com/a'); });
  // popped out: a window of its own, its tab gone
  const [popped] = await Promise.all([app.waitForEvent('window'), grid.click('.tab[data-app="desktop"] button[title$="window of its own"]')]);
  await popped.waitForURL(ADDRESS, { timeout: 30_000 });
  await popped.waitForSelector('#prompt', { timeout: 30_000 });
  check(await windows(app) === 2 && await tabs() === '' && Number(ADDRESS.exec(popped.url())![1]) === PORT + 1, 'popped out: Desktop in a window of its own beside the shell\'s, its tab gone');
  // another site, from that window: in the person's browser, never in a window or a frame of the app's
  await popped.evaluate(() => { window.open('https://example.com/b'); });
  await popped.evaluate(() => { location.href = 'https://example.com/c'; }).catch(() => undefined);
  await sleep(600);
  const opened = await app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);
  check(opened.join() === 'https://example.com/a,https://example.com/b,https://example.com/c' && await windows(app) === 2 && ADDRESS.test(popped.url()),
    'another site\'s page opens in the person\'s browser, from a tab or a window: it opens no window of the app\'s, and nothing of the app\'s goes there');
  // every window closed: the core goes on; Quit: it stops
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
  await until(async () => (await windows(app)) === 0, 'every window closed');
  await sleep(500);
  check(await answers(PORT), 'every window closed: the core goes on, in the menu bar');
  await quit(app);
  await until(async () => !(await answers(PORT)), 'the core stopped', 30_000);
  check(true, 'Quit stops the core it started');

  // a core running already, started in a terminal: the app uses it, and leaves it running
  const running = spawn(process.execPath, [CORE, '--no-open'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  terminal.kill = () => running.kill('SIGTERM');
  let said = ''; running.stdout!.on('data', d => { said += d; });
  await until(() => /^vindu: http/m.test(said), 'the core, from a terminal', 60_000);
  const app2 = await launch();
  const grid2 = await app2.firstWindow();
  await grid2.waitForURL(ADDRESS, { timeout: 30_000 });
  check(grid2.url() === shellAt, 'a core running already, started in a terminal: the app opens its grid');
  // a second start of the app: it leaves at once, and the first is the one there
  const second = spawn(ELECTRON, [FRAME], { env, stdio: 'ignore' });
  const exit = await new Promise<number | null>(r => { const t = setTimeout(() => { second.kill(); r(null); }, 15_000); second.once('exit', c => { clearTimeout(t); r(c); }); });
  check(exit === 0 && await windows(app2) === 1, 'started again, the app leaves at once: the first one comes forward');
  await quit(app2);
  await sleep(500);
  check(await answers(PORT), 'the app quits, and the core started in the terminal goes on');
  running.kill('SIGTERM');
  await until(async () => !(await answers(PORT)), 'the terminal\'s core stopped', 30_000);
  terminal.kill = undefined;
  console.log(`# ${passed} passed`);
  code = 0;
} catch (e) { console.log(String((e as Error)?.stack ?? e)); } finally {
  terminal.kill?.();
  await sleep(300);
  for (const d of [data, frameData]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(code);
}
