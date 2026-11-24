// The client build of the desktop app (scripts/pack.mjs --client: out/client/mac-arm64/vindu.app): the frame alone, with
// no core inside, for a person whose core is on a Pi or a server. First the bundle, with no window: signed, declaring the
// vindu scheme only, nothing of the core in it, and its archive the frame as built here, saying it is a client; its size,
// said. Then, unless --headless, the app, its windows on the screen while it runs:
// - started from its bundle, on folders of the test's own, with VINDU_CORE naming a core of the test's: it starts none,
//   and opens on the window to add a core elsewhere, which takes an https address only; with none added, its Dock icon
//   and its links bring that window forward, and open nothing else; its updates are a channel of their own at its feed
//   (the test's: client-mac.yml, never latest-mac.yml); Quit, and nothing of it runs on.
// - its own code, from its archive, on Electron as a test runs it (not packed: so a core of the test's own pairs at
//   http://localhost, as the app would reach a Pi's on the tailnet, its token in a test's own store): paired, that core
//   opens in a window of its own; a task's page there lives in the client, over the link it gives that core; another
//   page on this computer goes to the browser, as any other site does; a link to an app goes to that core; started
//   again, it opens that core, not the window to add one; still no core here.
// Chromium's own keychain is a mock one here (--use-mock-keychain): the test touches none of the person's. A Mac
// registers an app whose program runs (Launch Services), even as Node, with the scheme it declares: what the test's
// runs registered, it unregisters at the end, headless too.
//   pnpm build, pnpm pack:app -- --client [--dir], then pnpm test:client [-- --headless]
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { launchEnv } from './launch-env.js';

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;
const FRAME = path.join(import.meta.dirname, '..', '..'), BUILT = path.join(FRAME, 'out', 'client', 'mac-arm64'), BUNDLE = path.join(BUILT, 'vindu.app');
const PROGRAM = path.join(BUNDLE, 'Contents', 'MacOS', 'vindu'), RESOURCES = path.join(BUNDLE, 'Contents', 'Resources'), ARCHIVE = path.join(RESOURCES, 'app.asar');
const FULL = path.join(FRAME, 'out', 'mac-arm64', 'vindu.app'), TEST_CORE = path.join(import.meta.dirname, 'core.js');
const PORT = 17930, FEED = 17940, ELSEWHERE_PORT = 17950;
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const check = (cond: unknown, what: string) => { if (!cond) throw new Error(`not ok: ${what}`); console.log(`ok ${++passed} - ${what}`); };
async function until<T>(f: () => Promise<T> | T, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); }
}
const answers = (port: number) => new Promise<boolean>(r => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
/** A value of the bundle's Info.plist: a string as it is (raw), anything else as JSON. */
const plist = (key: string, as: 'raw' | 'json' = 'raw') => execFileSync('plutil', ['-extract', key, as, '-o', '-', path.join(BUNDLE, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const registered = () => spawnSync(LSREGISTER, ['-dump'], { encoding: 'utf8', maxBuffer: 1 << 30 }).stdout.split('\n').some(l => /^path:\s/.test(l) && l.replace(/^path:\s+/, '').startsWith(`${BUNDLE} (`));
/** Every file in a folder, its symbolic links not followed: its path and size. */
const files = (d: string): { file: string; size: number }[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name); return e.isDirectory() ? files(p) : e.isFile() ? [{ file: p, size: fs.statSync(p).size }] : [];
});
const megabytes = (d: string) => Math.round(files(d).reduce((n, f) => n + f.size, 0) / 1e6);
/** The processes a process started, and theirs. */
const under = (root: number) => {
  const all = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n')
    .map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(m => !!m).map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  const out: typeof all = []; let at = [root];
  while (at.length) { const kids = all.filter(p => at.includes(p.ppid)); out.push(...kids); at = kids.map(k => k.pid); }
  return out;
};
const windows = (a: ElectronApplication) => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const quit = async (a: ElectronApplication) => { const closed = a.waitForEvent('close', { timeout: 30_000 }); await a.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => undefined); await closed; };
const openUrl = (a: ElectronApplication, link: string) => a.evaluate(({ app }, l) => { app.emit('open-url', { preventDefault() { /* taken */ } }, l); }, link);
const titleOf = (a: ElectronApplication, p: Page) => a.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)?.getTitle() ?? '', p.url());
/** What the apps the test started said from the moment Playwright gives the test their output, for a check and a failure. */
const said: string[] = [];
const hear = (a: ElectronApplication) => { a.process().stdout?.on('data', d => said.push(String(d))); a.process().stderr?.on('data', d => said.push(String(d))); };
process.on('exit', c => { if (c) console.log(`# the apps said, at the end:\n${said.join('').split('\n').filter(l => /vindu|error/i.test(l)).slice(-20).join('\n')}`); });
type Listed = { name: string; live: boolean; casting: boolean };
if (process.platform !== 'darwin' || !fs.existsSync(PROGRAM)) { console.log(`no client build at ${BUNDLE}: pnpm pack:app -- --client first (on a Mac)`); process.exit(1); }

