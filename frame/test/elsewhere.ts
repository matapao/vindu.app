// A core elsewhere in the desktop app : added by its address and a code made there, in the
// app's own window for it; its Desktop opened in a window of its own, with its name in its title, apart from this
// computer's; its browser views' pages living in the app, over the link the app gives it, as this
// computer's core's do; and out of reach, said in its window and tried again. With two cores of the test's own
// (core.ts): this computer's, which the app starts, and one the test starts on this computer at another port, as the
// app would reach a Pi's on the tailnet. Its windows show on the screen while it runs:
//   pnpm build (in vindu, then here), then node dist/test/elsewhere.js
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { launchEnv } from './launch-env.js';

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;
const FRAME = path.join(import.meta.dirname, '..', '..');
const HERE_PORT = 17840, ELSEWHERE_PORT = 17850;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const check = (cond: unknown, what: string) => { if (!cond) throw new Error(`not ok: ${what}`); console.log(`ok ${++passed} - ${what}`); };
async function until<T>(f: () => Promise<T> | T, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); }
}
type Listed = { name: string; live: boolean; casting: boolean };

/** The core "elsewhere": the test's own core, started by the test, at its own port and in its own folder. */
const otherData = tmp('frame-elsewhere-core-');
let other: ChildProcess | undefined = spawn(process.execPath, [path.join(import.meta.dirname, 'core.js')], { env: { ...process.env, VINDU_PORT: String(ELSEWHERE_PORT), VINDU_USER_DATA: otherData }, stdio: ['ignore', 'pipe', 'inherit'] });
const inspect = await until(() => { try { return (JSON.parse(fs.readFileSync(path.join(otherData, 'test-core.json'), 'utf8')) as { inspect: string }).inspect; } catch { return undefined; } }, 'the core elsewhere');
const ask = async <T>(p: string) => (await (await fetch(`${inspect}${p}`)).json()) as T;
const data = tmp('frame-here-core-'), frameData = tmp('frame-elsewhere-app-');
const env = launchEnv({ VINDU_PORT: String(HERE_PORT), VINDU_USER_DATA: data, VINDU_FRAME_DATA: frameData, VINDU_CORE: path.join(import.meta.dirname, 'core.js'), VINDU_FRAME_SECRETS: 'memory' });

