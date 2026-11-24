// The core as a service of the person's login (service.ts), for each system, in a home of the test's own and with a
// command runner of its own: its file says how to start the same core with no terminal, the system's own commands start
// it and take it back, and removing it leaves nothing.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installService, removeService, servicePlan } from '../src/service.js';

const ran: string[][] = [];
const exec = async (cmd: string[]) => { ran.push(cmd); return { ok: true, out: '' }; };

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(`${platform}: written, started by the system's own commands, and taken back`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `service-${platform}-`)); ran.length = 0;
    const w = { platform, home, node: '/opt/node/bin/node', main: '/Applications/vindu/dist/src/main.js', uid: 501, env: { VINDU_PORT: '7310' }, appData: path.join(home, 'AppData', 'Roaming') };
    const r = await installService(w, exec);
    const text = fs.readFileSync(r.file, 'utf8');
    assert.ok(text.includes('/opt/node/bin/node') && text.includes('/Applications/vindu/dist/src/main.js') && text.includes('--no-open'), 'the same core, with no window of its own');
    if (platform !== 'win32') assert.ok(text.includes('VINDU_PORT') && text.includes('7310'), 'its port as it was given');
    const plan = servicePlan(w);
    assert.deepEqual(ran, [...plan.unload, ...plan.load]); // one there already goes first
    if (platform === 'darwin') { assert.equal(r.file, path.join(home, 'Library', 'LaunchAgents', 'net.vindu.core.plist')); assert.deepEqual(plan.load, [['launchctl', 'bootstrap', 'gui/501', r.file]]); assert.match(text, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/); }
    if (platform === 'linux') { assert.equal(r.file, path.join(home, '.config', 'systemd', 'user', 'vindu.service')); assert.ok(text.includes('Restart=on-failure') && r.note?.includes('enable-linger')); }
    if (platform === 'win32') { assert.ok(plan.load[0].includes('ONLOGON') && plan.load[0].at(-1)!.startsWith('wscript.exe')); assert.ok(text.includes(', 0, False'), 'run hidden'); }
    ran.length = 0;
    await removeService(w, exec);
    assert.deepEqual(ran, plan.unload); assert.ok(!fs.existsSync(r.file));
  });
}
