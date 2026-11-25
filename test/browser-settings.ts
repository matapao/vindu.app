// Desktop's Settings, in a Chromium of the test's own (Playwright's): Processors (what Vindu may use, what each still
// needs, and its day's budget) and Notifications, from the Settings button in Activity's head. In a narrow window
// Settings takes Activity's whole column, and Done brings the tasks back. No page of any other origin can frame Desktop,
// and Desktop's page is the one the person installs.
// Not part of npm test: it needs that Chromium.   node dist/test/browser-settings.js
import fs from 'node:fs';
import { processors } from './synthetic-processor.js';
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

await (async () => {
  let code = 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-home-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-data-'));
  const checkProcessors = async () => [{ id: 'claude', name: 'Claude Code', found: true, ready: true, detail: 'Claude Code 9.9.9' },
    { id: 'codex', name: 'Codex', found: true, ready: false, detail: 'Codex 9.9.9 · not signed in for Vindu' }];
  const a = await startApp({ userData, home: dir, port: 17720, processors, checkProcessors });
  const browser = await chromium.launch({ headless: true });
  try {
    // a narrow window: Settings in place of the tasks, and Done brings them back
    const narrow = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    const problems: string[] = []; narrow.on('pageerror', e => problems.push(String(e)));
    await narrow.goto(a.url);
    await until(() => narrow.locator('#setup-open').isVisible(), 'Activity\'s head');
    check(await narrow.title() === 'Vindu' && await narrow.locator('#prompt').count() === 1, 'the address the person opens is Desktop itself');
    await narrow.click('#setup-open');
    await until(() => narrow.locator('#setup-processors').isVisible(), 'Settings, with Processors');
    check(await narrow.locator('#list').isHidden() && await narrow.locator('#composer').isHidden() && await narrow.locator('#setup-notices').isVisible(), 'in a narrow window, Settings takes Activity\'s column, the tasks and the prompt behind it');
    await narrow.click('#setup-done');
    check(await narrow.locator('#setup').isHidden() && await narrow.locator('#list').isVisible() && await narrow.locator('#composer').isVisible(), 'Done: the tasks and the prompt again');
    // another page may not frame Desktop
    const other = await (await browser.newContext()).newPage();
    await other.setContent(`<iframe id="f" src="${a.desktop.url}"></iframe>`);
    await sleep(800);
    const shown = await Promise.all(other.frames().filter(f => f !== other.mainFrame()).map(f => f.evaluate(() => !!document.getElementById('prompt')).catch(() => false)));
    check(!shown.some(Boolean), 'a page of any other origin can\'t frame Desktop');
    // Settings, on a wide window: this computer, its notifications, and nothing that reaches another device
    const pc = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    pc.on('pageerror', e => problems.push(String(e)));
    await pc.goto(a.url); await pc.click('#setup-open');
    await until(async () => (await pc.locator('#setup-host').innerText()).startsWith('On '), 'this computer\'s name');
    check((await pc.locator('#setup-notices-state').innerText()).startsWith('Notifications on this computer are') && !(await pc.locator('#setup').innerText()).match(/phone|pair|tailnet|Wi-Fi/i),
      'Settings says whether this computer shows the app\'s notifications, and offers no phone, pairing or network');
    // installed: a picture for Safari's Home Screen and Dock, and pictures in the manifest beside the drawing
    const touch = await fetch(`${a.url}apple-touch-icon`); const m = await (await fetch(`${a.url}manifest.webmanifest`)).json() as { name: string; icons: { src: string; sizes: string; type: string }[] };
    check(m.name === 'Vindu' && touch.ok && touch.headers.get('content-type') === 'image/png' && m.icons.some(i => i.sizes === '512x512' && i.type === 'image/png') && m.icons.some(i => i.type === 'image/svg+xml'), 'installed, Desktop has a picture for Safari\'s Home Screen and the manifest\'s sizes, beside its drawing');
    // Processors, on the computer: what Vindu may use, and its day's budget
    const codex = '#setup-harnesses input[data-processor="codex"]';
    await until(() => pc.locator(codex).count(), 'Processors');
    check(await pc.locator('#setup-harnesses input[data-processor="claude"]').isChecked() && await pc.locator(codex).isChecked() && (await pc.locator('#setup-harnesses').innerText()).includes('Codex'), 'Vindu has the registered harnesses, by their names');
    const needs = pc.locator('#setup-harnesses p.check[data-check="codex"]');
    await until(() => needs.isVisible(), 'what Codex still needs');
    check(await needs.innerText() === 'Codex 9.9.9 · not signed in for Vindu' && await needs.evaluate(e => e.classList.contains('needs')) && await pc.locator('#setup-harnesses p.check[data-check="claude"]').innerText() === 'Claude Code 9.9.9',
      'under each harness, what its check says: its version, and what it still needs before it takes a turn');
    await pc.uncheck(codex);
    await until(() => !a.celler.grants().includes('codex'), 'Codex taken away through Celler');
    await pc.check(codex);
    await until(() => a.celler.grants().includes('codex'), 'Codex given back');
    check(true, 'the person takes a harness from Vindu and gives it back, in Settings');
    const tokens = '#setup-limits input[data-limit="tokens"]';
    check((await pc.locator('#setup-spent').innerText()).startsWith('Today: 0 tokens') && await pc.locator(tokens).inputValue() === '', 'Vindu\'s day: nothing held back until the person sets it');
    await pc.fill(tokens, '20000'); await pc.press(tokens, 'Enter');
    await until(() => a.celler.budget().tokens === 20000, 'the budget kept');
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