/** The test's folders and processes, gone at the end; the app it runs; whether Launch Services had the build before the
 *  test first ran its program (which registers it, even as Node). */
const made: string[] = [], spawned = new Set<ChildProcess>(), feed = http.createServer(), wasRegistered = registered();
let app: ElectronApplication | undefined;

/** The bundle, with no window: signed, its scheme, nothing of the core, its archive; its size. */
function theBundle() {
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', BUNDLE], { encoding: 'utf8' });
  const by = /^Authority=(.*)$/m.exec(spawnSync('codesign', ['-dvv', BUNDLE], { encoding: 'utf8' }).stderr)?.[1] ?? 'ad hoc';
  const schemes = (JSON.parse(plist('CFBundleURLTypes', 'json')) as { CFBundleURLSchemes: string[] }[]).flatMap(t => t.CFBundleURLSchemes);
  check(verify.status === 0 && schemes.join() === 'vindu', `the bundle is signed (${by}), valid as signed, and declares the vindu scheme only`);
  // nothing of the core: no core in its resources, no VM beside it, none of desktop's pages or dependencies anywhere in it
  const desktopDeps = Object.keys((JSON.parse(fs.readFileSync(path.join(FRAME, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies);
  const ofDesktop = files(BUNDLE).map(f => path.relative(BUNDLE, f.file)).filter(f => f.endsWith('/shell.html') || desktopDeps.some(d => f.includes(`/node_modules/${d}/`)));
  check(!fs.existsSync(path.join(RESOURCES, 'core')) && !fs.existsSync(path.join(BUILT, 'vbox')) && ofDesktop.length === 0,
    `nothing of the core is in it: no core in its resources (${fs.readdirSync(RESOURCES).join(', ')}), no VM beside it, none of desktop's pages or dependencies${ofDesktop.length ? ` (${ofDesktop.slice(0, 3).join(', ')})` : ''}`);
  // its archive, read by the app's own Node as the frame reads it (its package.json there): the frame as built here,
  // saying it is a client, with the frame's own dependencies only
  const inside = JSON.parse(execFileSync(PROGRAM, ['-e', `const fs = require('fs'), path = require('path'), a = process.argv[1];
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(a, path.join(d, e.name))]);
    const files = walk(a);
    const packages = [], missing = [];
    const manifests = ['package.json', ...files.filter(f => /(?:^|\\/)node_modules\\/(?:@[^/]+\\/)?[^/]+\\/package\\.json$/.test(f))];
    for (const file of manifests) {
      const abs = path.join(a, file), pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (file !== 'package.json') packages.push(pkg.name + '@' + pkg.version);
      const required = require('node:module').createRequire(abs);
      const deps = Object.keys(pkg.dependencies || {}).filter(name => !pkg.optionalDependencies?.[name]);
      for (const dep of deps) {
        const found = required.resolve.paths(dep).some(dir => dir.startsWith(a + path.sep) && fs.existsSync(path.join(dir, dep, 'package.json')));
        if (!found) missing.push(pkg.name + ' requires ' + dep);
      }
    }
    console.log(JSON.stringify({ pkg: JSON.parse(fs.readFileSync(path.join(a, 'package.json'), 'utf8')), files, packages, missing, src: Object.fromEntries(files.filter(f => f.startsWith('dist/')).map(f => [f, fs.readFileSync(path.join(a, f), 'base64')])) }));`, ARCHIVE],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', maxBuffer: 1 << 26 })) as { pkg: { client?: unknown }; files: string[]; packages: string[]; missing: string[]; src: Record<string, string> };
  const built = Object.fromEntries(fs.readdirSync(path.join(FRAME, 'dist', 'src')).map(f => [`dist/src/${f}`, fs.readFileSync(path.join(FRAME, 'dist', 'src', f), 'base64')]));
  const same = Object.keys(built).length === Object.keys(inside.src).length && Object.entries(built).every(([f, b]) => inside.src[f] === b);
  // pnpm may install optional peers for other packages in the workspace. Each package the
  // frame actually includes must have the locked version and all its required runtime dependencies.
  type Dependencies = { [name: string]: { version: string; dependencies?: Dependencies; optionalDependencies?: Dependencies } };
  const [project] = JSON.parse(execFileSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], { cwd: FRAME, encoding: 'utf8' })) as { dependencies: Dependencies }[];
  const versions = (deps: Dependencies): string[] => Object.entries(deps).flatMap(([name, node]) => [`${name}@${node.version}`, ...versions({ ...node.dependencies, ...node.optionalDependencies })]);
  const locked = new Set(versions(project.dependencies));
  const unexpected = inside.packages.filter(pkg => !locked.has(pkg));
  const others = inside.files.filter(f => !f.startsWith('dist/src/') && !f.startsWith('node_modules/') && f !== 'package.json');
  check(inside.pkg.client === true && same && !unexpected.length && !inside.missing.length && !others.length,
    `the client archive contains the current frame and ${inside.packages.length} locked runtime packages; unexpected or missing: ${[...unexpected, ...inside.missing, ...others].join(', ') || 'none'}`);
  const full = fs.existsSync(path.join(FULL, 'Contents', 'Resources', 'core')) ? megabytes(FULL) : undefined;
  console.log(`# its size: ${megabytes(BUNDLE)} MB, ${megabytes(path.join(BUNDLE, 'Contents', 'Frameworks'))} MB of it Electron's${full ? `; the build with the core inside: ${full} MB` : ''}`);
}

/** Started from its bundle: no core, the window to add one, an https address only; its Dock icon and links with none
 *  added; its updates' channel; Quit. */
async function fromItsBundle() {
  const data = tmp('frame-client-core-'), frameData = tmp('frame-client-app-'); made.push(data, frameData);
  // the test's feed, with a client release newer than this one: its client-mac.yml, as electron-builder writes one;
  // answered once the test hears the app, since a client looks as it starts, before Playwright gives the test its output
  const version = plist('CFBundleShortVersionString'), newer = version.replace(/(\d+)$/, d => String(Number(d) + 1));
  const asked: string[] = [];
  let hearing = () => undefined as void; const heard = new Promise<void>(r => { hearing = r; });
  feed.on('request', (q, r) => {
    const at = new URL(q.url ?? '/', 'http://feed').pathname; asked.push(at); // the updater adds a query of its own, against caches
    if (at !== '/client-mac.yml') { r.writeHead(404).end(); return; }
    const zip = `vindu-client-${newer}-arm64.zip`, sha512 = Buffer.alloc(64, 7).toString('base64');
    void heard.then(() => r.writeHead(200, { 'Content-Type': 'text/yaml' }).end(`version: ${newer}\nfiles:\n  - url: ${zip}\n    sha512: ${sha512}\n    size: 1000\npath: ${zip}\nsha512: ${sha512}\nreleaseDate: '2026-11-15T12:00:00.000Z'\n`));
  });
  await new Promise<void>(r => feed.listen(FEED, '127.0.0.1', r));
  process.on('exit', c => { if (c) console.log(`# its feed was asked for: ${asked.join(', ') || 'nothing'}`); });
  const env = launchEnv({ VINDU_PORT: String(PORT), VINDU_USER_DATA: data, VINDU_FRAME_DATA: frameData, VINDU_UPDATES: `http://127.0.0.1:${FEED}/`, VINDU_CORE: TEST_CORE });
  app = await electron.launch({ executablePath: PROGRAM, args: ['--use-mock-keychain'], env });
  hear(app); hearing();
  const pid = app.process().pid!;
  const add = await app.firstWindow();
  await add.waitForSelector('input[name="address"]', { timeout: 30_000 });
  check(add.url().startsWith('data:text/html') && await add.title() === 'Add a core' && await windows(app) === 1, 'started from its bundle, with no core elsewhere yet, the client opens on the window to add one, and nothing else');
  await until(() => said.join('').includes(`vindu: ${newer} is out (this is ${version})`), 'the newer release, seen');
  check(asked.length > 0 && asked.every(u => u === '/client-mac.yml'), `its updates are a channel of their own at its feed: it reads client-mac.yml, never latest-mac.yml, and says ${newer} is out (${asked.length} asked)`);
  await sleep(2000); // the time a core would take to start
  check(!(await answers(PORT)) && fs.readdirSync(data).length === 0 && !under(pid).some(p => p.command.includes('--no-open')),
    'it starts no core, though VINDU_CORE names one: nothing at the core\'s port, no process of one, nothing in its folder');
  await add.fill('input[name="address"]', `http://localhost:${ELSEWHERE_PORT}`); await add.fill('input[name="code"]', '123456'); await add.fill('input[name="name"]', 'The Pi');
  await add.click('button');
  await until(async () => (await add.textContent('body'))?.includes('https address'), 'an address that is not https, said');
  check(!fs.existsSync(path.join(frameData, 'cores.json')), 'the window takes a core\'s https address only, as a person\'s app does: one that is not is said, and nothing is added');
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close(); });
  await until(async () => (await windows(app!)) === 0, 'its window closed');
  const [again] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ app: a }) => { a.emit('activate'); })]);
  await again.waitForSelector('input[name="address"]');
  await app.evaluate(({ app: a }) => { a.emit('activate'); });
  await openUrl(app, 'vindu://desktop/hello'); await openUrl(app, 'vindu://add-core');
  await sleep(800);
  check(await windows(app) === 1 && again.url().startsWith('data:text/html') && !(await answers(PORT)),
    'its window closed, the client stays in the menu bar; its Dock icon opens that window again, and the Dock icon again, a link to an app and vindu://add-core each bring it forward, and open nothing else');
  await quit(app); app = undefined;
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the app gone');
  check(!(await answers(PORT)) && fs.readdirSync(data).length === 0 && fs.existsSync(path.join(frameData, 'Local State')), 'Quit: the client is gone, and no core ever ran; its own files went to the test\'s folder');
  feed.close();
}

