// The desktop app as packed (scripts/pack.mjs: out/mac-arm64/vindu.app), started from its bundle (its own program), on a
// port and in folders of the test's own, driven by Playwright's Electron: it starts the core inside the bundle (not the
// one built beside this folder, nor the person's), opens the grid, opens Desktop from it, and stops the core as it quits.
// The bundle is signed, declares the vindu scheme only, and holds all of the core, linked to nothing outside it; the VM's
// image is not in it, so the core inside says it is missing. Updates: with its feed at a small server of the test's own,
// which has a newer release, the app reads the feed and says the release is out, and fetches and installs nothing.
// A Mac registers an app it starts (Launch Services), and with it the schemes it declares: what this test's start
// registered, it unregisters at the end. Its windows show on the screen while it runs:
//   pnpm build, pnpm pack:app (or pnpm pack:app -- --dir), then pnpm test:packed
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { launchEnv } from './launch-env.js';

const FRAME = path.join(import.meta.dirname, '..', '..'), BUNDLE = path.join(FRAME, 'out', 'mac-arm64', 'vindu.app');
const PROGRAM = path.join(BUNDLE, 'Contents', 'MacOS', 'vindu'), CORE = path.join(BUNDLE, 'Contents', 'Resources', 'core');
const PORT = 17910, FEED = 17920;
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
const ADDRESS = /^http:\/\/localhost:(\d+)\/([\w-]{20,})\/$/;
if (process.platform !== 'darwin' || !fs.existsSync(PROGRAM)) { console.log(`no packed app at ${BUNDLE}: pnpm pack:app first (on a Mac)`); process.exit(1); }

// the test's folders: the core's (Desktop alone on its grid), and the app's
const data = tmp('frame-packed-core-'), frameData = tmp('frame-packed-app-');
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ installed: [] }));
// the test's feed, with a release newer than the app's: its latest-mac.yml, as electron-builder writes one; nothing else
const version = plist('CFBundleShortVersionString'), newer = version.replace(/(\d+)$/, d => String(Number(d) + 1));
const asked: string[] = [];
const feed = http.createServer((q, r) => {
  const at = new URL(q.url ?? '/', 'http://feed').pathname; asked.push(at); // the updater adds a query of its own, against caches
  if (at !== '/latest-mac.yml') { r.writeHead(404).end(); return; }
  const zip = `vindu-${newer}-arm64-mac.zip`, sha512 = Buffer.alloc(64, 7).toString('base64');
  r.writeHead(200, { 'Content-Type': 'text/yaml' }).end(`version: ${newer}\nfiles:\n  - url: ${zip}\n    sha512: ${sha512}\n    size: 1000\npath: ${zip}\nsha512: ${sha512}\nreleaseDate: '2026-11-14T12:00:00.000Z'\n`);
});
await new Promise<void>(r => feed.listen(FEED, '127.0.0.1', r));
const env = launchEnv({ VINDU_PORT: String(PORT), VINDU_USER_DATA: data, VINDU_FRAME_DATA: frameData, VINDU_UPDATES: `http://127.0.0.1:${FEED}/` });
delete env.VINDU_CORE; // the core inside the bundle, never another
const wasRegistered = registered();