let code = 1, app: ElectronApplication | undefined;
try {
  app = await electron.launch({ executablePath: ELECTRON, args: [FRAME], env });
  const said: string[] = []; // what the app and its core printed, for a failure to show
  app.process().stdout?.on('data', d => said.push(String(d))); app.process().stderr?.on('data', d => said.push(String(d)));
  process.on('exit', () => { if (code) console.log(`# the app said, at the end:\n${said.join('').split('\n').filter(l => /vindu/.test(l)).slice(-15).join('\n')}`); });
  const mine = await app.firstWindow(); // this computer's Desktop
  await mine.waitForURL(new RegExp(`^http://localhost:${HERE_PORT}/`), { timeout: 60_000 });
  const windowAt = (prefix: string) => until(() => app!.windows().find(w => w.url().startsWith(prefix)), `a window at ${prefix}`);
  const titleOf = (p: Page) => app!.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)?.getTitle() ?? '', p.url());

  // added: its address and a code made there, in the app's window for it (as the menu bar's Add a core elsewhere… opens it)
  const [add] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ app: a }) => { a.emit('open-url', { preventDefault() { /* taken */ } }, 'vindu://add-core'); })]);
  await add.waitForSelector('input[name="address"]');
  const made = await ask<string>('/code'); // made there, under Phone
  await add.fill('input[name="address"]', `http://127.0.0.1:${ELSEWHERE_PORT}`); await add.fill('input[name="code"]', made === '000000' ? '111111' : '000000'); await add.fill('input[name="name"]', 'The mini');
  await add.click('button');
  await until(async () => (await add.textContent('body'))?.includes('That is not the code'), 'a wrong code, said');
  check(!fs.existsSync(path.join(frameData, 'cores.json')), 'a wrong code is said in the window, and nothing is added');
  await add.fill('input[name="code"]', made);
  await add.click('button');
  await until(async () => (await add.textContent('body'))?.includes('The mini is added'), 'added');
  const elsewhere = await windowAt(`http://127.0.0.1:${ELSEWHERE_PORT}/`);
  await elsewhere.waitForSelector('#prompt');
  check(!elsewhere.url().includes((await ask<string>('/desktop')).split('/')[3]), 'paired by the code made there, its Desktop opens at this computer\'s own token there, not the core\'s');
  check((await until(async () => { const t = await titleOf(elsewhere); return t.endsWith('— The mini') ? t : undefined; }, 'its name in the title')).length > 0, 'its window says whose it is: The mini');
  const kept = fs.readFileSync(path.join(frameData, 'cores.json'), 'utf8');
  check(kept.includes('The mini') && !kept.includes(elsewhere.url().split('/')[3]), 'the app keeps the core, and its token only as the keychain encrypts it (a test\'s own store here)');

  // its Desktop, in a window of its own, apart from this computer's; a page of a task there living in the app
  await mine.waitForSelector('#prompt');
  await until(async () => (await titleOf(elsewhere)).startsWith('Vindu'), 'its window\'s title, Desktop\'s');
  check((await titleOf(elsewhere)).endsWith('— The mini') && !(await titleOf(mine)).includes('The mini') && app.windows().length === 3,
    'each core\'s Desktop in a window of its own: the mini\'s window says so, this computer\'s does not');
  const js = <T = unknown>(code: string) => elsewhere.evaluate(code) as Promise<T>;
  const click = (sel: string) => js<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  await until(() => js<boolean>('!!document.getElementById("place")'), 'the window');
  await click('#place');
  await until(() => js<boolean>('!document.getElementById("send").disabled'), 'a folder for the next task');
  await click('#send');
  const task = await until(async () => (await ask<string[]>('/tasks'))[0], 'a task there');
  await until(() => js<boolean>('!document.getElementById("opens").hidden'), 'its thread\'s bar');
  await click('#page');
  const page = await until(async () => (await ask<Listed[]>(`/pages?task=${encodeURIComponent(task)}`)).find(p => p.name === 'b1' && p.live), 'the person\'s page, live', 45_000);
  const views = await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)?.contentView.children.length ?? 0, elsewhere.url());
  check(page.live && !page.casting && views === 1, 'the core elsewhere\'s page lives in the app, over its pane in its Desktop\'s window, over the link the app gave it, not pictured');

  const separate = await app.evaluate(({ BrowserWindow, session }, url) => {
    const native = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)?.contentView.children[0] as Electron.WebContentsView | undefined;
    return native && native.webContents.session !== session.fromPartition('persist:vindu-person');
  }, elsewhere.url());
  check(separate, 'a paired core has its own persistent browser sign-ins');

  // out of reach: what is open says so (Desktop, its own note; kept by its service worker on a paired device), a page
  // that fails to load says so too and is tried again; back, each comes back by itself
  const desktopUrl = elsewhere.url();
  other.kill('SIGTERM'); await new Promise(r => other!.once('exit', r)); other = undefined;
  await until(async () => (await elsewhere.textContent('body').catch(() => ''))?.includes('The app has stopped'), 'Desktop says its core is gone');
  check(true, 'a core elsewhere gone: its open window says so, and that it comes back by itself');
  // its window loaded again at an address its service worker keeps nothing for, as a window opened while the core is gone
  await app.evaluate(({ BrowserWindow }, u) => { void BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === u)?.webContents.loadURL(`${u}?again`).catch(() => undefined); }, desktopUrl);
  await until(async () => elsewhere.url().startsWith('data:') && (await elsewhere.textContent('body').catch(() => ''))?.includes('out of reach'), 'out of reach, said').catch(async e => {
    const all = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.webContents.getURL().slice(0, 80)));
    throw new Error(`${(e as Error).message}: its window is at ${elsewhere.url().slice(0, 80)}; the app's windows: ${JSON.stringify(all)}`);
  });
  check((await titleOf(elsewhere)).includes('out of reach'), 'a page of a core elsewhere that fails to load says the core is out of reach, and that the work stays there');
  other = spawn(process.execPath, [path.join(import.meta.dirname, 'core.js')], { env: { ...process.env, VINDU_PORT: String(ELSEWHERE_PORT), VINDU_USER_DATA: otherData }, stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => elsewhere.url().startsWith(`http://127.0.0.1:${ELSEWHERE_PORT}/`), 'back', 45_000);
  await elsewhere.waitForSelector('#prompt', { timeout: 30_000 });
  check(true, 'back, it comes back by itself: the page that failed, tried again until its core answers');
  code = 0;
} finally {
  await app?.close().catch(() => undefined);
  other?.kill('SIGTERM');
}
console.log(`# ${passed} passed`);
process.exit(code);