/** Its own code, from its archive, as a test runs it: a core of the test's own elsewhere, paired, its pages living
 *  here; a link to an app; started again. */
async function fromItsArchive() {
  const otherData = tmp('frame-client-pi-'), data = tmp('frame-client-core-'), frameData = tmp('frame-client-app-'); made.push(otherData, data, frameData);
  const other = spawn(process.execPath, [TEST_CORE], { env: { ...process.env, VINDU_PORT: String(ELSEWHERE_PORT), VINDU_USER_DATA: otherData }, stdio: ['ignore', 'ignore', 'inherit'] }); spawned.add(other);
  const inspect = await until(() => { try { return (JSON.parse(fs.readFileSync(path.join(otherData, 'test-core.json'), 'utf8')) as { inspect: string }).inspect; } catch { return undefined; } }, 'the core elsewhere');
  const ask = async <T>(p: string) => (await (await fetch(`${inspect}${p}`)).json()) as T;
  const env = launchEnv({ VINDU_PORT: String(PORT), VINDU_USER_DATA: data, VINDU_FRAME_DATA: frameData, VINDU_CORE: TEST_CORE, VINDU_FRAME_SECRETS: 'memory' });
  delete env.VINDU_UPDATES;
  const launch = async () => { const a = await electron.launch({ executablePath: ELECTRON, args: [ARCHIVE, '--use-mock-keychain'], env }); hear(a); return a; };
  app = await launch();
  const add = await app.firstWindow();
  await add.waitForSelector('input[name="address"]', { timeout: 30_000 });
  await sleep(1500);
  check(add.url().startsWith('data:text/html') && await windows(app) === 1 && !(await answers(PORT)), 'its own code, from its archive on Electron as a test runs it, is a client by its package.json: no core, and the window to add one');
  await add.fill('input[name="address"]', `http://localhost:${ELSEWHERE_PORT}`); await add.fill('input[name="code"]', await ask<string>('/code')); await add.fill('input[name="name"]', 'The Pi');
  await add.click('button');
  await until(async () => (await add.textContent('body'))?.includes('The Pi is added'), 'added');
  const pi = await until(() => app!.windows().find(w => w.url().startsWith(`http://localhost:${ELSEWHERE_PORT}/`)), 'its window');
  await pi.waitForSelector('#grid .app[data-app="desktop"] img');
  await until(async () => (await titleOf(app!, pi)).endsWith('— The Pi'), 'its name in the title');
  check(!pi.url().includes((await ask<string>('/shell')).split('/')[3]), 'paired by the code made there, the core elsewhere opens in a window of its own, at this computer\'s own token there, its name in the title');
  // a task's page there, in Desktop's tab: live in the client
  await pi.click('#grid .app[data-app="desktop"]');
  const desk = await until(() => pi.frames().find(f => f !== pi.mainFrame() && f.url().startsWith(`http://localhost:${ELSEWHERE_PORT + 1}/`)), 'Desktop there, in its tab');
  const js = <T = unknown>(code: string) => desk.evaluate(code) as Promise<T>;
  const click = (sel: string) => js<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  await until(() => js<boolean>('!!document.getElementById("place")'), 'the window');
  await click('#place');
  await until(() => js<boolean>('!document.getElementById("send").disabled'), 'a folder for the next task');
  await click('#send');
  const task = await until(async () => (await ask<string[]>('/tasks'))[0], 'a task there');
  await until(() => js<boolean>('!document.getElementById("opens").hidden'), 'its thread\'s bar');
  await click('#page');
  const page = await until(async () => (await ask<Listed[]>(`/pages?task=${encodeURIComponent(task)}`)).find(p => p.name === 'b1' && p.live), 'the person\'s page, live', 45_000);
  const views = await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)?.contentView.children.length ?? 0, pi.url());
  check(page.live && !page.casting && views === 1, 'a task\'s page there lives in the client, over its pane in Desktop\'s tab, over the link the client gives that core: not pictured');
  // another page on this computer, which no core of a client's is: in the person's browser (here, a list the test keeps)
  await app.evaluate(({ shell }) => { const opened: string[] = []; (globalThis as { opened?: string[] }).opened = opened; shell.openExternal = async (url: string) => { opened.push(url); }; });
  await pi.evaluate(() => { window.open('http://127.0.0.1:9/elsewhere'); });
  await sleep(600);
  check((await app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? [])).join() === 'http://127.0.0.1:9/elsewhere' && await windows(app) === 2,
    'another page on this computer is none of a client\'s cores\': it opens in the person\'s browser, never in a window of the app\'s');
  // a link to an app: to that core, the one in front last
  const link = 'vindu://desktop/hello?x=1';
  await openUrl(app, link);
  await until(() => desk.url().endsWith(`#vindu-link=${encodeURIComponent(link)}`), 'the link, in Desktop\'s address there');
  check(await windows(app) === 2, 'a link to an app goes to the core elsewhere in front last: that app\'s tab there, the link in its address\'s fragment, and no window more');
  await quit(app); app = undefined;
  check(await answers(ELSEWHERE_PORT), 'Quit: the client goes, and the core elsewhere goes on, as a Pi\'s does');
  // started again: that core, at once
  app = await launch();
  const first = await app.firstWindow();
  await first.waitForURL(new RegExp(`^http://localhost:${ELSEWHERE_PORT}/`), { timeout: 30_000 });
  await first.waitForSelector('#grid .app[data-app="desktop"] img', { timeout: 30_000 });
  await until(async () => (await titleOf(app!, first)).includes('The Pi'), 'its name in the title');
  await sleep(1000);
  check(await windows(app) === 1 && !(await answers(PORT)) && fs.readdirSync(data).length === 0, 'started again, the client opens the core it has, in its window, and not the window to add one; still no core here');
  await quit(app); app = undefined;
}

let code = 1;
try {
  theBundle();
  if (!process.argv.includes('--headless')) { await fromItsBundle(); await fromItsArchive(); }
  console.log(`# ${passed} passed${process.argv.includes('--headless') ? ', with no window (--headless)' : ''}`);
  code = 0;
} catch (e) { console.log(String((e as Error)?.stack ?? e)); } finally {
  await app?.close().catch(() => undefined);
  if (feed.listening) feed.close();
  for (const c of spawned) if (c.exitCode === null && c.signalCode === null) { c.kill('SIGTERM'); await new Promise(r => { c.once('exit', r); setTimeout(r, 10_000); }); }
  await sleep(300);
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  if (!wasRegistered && registered()) { spawnSync(LSREGISTER, ['-u', BUNDLE]); console.log(`# Launch Services had registered the build as the test ran it: ${registered() ? 'still registered' : 'unregistered again'}`); }
  process.exit(code);
}
