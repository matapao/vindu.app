// Desktop's Settings, in a Chromium of the test's own (Playwright's), with a Tailscale of the test's own (its command line,
// which changes nothing): Processors (what Vindu may use, and its day's budget) and Phone, from the Settings button in
// Activity's head. At a phone's width Settings takes Activity's whole column, and Done brings the tasks back. On the
// computer, Phone says where Tailscale is, puts the core on the tailnet when the person says, and makes a code to pair a
// device with; a device paired by an owner's code shows Processors, another device does not. No page of any other origin
// can frame Desktop, and Desktop's page is the one the person installs.
// Not part of npm test: it needs that Chromium.   node dist/test/browser-settings.js
import fs from 'node:fs';
import { processors } from './consumer.js';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startApp } from '../src/app.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const check = (cond: unknown, what: string) => { if (!cond) throw new Error(`not ok: ${what}`); console.log(`ok ${++passed} - ${what}`); };
async function until<T>(f: () => Promise<T> | T, what: string, ms = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); }
}
const HOST = 'mac.tail1234.ts.net';

await (async () => {
  let code = 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-ts-')), cli = path.join(dir, 'tailscale'), calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'); const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + '\\n');
if (a[0] === 'status') { console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: '${HOST}.' }, CertDomains: ['${HOST}'] })); process.exit(0); }
if (a[0] === 'serve' && a[1] === 'status') { console.log('{}'); process.exit(0); }
process.exit(a[0] === 'serve' ? 0 : 1);
`, { mode: 0o755 });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-data-'));
  const a = await startApp({ userData, home: dir, port: 17720, processors, tailscale: cli });
  const browser = await chromium.launch({ headless: true });
  try {
    // a phone's width: Settings in place of the tasks, and Done brings them back
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    const problems: string[] = []; phone.on('pageerror', e => problems.push(String(e)));
    await phone.goto(a.url);
    await until(() => phone.locator('#setup-open').isVisible(), 'Activity\'s head');
    check(await phone.title() === 'Vindu' && await phone.locator('#prompt').count() === 1, 'the address the person opens is Desktop itself');
    await phone.click('#setup-open');
    await until(() => phone.locator('#setup-processors').isVisible(), 'Settings, with Processors');
    check(await phone.locator('#list').isHidden() && await phone.locator('#composer').isHidden() && await phone.locator('#setup-here').isVisible(), 'at a phone\'s width, Settings takes Activity\'s column, the tasks and the prompt behind it');
    await phone.click('#setup-done');
    check(await phone.locator('#setup').isHidden() && await phone.locator('#list').isVisible() && await phone.locator('#composer').isVisible(), 'Done: the tasks and the prompt again');
    // another page may not frame Desktop
    const other = await (await browser.newContext()).newPage();
    await other.setContent(`<iframe id="f" src="${a.desktop.url}"></iframe>`);
    await sleep(800);
    const shown = await Promise.all(other.frames().filter(f => f !== other.mainFrame()).map(f => f.evaluate(() => !!document.getElementById('prompt')).catch(() => false)));
    check(!shown.some(Boolean), 'a page of any other origin can\'t frame Desktop');
    // Phone, on the computer
    const pc = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    pc.on('pageerror', e => problems.push(String(e)));
    await pc.goto(a.url); await pc.click('#setup-open');
    await until(async () => (await pc.locator('#setup-tailnet').innerText()).includes(HOST), 'Tailscale\'s state');
    check((await pc.locator('#setup-tailnet').innerText()).includes('not on your tailnet yet') && !fs.readFileSync(calls, 'utf8').includes('--bg'), 'Phone says Tailscale is ready, and the core is not on the tailnet until the person says');
    await pc.click('#setup-serve');
    await until(async () => (await pc.locator('#setup-tailnet').innerText()).includes(`https://${HOST}:${a.desktop.port}`), 'served');
    check(fs.readFileSync(calls, 'utf8').split('\n').filter(l => l.includes('--bg')).length === 1, 'put on the tailnet when the person says: Desktop, at its port');
    await pc.click('#setup-new-code');
    await until(async () => /^\d{6}$/.test((await pc.locator('#setup-code').innerText()).trim()), 'a code');
    check((await pc.locator('#setup-pair-at').innerText()) === `https://${HOST}:${a.desktop.port}/pair`, 'a code to pair a device with, and the address to type it at');
    // an owner's code: the device it pairs shows Processors, as this computer does; a device of a plain code does not
    const pairAt = async (code: string, name: string) => { const r = await fetch(`http://127.0.0.1:${a.desktop.port}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${a.desktop.port}` }, body: JSON.stringify({ code, name }) });
      return `http://127.0.0.1:${a.desktop.port}${(await r.json() as { url: string }).url}`; };
    await pc.check('#setup-owner-code'); await pc.click('#setup-new-code');
    await until(async () => (await pc.locator('#setup-code-until').innerText()).includes('for an owner device'), 'an owner\'s code');
    const owned = await browser.newPage(); await owned.goto(await pairAt((await pc.locator('#setup-code').innerText()).trim(), 'An owner'));
    await pc.uncheck('#setup-owner-code'); await pc.click('#setup-new-code');
    await until(async () => !(await pc.locator('#setup-code-until').innerText()).includes('owner'), 'a plain code');
    const plain = await browser.newPage(); await plain.goto(await pairAt((await pc.locator('#setup-code').innerText()).trim(), 'A phone'));
    for (const p of [owned, plain]) { await p.click('#setup-open'); await until(async () => (await p.locator('#setup-device-name').innerText()).length > 0, 'the device\'s Settings'); }
    check(await owned.locator('#setup-processors').isVisible() && await plain.locator('#setup-processors').isHidden() && (await plain.locator('#setup-device-name').innerText()) === 'A phone',
      'a device paired by an owner\'s code shows Processors; another device does not, and says it is paired');
    await owned.close(); await plain.close();
    // installed: a picture for Safari's Home Screen and Dock, and pictures in the manifest beside the drawing
    const touch = await fetch(`${a.url}apple-touch-icon`); const m = await (await fetch(`${a.url}manifest.webmanifest`)).json() as { name: string; icons: { src: string; sizes: string; type: string }[] };
    check(m.name === 'Vindu' && touch.ok && touch.headers.get('content-type') === 'image/png' && m.icons.some(i => i.sizes === '512x512' && i.type === 'image/png') && m.icons.some(i => i.type === 'image/svg+xml'), 'installed, Desktop has a picture for Safari\'s Home Screen and the manifest\'s sizes, beside its drawing');
    // Processors, on the computer: what Vindu may use, and its day's budget
    const codex = '#setup-harnesses input[data-processor="codex"]';
    await until(() => pc.locator(codex).count(), 'Processors');
    check(await pc.locator('#setup-harnesses input[data-processor="claude"]').isChecked() && await pc.locator(codex).isChecked() && (await pc.locator('#setup-harnesses').innerText()).includes('Codex'), 'Vindu has the registered harnesses, by their names');
    await pc.uncheck(codex);
    await until(() => !a.celler.grants('desktop').includes('codex'), 'Codex taken away through Celler');
    await pc.check(codex);
    await until(() => a.celler.grants('desktop').includes('codex'), 'Codex given back');
    check(true, 'the person takes a harness from Vindu and gives it back, in Settings');
    const tokens = '#setup-limits input[data-limit="tokens"]';
    check((await pc.locator('#setup-spent').innerText()).startsWith('Today: 0 tokens') && await pc.locator(tokens).inputValue() === '', 'Vindu\'s day: nothing held back until the person sets it');
    await pc.fill(tokens, '20000'); await pc.press(tokens, 'Enter');
    await until(() => a.celler.budget('desktop').tokens === 20000, 'the budget kept');
    check(await pc.locator(tokens).inputValue() === '20000', 'the person sets Vindu\'s day in Settings');
    check(!problems.length, `no errors in Desktop's page${problems.length ? `: ${problems.join(' | ')}` : ''}`);
    code = 0;
  } finally {
    await browser.close();
    await a.close();
    for (const folder of [dir, userData]) fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log(`# ${passed} passed`);
  process.exit(code);
})();
