// The app's own server process on this computer: it serves Desktop's page on this computer's loopback, which the person
// opens in their own browser, or the Electron window (frame/) shows. `pnpm start` starts it and opens Desktop there;
// started again while it runs, it opens Desktop and leaves (--no-open: it only says where Desktop is). Ctrl-C (or its
// signal) stops it, and what it started with it: the tasks and their pages. VINDU_PORT: Desktop's port (7300);
// VINDU_USER_DATA: its folder, where the system keeps the app's data otherwise (a test's own). Started by the Electron
// window, it is given the window's link too (frame-link.ts): its browser views' pages live in the window, over their
// panes. Its processors are the claude and codex CLIs found on this computer as it starts (processors.ts).
// `--service install` makes it a service of the person's login instead, started with no terminal (service.ts), and
// `--service remove` takes that back.
import os from 'node:os';
import path from 'node:path';
import { startApp } from './app.js';
import { frameLink } from './frame-link.js';
import { localProcessors } from './processors.js';
import { appDataDir, openAddress } from './os.js';
import { keptToken } from './web.js';
import { installService, removeService } from './service.js';

const service = process.argv.includes('--service') ? process.argv[process.argv.indexOf('--service') + 1] : undefined;
if (service) {
  if (service !== 'install' && service !== 'remove') { console.error('vindu: --service install, or --service remove'); process.exit(2); }
  // the same server, by the same Node, with the same port and folder when they were given
  const env = { ...(process.env.VINDU_PORT ? { VINDU_PORT: process.env.VINDU_PORT } : {}), ...(process.env.VINDU_USER_DATA ? { VINDU_USER_DATA: process.env.VINDU_USER_DATA } : {}) };
  const where = { platform: process.platform, home: os.homedir(), node: process.execPath, main: path.resolve(process.argv[1]), env, ...(process.env.APPDATA ? { appData: process.env.APPDATA } : {}) };
  const r = service === 'install' ? await installService(where) : await removeService(where);
  for (const x of r.said) console.log(`${x.ok ? '' : 'not done: '}${x.cmd}${x.out ? `: ${x.out.split('\n')[0]}` : ''}`);
  console.log(service === 'install' ? `vindu: a service of your login now (${r.file}), started with no terminal` : `vindu: no service any more (${r.file} removed)`);
  process.exit(r.said.every(x => x.ok) ? 0 : 1);
}
const open = !process.argv.includes('--no-open');
const port = Number(process.env.VINDU_PORT) || 7300;
const userData = process.env.VINDU_USER_DATA || appDataDir('desktop');
const desktop = `http://localhost:${port}/${keptToken(path.join(userData, 'pages.json'), 'desktop')}/`;
if (await fetch(desktop.replace('localhost', '127.0.0.1')).then(r => r.ok, () => false)) {
  console.log(`vindu runs already: ${desktop}`); if (open) openAddress(desktop);
} else {
  const frame = await frameLink(); // out of the environment before anything is started
  const processors = localProcessors({ codexHome: path.join(userData, 'codex') }); // the CLIs here, as the tasks' processors
  const a = await startApp({ port, userData, ...processors, ...(frame ? { frame } : {}) });
  console.log(`vindu: ${a.url}`); if (open) openAddress(a.url);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {
    if (stopping) process.exit(1); // a second Ctrl-C: at once
    stopping = true; console.log('vindu: stopping'); void a.close().finally(() => process.exit(0));
  });
}
