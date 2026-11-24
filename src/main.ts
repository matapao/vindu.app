// The app, as a process on this computer: its core, serving the shell and Desktop's page, which the person opens in their
// own browser, or the desktop app shows (frame/). `npm start` starts it and opens the shell there; started again while it
// runs, it opens the shell and leaves (--no-open: it only says where the shell is). Ctrl-C (or its signal) stops it, and
// what it started with it: the tasks, the VM, the pages. VINDU_PORT: the shell's port (7300); VINDU_USER_DATA:
// its folder, where the system keeps the app's data otherwise (a test's own, or a second core's); VINDU_TAILSCALE:
// Tailscale's command line, in place of the one its installers put (a Pi's core, which runs as a user of its own, through sudo). Started by the desktop
// app, it is given the app's link too (frame-link.ts): its browser views' pages live in the app, over their panes.
// `--service install` makes it a service of the person's login instead, started with no terminal (service.ts), and
// `--service remove` takes that back. Where no one opens the shell on this computer (a Pi, a server), the person asks the
// core that runs here, at the shell's own token: `--pair`, a code to pair a device with, as Phone makes one (`--owner`: an
// owner device's, which sets what each app may use, Processors, as this computer does); `--tailnet on`
// (or off), the core on their tailnet, as Phone's button does; `--lan on` (or off), the core on their own Wi-Fi, over
// HTTPS (VINDU_LAN=on: there from the start, as a Pi's core is); `--status`, where it is. `--json` says it as JSON.
import os from 'node:os';
import path from 'node:path';
import { startApp } from './app.js';
import { frameLink } from './frame-link.js';
import { appDataDir, openAddress } from './os.js';
import { keptToken } from './web.js';
import { installService, removeService } from './service.js';

const service = process.argv.includes('--service') ? process.argv[process.argv.indexOf('--service') + 1] : undefined;
if (service) {
  if (service !== 'install' && service !== 'remove') { console.error('vindu: --service install, or --service remove'); process.exit(2); }
  // the same core, by the same Node, with the same port and folder when they were given
  const env = { ...(process.env.VINDU_LAN_NAME ? { VINDU_LAN_NAME: process.env.VINDU_LAN_NAME } : {}), ...(process.env.VINDU_PORT ? { VINDU_PORT: process.env.VINDU_PORT } : {}), ...(process.env.VINDU_USER_DATA ? { VINDU_USER_DATA: process.env.VINDU_USER_DATA } : {}) };
  const where = { platform: process.platform, home: os.homedir(), node: process.execPath, main: path.resolve(process.argv[1]), env, ...(process.env.APPDATA ? { appData: process.env.APPDATA } : {}) };
  const r = service === 'install' ? await installService(where) : await removeService(where);
  for (const x of r.said) console.log(`${x.ok ? '' : 'not done: '}${x.cmd}${x.out ? `: ${x.out.split('\n')[0]}` : ''}`);
  console.log(service === 'install' ? `vindu: a service of your login now (${r.file}), started with no terminal` : `vindu: no service any more (${r.file} removed)`);
  if ('note' in r && r.note) console.log(r.note);
  process.exit(r.said.every(x => x.ok) ? 0 : 1);
}
const open = !process.argv.includes('--no-open');
const port = Number(process.env.VINDU_PORT) || 7300;
const userData = process.env.VINDU_USER_DATA || appDataDir('desktop');
const shell = `http://localhost:${port}/${keptToken(path.join(userData, 'pages.json'), 'shell')}/`;
const flag = (f: string) => process.argv.includes(f), after = (f: string) => process.argv[process.argv.indexOf(f) + 1];
const command = flag('--pair') ? { do: 'code', ...(flag('--owner') ? { owner: true } : {}) } : flag('--tailnet') ? { do: 'tailnet', on: after('--tailnet') === 'on' }
  : flag('--lan') ? { do: 'lan', on: after('--lan') === 'on' } : flag('--status') ? { do: 'state' } : undefined;
