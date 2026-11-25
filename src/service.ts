// The app's server as a service of the person's own login on this computer, so it runs with no terminal: started at
// login and started again if it stops, on a Mac (a launch agent), on Linux (a systemd user unit) and on Windows (a task
// at logon, run hidden). Only when the person asks: `node dist/src/main.js --service install`, and `--service remove`
// takes it back. The Electron app does this itself on a computer it is installed on (Open at login, in its menu).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LABEL = 'net.vindu.server';
export type ServicePlan = { file: string; content: string; load: string[][]; unload: string[][] };
type Where = { platform: NodeJS.Platform; home: string; node: string; main: string; uid?: number; env?: Record<string, string>; appData?: string };

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** What a service of the app's server is on this system: its file, and the commands that start it and take it back. */
export function servicePlan(w: Where): ServicePlan {
  const env = { PATH: process.env.PATH ?? '', ...w.env };
  if (w.platform === 'darwin') {
    const log = path.join(w.home, 'Library', 'Logs', 'vindu.log'), file = path.join(w.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(w.node)}</string><string>${xml(w.main)}</string><string>--no-open</string></array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    const domain = `gui/${w.uid ?? process.getuid?.() ?? 501}`;
    return { file, content, load: [['launchctl', 'bootstrap', domain, file]], unload: [['launchctl', 'bootout', `${domain}/${LABEL}`]] };
  }
  if (w.platform === 'win32') {
    const dir = path.join(w.appData ?? path.join(w.home, 'AppData', 'Roaming'), 'vindu'), file = path.join(dir, 'start.vbs');
    const q = (s: string) => `""${s.replace(/"/g, '')}""`;
    const content = `' vindu's server at logon, with no window: scheduled by \`--service install\`\r\nCreateObject("WScript.Shell").Run "${q(w.node)} ${q(w.main)} --no-open", 0, False\r\n`;
    return { file, content, load: [['schtasks', '/Create', '/F', '/TN', 'vindu', '/SC', 'ONLOGON', '/TR', `wscript.exe "${file}"`], ['schtasks', '/Run', '/TN', 'vindu']], unload: [['schtasks', '/Delete', '/F', '/TN', 'vindu']] };
  }
  const file = path.join(w.home, '.config', 'systemd', 'user', 'vindu.service');
  const content = `[Unit]
Description=vindu's server

[Service]
ExecStart=${[w.node, w.main, '--no-open'].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}
${Object.entries(env).map(([k, v]) => `Environment="${k}=${v.replace(/"/g, '')}"`).join('\n')}
Restart=on-failure

[Install]
WantedBy=default.target
`;
  return { file, content, load: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'vindu.service']], unload: [['systemctl', '--user', 'disable', '--now', 'vindu.service']] };
}

const run = (cmd: string[]) => new Promise<{ ok: boolean; out: string }>(resolve => execFile(cmd[0], cmd.slice(1), { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() })));

/** The service written and started; its file and what each command said. */
export async function installService(w: Where, exec: (cmd: string[]) => Promise<{ ok: boolean; out: string }> = run) {
  const p = servicePlan(w);
  for (const c of p.unload) await exec(c); // one there already goes first: this one replaces it
  fs.mkdirSync(path.dirname(p.file), { recursive: true }); fs.writeFileSync(p.file, p.content);
  const said = []; for (const c of p.load) said.push({ cmd: c.join(' '), ...(await exec(c)) });
  return { file: p.file, said };
}
/** The service stopped and its file gone. */
export async function removeService(w: Where, exec: (cmd: string[]) => Promise<{ ok: boolean; out: string }> = run) {
  const p = servicePlan(w); const said = [];
  for (const c of p.unload) said.push({ cmd: c.join(' '), ...(await exec(c)) });
  fs.rmSync(p.file, { force: true });
  return { file: p.file, said };
}
