// The Electron app as the person meets it, driven by Playwright's Electron (playwright-core). It starts the app's own
// server, here on a port and in a folder of the test's own (the person's own server, and their data, stay as they are),
// and opens Desktop in its window, the same window again when the app is opened again; the connector keys' page Desktop
// opens comes in a window of its own. A page of another site opens in the person's browser (here, a list the test keeps),
// never in a window or a frame of the app's.
// Every window closed, the server goes on; Quit stops it. A server running already (from a terminal) is used, and left
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
const FRAME = path.join(import.meta.dirname, '..', '..'), SERVER = path.join(FRAME, '..', 'dist', 'src', 'main.js');
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

// the server's folder, and the app's
const data = tmp('frame-server-'), frameData = tmp('frame-app-');
const env = launchEnv({ VINDU_PORT: String(PORT), VINDU_USER_DATA: data, VINDU_FRAME_DATA: frameData });
const launch = () => electron.launch({ executablePath: ELECTRON, args: [FRAME], env });
const windows = (a: ElectronApplication) => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const quit = async (a: ElectronApplication) => { const closed = a.waitForEvent('close', { timeout: 30_000 }); await a.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => undefined); await closed; };
const ADDRESS = /^http:\/\/localhost:(\d+)\/([\w-]{20,})\/$/;

let code = 1;
const terminal: { kill?: () => void } = {};
try {
  // the app starts the server, and opens Desktop in its window
  const app = await launch();
  const desk = await app.firstWindow();
  await desk.waitForURL(ADDRESS, { timeout: 60_000 });
  const desktopAt = `http://localhost:${PORT}/${JSON.parse(fs.readFileSync(path.join(data, 'pages.json'), 'utf8')).desktop}/`;
  await desk.waitForSelector('#prompt', { timeout: 30_000 });
  check(desk.url() === desktopAt && await answers(PORT) && await desk.title() === 'Vindu' && await windows(app) === 1, 'the app starts its own server and opens Desktop in a window of its own, at Desktop\'s address');
  // opened again (its Dock icon, the menu bar's Open): the same window, its page as it was
  await desk.evaluate(() => { (window as unknown as { kept: string }).kept = 'this page'; });
  await app.evaluate(({ app }) => { app.emit('activate'); });
  await sleep(600);
  check(await windows(app) === 1 && await desk.evaluate(() => (window as unknown as { kept?: string }).kept) === 'this page', 'opened again: the same window, its page as it was');
  // the connector keys: another page of the server's, which Desktop opens in a window of its own
  const [keys] = await Promise.all([app.waitForEvent('window'), desk.click('#connector-keys')]);
  await keys.waitForURL(new RegExp(`^http://localhost:${PORT + 1}/[\\w-]{20,}/$`), { timeout: 30_000 });
  check(await windows(app) === 2, 'the connector keys\' page, which Desktop opens, comes in a window of its own at its own address');
  // another site, from Desktop's page: in the person's browser, never in a window or a frame of the app's
  await app.evaluate(({ shell }) => { const opened: string[] = []; (globalThis as { opened?: string[] }).opened = opened; shell.openExternal = async (url: string) => { opened.push(url); }; });
  await desk.evaluate(() => { window.open('https://example.com/a'); });
  await desk.evaluate(() => { location.href = 'https://example.com/b'; }).catch(() => undefined);
  await sleep(600);
  const opened = await app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);
  check(opened.join() === 'https://example.com/a,https://example.com/b' && await windows(app) === 2 && desk.url() === desktopAt && await desk.evaluate(() => (window as unknown as { kept?: string }).kept) === 'this page',
    'another site\'s page opens in the person\'s browser: it opens no window of the app\'s, and Desktop stays as it was');
  // every window closed: the server goes on; Quit: it stops
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
  await until(async () => (await windows(app)) === 0, 'every window closed');
  await sleep(500);
  check(await answers(PORT), 'every window closed: the server goes on, in the menu bar');
  await quit(app);
  await until(async () => !(await answers(PORT)), 'the server stopped', 30_000);
  check(true, 'Quit stops the server it started');

  // a server running already, started in a terminal: the app uses it, and leaves it running
  const running = spawn(process.execPath, [SERVER, '--no-open'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  terminal.kill = () => running.kill('SIGTERM');
  let said = ''; running.stdout!.on('data', d => { said += d; });
  await until(() => /^vindu: http/m.test(said), 'the server, from a terminal', 60_000);
  const app2 = await launch();
  const desk2 = await app2.firstWindow();
  await desk2.waitForURL(ADDRESS, { timeout: 30_000 });
  check(desk2.url() === desktopAt, 'a server running already, started in a terminal: the app opens its Desktop');
  // a second start of the app: it leaves at once, and the first is the one there
  const second = spawn(ELECTRON, [FRAME], { env, stdio: 'ignore' });
  const exit = await new Promise<number | null>(r => { const t = setTimeout(() => { second.kill(); r(null); }, 15_000); second.once('exit', c => { clearTimeout(t); r(c); }); });
  check(exit === 0 && await windows(app2) === 1, 'started again, the app leaves at once: the first one comes forward');
  await quit(app2);
  await sleep(500);
  check(await answers(PORT), 'the app quits, and the server started in the terminal goes on');
  running.kill('SIGTERM');
  await until(async () => !(await answers(PORT)), 'the terminal\'s server stopped', 30_000);
  terminal.kill = undefined;
  console.log(`# ${passed} passed`);
  code = 0;
} catch (e) { console.log(String((e as Error)?.stack ?? e)); } finally {
  terminal.kill?.();
  await sleep(300);
  for (const d of [data, frameData]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(code);
}