if (command) {
  if (command.do === 'tailnet' && !['on', 'off'].includes(after('--tailnet'))) { console.error('vindu: --tailnet on, or --tailnet off'); process.exit(2); }
  if (command.do === 'lan' && !['on', 'off'].includes(after('--lan'))) { console.error('vindu: --lan on, or --lan off'); process.exit(2); }
  const r = await fetch(`${shell.replace('localhost', '127.0.0.1')}control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }).catch(() => undefined);
  if (!r) { console.error(`vindu: no core runs here at port ${port} (its folder: ${userData})`); process.exit(1); }
  type Lan = { on: boolean; address: string | null };
  const j = await r.json().catch(() => ({})) as { error?: string; code?: string; until?: number; owner?: boolean; at?: string | null; lanAt?: string | null; step?: string; ok?: boolean; said?: string; link?: string; address?: string | null; serving?: boolean; host?: string | null; lan?: Lan; state?: { address?: string | null; lan?: Lan }; devices?: { name: string; owner?: boolean }[]; apps?: string[] };
  if (!r.ok) { console.error(`vindu: ${j.error ?? `the core said ${r.status}`}`); process.exit(1); }
  if (flag('--json')) { console.log(JSON.stringify(command.do === 'state' ? { ...j, shell } : j, null, 2)); process.exit(0); } // shell: its address here, token and all
  const until = (t?: number) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  const STEP: Record<string, string> = { install: 'Tailscale is not on this computer', signin: 'Tailscale is not signed in here', https: 'HTTPS certificates are off in the tailnet (its DNS settings)' };
  // where a device opens the pairing page: on this Wi-Fi, while vindu is on it, and on the tailnet, once served there
  const at = [j.lanAt ? `${j.lanAt} (on this Wi-Fi)` : '', j.at ? `${j.at} (on your tailnet)` : ''].filter(Boolean);
  if (command.do === 'code') console.log((at.length ? `On the device, open ${at.join(', or ')}, and type ${j.code} (until ${until(j.until)}).` : `The code is ${j.code} (until ${until(j.until)}), but vindu is on neither your Wi-Fi nor your tailnet: run --lan on, or --tailnet on${STEP[j.step ?? ''] ? ` (${STEP[j.step ?? '']})` : ''}.`)
    + (j.owner ? '\nIt pairs an owner device: that device may change Processors (what each app may use, where it runs, its budget), as this computer does.' : ''));
  else if (command.do === 'tailnet') console.log(j.ok ? (command.on ? `vindu is on your tailnet: ${j.state?.address ?? 'its address comes once Tailscale has it'}` : 'vindu is off your tailnet') : `not done: ${j.said ?? 'Tailscale said no'}${j.link ? ` (open ${j.link} to allow it)` : ''}`);
  else if (command.do === 'lan') console.log(command.on ? `vindu is on your Wi-Fi: ${j.state?.lan?.address ?? 'its address comes once this computer has one there'} (HTTPS; pair a device with --pair)` : 'vindu is off your Wi-Fi');
  else console.log([`vindu runs here: ${shell}`, j.lan?.on ? `on your Wi-Fi: ${j.lan.address}` : 'not on your Wi-Fi', j.serving ? `on your tailnet: ${j.address}` : `not on your tailnet${j.step && STEP[j.step] ? `: ${STEP[j.step]}` : ''}`,
    `apps: ${(j.apps ?? []).join(', ') || 'none'}`, `devices paired: ${(j.devices ?? []).map(d => (d.owner ? `${d.name} (an owner: sets Processors)` : d.name)).join(', ') || 'none'}`].join('\n'));
  process.exit(command.do === 'tailnet' && !j.ok ? 1 : 0);
}
if (await fetch(shell.replace('localhost', '127.0.0.1')).then(r => r.ok, () => false)) {
  console.log(`vindu runs already: ${shell}`); if (open) openAddress(shell);
} else {
  const frame = await frameLink(); // out of the environment before anything is started
  const tailscale = process.env.VINDU_TAILSCALE; // Tailscale's command line, where the core may not run the system's own (a Pi's: through sudo)
  const lan = process.env.VINDU_LAN; // on the Wi-Fi from the start, until the person says otherwise (a Pi's core: on)
  const a = await startApp({ port, userData, lanName: process.env.VINDU_LAN_NAME, ...(frame ? { frame } : {}), ...(tailscale ? { tailscale } : {}), ...(lan ? { lan: lan === 'on' } : {}) });
  console.log(`vindu: ${a.url}`); if (open) openAddress(a.url);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {
    if (stopping) process.exit(1); // a second Ctrl-C: at once
    stopping = true; console.log('vindu: stopping'); void a.close().finally(() => process.exit(0));
  });
}
