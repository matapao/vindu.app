// Build the Electron app, with the app's own server inside it. --dir makes a local bundle for testing.
// Distributable macOS builds require a Developer ID and notarization.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stageServer } from './stage-server.mjs';

const args = process.argv.slice(2), dir = args.includes('--dir');
const FRAME = path.join(import.meta.dirname, '..'), APP = path.join(FRAME, '..'), out = path.join(FRAME, 'out'), stage = path.join(out, 'stage');
const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('electron-builder');
const system = args.includes('--win') ? 'win' : args.includes('--linux') ? 'linux' : 'mac';
const { os, cpu, libc } = { mac: { os: 'darwin', cpu: 'arm64' }, win: { os: 'win32', cpu: 'x64' }, linux: { os: 'linux', cpu: 'x64', libc: 'glibc' } }[system];
let macIdentity = null; // --dir builds use codesign with the literal ad-hoc identity below
if (!dir && system === 'mac' && !process.env.APPLE_KEYCHAIN_PROFILE && !process.env.APPLE_ID && !process.env.APPLE_API_KEY) {
  throw new Error('A macOS release requires notarization credentials. Use --dir for a local test bundle.');
}
if (!dir && system === 'mac') {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  macIdentity = /([A-F0-9]{40}) "Developer ID Application: /.exec(identities)?.[1];
  if (!macIdentity) throw new Error('A macOS release requires a Developer ID Application signing identity.');
}
for (const f of ['dist/src/main.js', 'dist/src/renderer.bundle.js', 'dist/src/keys.bundle.js', 'node_modules/@matapao/celler/dist/index.js', 'node_modules/@matapao/vindu/dist/index.js', 'node_modules/@matapao/vindu/dist/server.js'])
  if (!fs.existsSync(path.join(APP, f))) throw new Error(`${path.join(APP, f)} is missing. Run the app's bootstrap command to build its linked dependencies and app.`);
if (!fs.existsSync(path.join(FRAME, 'dist', 'src', 'main.js'))) throw new Error('the frame is not built: pnpm build here first');
fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });

stageServer(stage, APP, { os, cpu, libc });

// its icon, vindu's own (static/icons/vindu.svg), as scripts/icons.mjs draws it for a Mac: its square on 824 of
// 1024 pixels
const resources = path.join(stage, 'build'); fs.mkdirSync(resources); fs.copyFileSync(path.join(APP, 'static', 'icons', 'vindu-mac-1024.png'), path.join(resources, 'icon.png'));

const feed = process.env.VINDU_UPDATES, homepage = process.env.VINDU_HOMEPAGE; // a .deb needs a homepage: none is chosen yet
const config = {
  forceCodeSigning: !dir && (system === 'mac' || system === 'win'),
  appId: 'local.vindu.app', productName: 'vindu', executableName: 'vindu',
  directories: { output: out, buildResources: resources },
  files: ['dist/src/**/*', 'package.json'],
  extraResources: [
    { from: path.join(APP, 'LICENSE'), to: 'licenses/Vindu.txt' },
    { from: path.resolve(APP, '../celler/LICENSE'), to: 'licenses/Celler.txt' },
    { from: path.resolve(APP, '../vindu/LICENSE'), to: 'licenses/Vindu-SDK.txt' },
    // Copy from the stage so electron-builder includes the server's node_modules.
    { from: stage, to: '.', filter: ['server/**/*'] },
  ],
  asar: true, npmRebuild: false, nodeGypRebuild: false, extraMetadata: { desktopName: 'vindu.desktop', ...(homepage ? { homepage } : {}) }, // its windows' id on Linux: its desktop entry's
  electronVersion: require('electron/package.json').version,
  ...(system === 'mac' ? { electronDist: path.join(path.dirname(require.resolve('electron/package.json')), 'dist') } : {}), // the Electron here, for this Mac
  protocols: [{ name: 'vindu', schemes: ['vindu'] }],
  mac: { category: 'public.app-category.productivity', type: 'distribution', identity: macIdentity, notarize: !dir },
  nsis: { oneClick: true, perMachine: false, include: path.join(FRAME, 'scripts', 'windows-links.nsh') }, // its scheme, which electron-builder registers on a Mac and Linux only
  linux: { category: 'Utility', maintainer: 'vindu', synopsis: 'Vindu\'s desktop app', syncDesktopName: true },
  publish: feed ? [{ provider: 'generic', url: feed }] : null,
};
const targets = {
  mac: () => Platform.MAC.createTarget(dir ? ['dir'] : ['zip', 'dmg'], Arch.arm64),
  win: () => Platform.WINDOWS.createTarget(dir ? ['dir'] : ['nsis'], Arch.x64),
  linux: () => Platform.LINUX.createTarget(dir ? ['dir'] : ['AppImage', ...(homepage ? ['deb'] : [])], Arch.x64),
}[system];
if (system === 'linux' && !dir && !homepage) console.warn('pack: no .deb, which needs the project\'s homepage (VINDU_HOMEPAGE): the AppImage only');
await build({ projectDir: FRAME, targets: targets(), config, publish: 'never' });

if (system === 'mac') {
  const built = path.join(out, 'mac-arm64'), bundle = path.join(built, 'vindu.app');
  if (dir) execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  if (!dir) {
    execFileSync('codesign', ['--verify', '--strict', '-R=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', bundle], { stdio: 'inherit' });
    execFileSync('xcrun', ['stapler', 'validate', bundle], { stdio: 'inherit' });
  }
}
fs.rmSync(stage, { recursive: true, force: true }); // a step, not the result: the app holds it all
console.log(`built: ${fs.readdirSync(out).filter(f => !f.startsWith('.') && !f.endsWith('.blockmap') && f !== 'builder-debug.yml').join(', ')} (in ${path.relative(process.cwd(), out) || '.'})`);