let code = 1, app: ElectronApplication | undefined;
try {
  // the bundle: signed, declaring only the vindu scheme, with all of the core inside it, and no VM image
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', BUNDLE], { encoding: 'utf8' });
  const by = /^Authority=(.*)$/m.exec(spawnSync('codesign', ['-dvv', BUNDLE], { encoding: 'utf8' }).stderr)?.[1] ?? 'ad hoc';
  const schemes = (JSON.parse(plist('CFBundleURLTypes', 'json')) as { CFBundleURLSchemes: string[] }[]).flatMap(t => t.CFBundleURLSchemes);
  check(verify.status === 0 && schemes.join() === 'vindu', `the bundle is signed (${by}), valid as signed, and declares the vindu scheme only`);
  const outside: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!fs.existsSync(file) || !fs.realpathSync(file).startsWith(`${BUNDLE}/`)) outside.push(file);
      } else if (entry.isDirectory()) walk(file);
    }
  };
  walk(CORE);
  const sameBuild = (name: string, entry: string) => {
    const installed = path.join(CORE, 'node_modules', name), source = path.join(FRAME, '..', 'node_modules', name);
    return fs.lstatSync(installed).isDirectory() && fs.readFileSync(path.join(installed, entry)).equals(fs.readFileSync(path.join(source, entry)));
  };
  check(fs.readFileSync(path.join(CORE, 'dist/src/main.js')).equals(fs.readFileSync(path.join(FRAME, '../dist/src/main.js')))
    && fs.existsSync(path.join(CORE, 'static', 'shell.html')) && sameBuild('celler', 'dist/index.js')
    && ['dist/index.js', 'dist/server.js', 'dist/renderer/shell.js', 'dist/renderer/workspace.js'].every(entry => sameBuild('@matapao/vindu', entry))
    && [
      ['Vindu.txt', '../LICENSE'],
      ['Vindu-SDK.txt', '../../vindu/LICENSE'],
      ['Celler.txt', '../../celler/LICENSE'],
    ].every(([license, source]) => fs.readFileSync(path.join(BUNDLE, 'Contents/Resources/licenses', license))
      .equals(fs.readFileSync(path.resolve(FRAME, source))))
    && fs.readdirSync(path.join(CORE, 'node_modules/@matapao')).join() === 'vindu'
    && outside.length === 0 && !fs.existsSync(path.join(CORE, 'out')),
    `the bundle contains the current Vindu app, UI SDK and Celler builds, with no external links${outside.length ? ` (${outside.slice(0, 3).join(', ')})` : ''}`);

  // started from its bundle: the core inside it, then the grid
  app = await electron.launch({ executablePath: PROGRAM, env });
  const said: string[] = []; app.process().stdout?.on('data', d => said.push(String(d))); app.process().stderr?.on('data', d => said.push(String(d)));
  process.on('exit', () => { if (code) console.log(`# the app said:\n${said.join('').split('\n').filter(l => /vindu|Error|error/.test(l)).slice(-15).join('\n')}\n# its feed was asked for: ${asked.join(', ') || 'nothing'}`); });
  const grid = await app.firstWindow();
  await grid.waitForURL(ADDRESS, { timeout: 60_000 });
  const shellAt = `http://localhost:${PORT}/${JSON.parse(fs.readFileSync(path.join(data, 'pages.json'), 'utf8')).shell}/`;
  await grid.waitForSelector('#grid .app[data-app="desktop"] img');
  check(grid.url() === shellAt && (await grid.$$eval('#grid .app span', s => s.map(x => x.textContent))).join() === 'Vindu', 'started from its bundle, the app opens the grid in its window, at the shell\'s address on the test\'s port');
  const pid = Number(execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]);
  const [ppid, ...command] = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
  check(Number(ppid) === app.process().pid && command.join(' ') === `${PROGRAM} ${path.join(CORE, 'dist', 'src', 'main.js')} --no-open`,
    'the core that answers there is the one inside the bundle, started by the app on its own program (as Node)');
  await grid.click('#grid .app[data-app="desktop"]');
  const desk = await until(() => grid.frames().find(frame => frame !== grid.mainFrame() && frame.url().startsWith(`http://localhost:${PORT + 1}/`)), 'the workspace tab');
  await desk.locator('#place').waitFor();
  check(await desk.title() === 'Vindu', 'a click opens the workspace tab served by the core inside the bundle');

  // updates: the test's feed read, its newer release seen, and nothing fetched or installed
  await until(() => said.join('').includes(`vindu: ${newer} is out (this is ${version})`), 'the newer release, seen', 30_000);
  check(asked.length > 0 && asked.every(u => u === '/latest-mac.yml'), `the app reads its feed (the test's, VINDU_UPDATES) and says ${newer} is out, newer than its ${version}; it asks for nothing else (${asked.length} asked)`);
  await sleep(1500);

  // Quit: the core stops, and the app is as it was
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => undefined);
  await closed; app = undefined;
  await until(async () => !(await answers(PORT)), 'the core stopped', 30_000);
  const gone = (() => { try { process.kill(pid, 0); return false; } catch { return true; } })();
  check(gone && plist('CFBundleShortVersionString') === version && asked.every(u => u === '/latest-mac.yml') && fs.existsSync(path.join(frameData, 'Local State')),
    `Quit stops the core inside; the app is still ${version}, nothing fetched for the update, nothing installed; its own files went to the test's folder`);
  console.log(`# ${passed} passed`);
  code = 0;
} catch (e) { console.log(String((e as Error)?.stack ?? e)); } finally {
  await app?.close().catch(() => undefined);
  feed.close();
  await sleep(300);
  for (const d of [data, frameData]) fs.rmSync(d, { recursive: true, force: true });
  if (!wasRegistered && registered()) { spawnSync(LSREGISTER, ['-u', BUNDLE]); console.log(`# Launch Services had registered the build as it started: ${registered() ? 'still registered' : 'unregistered again'}`); }
  process.exit(code);
}
