// The shell's page where there are no tabs, and its Phone, in a Chromium of the test's own (Playwright's), with a
// Tailscale of the test's own (its command line, which changes nothing): at a phone's width an app opens in a tab of the
// shell's own, its page in a frame there, which Desktop's page allows the shell and no other page; the grid is a tap away,
// and the app's tab stays, its page as it was. On the computer, Phone
// says where Tailscale is, puts the core on the tailnet when the person says, and makes a code to pair a device with.
// Not part of npm test: it needs that Chromium.   node dist/test/browser-shell.js
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-ts-')), cli = path.join(dir, 'tailscale'), calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'); const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + '\\n');
if (a[0] === 'status') { console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: '${HOST}.' }, CertDomains: ['${HOST}'] })); process.exit(0); }
if (a[0] === 'serve' && a[1] === 'status') { console.log('{}'); process.exit(0); }
process.exit(a[0] === 'serve' ? 0 : 1);
`, { mode: 0o755 });
  // An app of the grid that asks for processors.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-data-')), appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-app-'));
  fs.writeFileSync(path.join(appDir, 'app.json'), JSON.stringify({ id: 'arcade', name: 'Arcade', icon: 'icon.svg', asks: ['processors'], serve: { command: 'node', args: ['-e', ''] } }));
  fs.writeFileSync(path.join(appDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ installed: [appDir] }));
  const a = await startApp({ userData, home: dir, port: 17720, processors, tailscale: cli });
  const browser = await chromium.launch({ headless: true });
  try {
    // a phone's width: Desktop in a frame over the shell, with the way back
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    const problems: string[] = []; phone.on('pageerror', e => problems.push(String(e)));
    await phone.goto(a.url);
    await until(() => phone.locator('button.app[data-app="desktop"]').count(), 'the grid');
    await phone.click('button.app[data-app="desktop"]');
    await until(() => phone.locator('#frames:not([hidden])').count(), 'the app, here');
    check(await phone.locator('.tab[data-app="desktop"][aria-selected="true"]').count() === 1 && await phone.title() === 'Vindu' && await phone.locator('#grid').isHidden(), 'at a phone\'s width, an app opens here, in a tab of the shell\'s own, not a tab of the browser\'s');
    const desk = await until(() => phone.frames().find(f => f.url().startsWith(a.desktop.url)), 'Desktop\'s page in the frame');
    await until(() => desk.evaluate(() => !!document.getElementById('prompt')).catch(() => false), 'Desktop\'s page, working in the frame');
    check(true, 'Desktop\'s page lets the shell frame it, and works there (its socket, its bar)');
    await desk.evaluate(() => { (window as unknown as { kept: string }).kept = 'this page'; });
    await phone.click('#home');
    check(await phone.locator('#frames').isHidden() && await phone.locator('#grid').isVisible() && await phone.locator('.tab[data-app="desktop"]').count() === 1, 'the grid is a tap away, and the app\'s tab stays');
    await phone.click('.tab[data-app="desktop"] .name');
    check(await desk.evaluate(() => (window as unknown as { kept?: string }).kept) === 'this page', 'back in its tab, the app\'s page is as it was, not loaded again');
    // another page may not frame Desktop
    const other = await (await browser.newContext()).newPage();
    await other.setContent(`<iframe id="f" src="${a.desktop.url}"></iframe>`);
    await sleep(800);
    const shown = await Promise.all(other.frames().filter(f => f !== other.mainFrame()).map(f => f.evaluate(() => !!document.getElementById('prompt')).catch(() => false)));
    check(!shown.some(Boolean), 'a page of any other origin can\'t frame Desktop');
    // Phone, on the computer
    const pc = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await pc.goto(a.url); await pc.click('#phones');
    await until(async () => (await pc.locator('#tailnet').innerText()).includes(HOST), 'Tailscale\'s state');
    check((await pc.locator('#tailnet').innerText()).includes('not on your tailnet yet') && !fs.readFileSync(calls, 'utf8').includes('--bg'), 'Phone says Tailscale is ready, and the core is not on the tailnet until the person says');
    await pc.click('#serve');
    await until(async () => (await pc.locator('#tailnet').innerText()).includes(`https://${HOST}:${a.shell.page.port}`), 'served');
    check(fs.readFileSync(calls, 'utf8').split('\n').filter(l => l.includes('--bg')).length === 2, 'put on the tailnet when the person says: the shell and Desktop, each at its own port');
    await pc.click('#new-code');
    await until(async () => /^\d{6}$/.test((await pc.locator('#code').innerText()).trim()), 'a code');
    check((await pc.locator('#pair-at').innerText()) === `https://${HOST}:${a.shell.page.port}/pair`, 'a code to pair a device with, and the address to type it at');
    // an owner's code: the device it pairs shows Processors, as this computer does; a device of a plain code does not
    const pairAt = async (code: string, name: string) => { const r = await fetch(`http://127.0.0.1:${a.shell.page.port}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${a.shell.page.port}` }, body: JSON.stringify({ code, name }) });
      return `http://127.0.0.1:${a.shell.page.port}${(await r.json() as { url: string }).url}`; };
    await pc.check('#owner-code'); await pc.click('#new-code');
    await until(async () => (await pc.locator('#code-until').innerText()).includes('for an owner device'), 'an owner\'s code');
    const owned = await browser.newPage(); await owned.goto(await pairAt((await pc.locator('#code').innerText()).trim(), 'An owner'));
    await until(() => owned.locator('#grid .app').count(), 'the owner device\'s grid');
    await pc.uncheck('#owner-code'); await pc.click('#new-code');
    await until(async () => !(await pc.locator('#code-until').innerText()).includes('owner'), 'a plain code');
    const plain = await browser.newPage(); await plain.goto(await pairAt((await pc.locator('#code').innerText()).trim(), 'A phone'));
    await until(() => plain.locator('#grid .app').count(), 'the device\'s grid');
    check(await owned.locator('#procs').isVisible() && await plain.locator('#procs').isHidden(), 'a device paired by an owner\'s code shows Processors; another device does not');
    await owned.close(); await plain.close();
    // installed: a picture for Safari's Home Screen and Dock, and pictures in the manifest beside the drawing
    const touch = await fetch(`${a.url}apple-touch-icon`); const m = await (await fetch(`${a.url}manifest.webmanifest`)).json() as { icons: { src: string; sizes: string; type: string }[] };
    check(touch.ok && touch.headers.get('content-type') === 'image/png' && m.icons.some(i => i.sizes === '512x512' && i.type === 'image/png') && m.icons.some(i => i.type === 'image/svg+xml'), 'installed, it has a picture for Safari\'s Home Screen and the manifest\'s sizes, beside its drawing');
    // Processors, on the computer: what each app may use, and its day's budget
    await pc.click('#procs');
    await until(() => pc.locator('#grants tr[data-app="arcade"]').count(), 'Processors');
    check(await pc.locator('#grants tr[data-app="desktop"] input[data-processor="claude"]').isChecked() && !(await pc.locator('#grants tr[data-app="arcade"] input[data-processor="claude"]').isChecked()), 'Desktop has the harnesses; an app has none until the person ticks them');
    check((await pc.locator('#list .proc b').allTextContents()).includes('Codex'), 'the processor list shows the registered name');
    await pc.check('#grants tr[data-app="arcade"] input[data-processor="codex"]');
    await until(() => a.celler.grants('arcade').includes('codex'), 'Codex granted through Celler');
    check(true, 'the person grants a processor to a folder app in Processors');
    await until(() => pc.locator('#budgets tr[data-app="arcade"] input[data-limit="tokens"]').count(), 'the budgets');
    check((await pc.locator('#budgets tr[data-app="desktop"] td[data-spent]').innerText()).startsWith('0 tokens'), 'each app\'s day, Desktop\'s included: nothing held back until the person sets it');
    await pc.fill('#budgets tr[data-app="arcade"] input[data-limit="tokens"]', '20000'); await pc.press('#budgets tr[data-app="arcade"] input[data-limit="tokens"]', 'Enter');
    await until(() => a.celler.budget('arcade').tokens === 20000, 'the budget kept');
    check(await pc.locator('#budgets tr[data-app="arcade"] input[data-limit="tokens"]').inputValue() === '20000', 'the person sets an app\'s day under Processors');
    // what an app's notice says reaches the shell on the computer
    const { CELLER_URL, CELLER_TOKEN } = a.appAccess('arcade');
    const notified = await fetch(`${CELLER_URL}/notify`, { method: 'POST',
      headers: { authorization: `Bearer ${CELLER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'A game is ready', body: 'Boat Race, version 3' }) });
    check(notified.ok, 'the app reports its notice through its authenticated endpoint');
    await until(async () => (await pc.locator('#note').innerText()).includes('A game is ready'), 'the notice in the shell');
    check(true, 'an app\'s notice reaches the shell on the computer, under the app\'s name');
    check(!problems.length, `no errors in the shell${problems.length ? `: ${problems.join(' | ')}` : ''}`);
    code = 0;
  } finally {
    await browser.close();
    await a.close();
    for (const folder of [dir, userData, appDir]) fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log(`# ${passed} passed`);
  process.exit(code);
})();
