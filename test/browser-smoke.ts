// The app itself, in a browser: Desktop, at the address the app gives, with Processors in its Settings, a task with the
// test's own harness there, and a terminal and browser pages as views, as the person uses them and as the
// model gets them, through the UI server. What the harness asks is answered in the task's thread, in Activity. The test
// opens the app's pages in a Chromium of its own (Playwright's), as the person's browser would. Not part of npm test,
// since it needs Playwright's Chromium (its headless shell, and Chromium in full for installing pages as web apps):
//   node dist/test/browser-smoke.js
// It reads what lies where from the pages' own boxes and the pictured pages' sizes, never from pictures; SMOKE_SHOT=<file>
// also saves the window, for a person to look at. "Another site" is this machine under another name. Synthetic data only.
import fs from 'node:fs';
import { connectSyntheticProcessor, processors } from './synthetic-processor.js';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { readZip } from '../src/task-archive.js';
import { startApp } from '../src/app.js';
import type { Secrets } from '../src/secrets.js';

const HOSTS = ['--host-resolver-rules=MAP other-site.test 127.0.0.1']; // "another site", served here
/** Keys kept in memory, as the system's store keeps them: the test leaves the person's keychain alone. */
const memory = (): Secrets => { const kept = new Map<string, string>(); return { available: async () => true, set: async (n, v) => { kept.set(n, v); return 'memory'; }, get: async n => kept.get(n), clear: async n => { kept.delete(n); } }; };
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const check = (cond: unknown, what: string) => { if (!cond) throw new Error(`not ok: ${what}`); console.log(`ok ${++passed} - ${what}`); };
async function until<T>(f: () => Promise<T> | T, what: string, ms = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(50); }
}

await (async () => {
  let code = 1;
  let port = 0;
  const site = http.createServer((q, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>${q.headers.host?.startsWith('other-site.test') ? 'Elsewhere (synthetic)' : 'Ledger (synthetic)'}</title><body style="font:15px system-ui;padding:16px"><h1>Invoices</h1><p>INV-2026-0412 · 31 050 kr · overdue</p><button onclick="this.textContent='Paid'; window.clicks = (window.clicks || 0) + 1">Pay INV-2026-0412</button> <a href="http://other-site.test:${port}/">The bank (another site)</a></body>`));
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  port = (site.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/`, other = `http://other-site.test:${port}/`;
  const work = tmp('work-'), userData = tmp('userdata-'), tasksRoot = tmp('tasks-');
  // where a task gets a folder of its own when the person picks none
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ terminal: { shell: 'bash', login: false }, jobs: { on: true, perDay: 2 }, tasksFolder: tasksRoot }));
  // a connector: an HTTP API, described in plain words, with its guide; it takes a key the person has not set
  const conn = path.join(userData, 'connectors', 'accounts'); fs.mkdirSync(conn, { recursive: true });
  fs.writeFileSync(path.join(conn, 'connector.json'), JSON.stringify({ name: 'accounts', title: 'Accounts', kind: 'http', http: { base: `http://127.0.0.1:9/v1`, auth: { type: 'bearer', secret: 'accounts-key' } } }));
  fs.writeFileSync(path.join(conn, 'api.txt'), 'GET /invoices?status=overdue lists the overdue invoices.\n');
  fs.writeFileSync(path.join(conn, 'SKILL.md'), '---\nname: accounts\ndescription: Invoices in Accounts. Use when following up unpaid invoices.\n---\n# Accounts\n');
  const exportTo = path.join(tmp('export-'), 'task.zip');
  const a = await startApp({ userData, port: 17300, browserArgs: HOSTS, secrets: memory(), pickFolder: async () => work, pickSave: async () => exportTo, processors, connect: connectSyntheticProcessor });
  const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 1440, height: 856 } });
  const errors: string[] = [];
  const watch = (p: Page) => { p.on('console', m => { if (m.type() === 'error') errors.push(`${new URL(p.url()).port}: ${m.text()}`); }); p.on('pageerror', e => errors.push(`${new URL(p.url()).port}: ${e.message}`)); };
  const page = await context.newPage(); watch(page); await page.goto(a.url); // Desktop, at the address the app gives the person
  const js = <T = unknown>(code: string) => page.evaluate(code) as Promise<T>;
  const rect = (sel: string) => js<{ x: number; y: number; w: number; h: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  const click = (sel: string) => js<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  /** A button in a pane by what it says, through the shadow roots an ask's A2UI components draw in. */
  const press = (sel: string, label: string) => js<boolean>(`(() => {
    const text = n => [...n.childNodes].map(c => c.nodeType === 3 ? c.data : c.nodeType === 1 ? (c.shadowRoot ? text(c.shadowRoot) : '') + text(c) : '').join('');
    const buttons = n => [...n.querySelectorAll('*')].flatMap(e => [...(e.tagName === 'BUTTON' ? [e] : []), ...(e.shadowRoot ? buttons(e.shadowRoot) : [])]);
    const root = document.querySelector(${JSON.stringify(sel)}); const b = root && buttons(root).find(b => text(b).trim() === ${JSON.stringify(label)});
    if (!b) return false; b.click(); return true; })()`);
  const pane = (v: string) => `.task:not([hidden]) .vindu-pane[data-view="${v}"]`;
  const pageOf = (name: string) => a.pages(task).find(p => p.name === name);
  const shot = async (name: string) => { if (process.env.SMOKE_SHOT) await page.screenshot({ path: process.env.SMOKE_SHOT.replace(/\.png$/, `-${name}.png`) }); };
  let task = '';
  try {
    // Desktop is what the person opens: its own page, only with its token
    const codex = '#setup-harnesses input[data-processor="codex"]';
    const harnesses = () => js<string>(`[...document.getElementById('harness').options].map(o => o.value).join()`);
    await until(() => js<boolean>('!!document.getElementById("prompt")'), 'Desktop');
    check(a.url === a.desktop.url && await js<boolean>(`typeof window.desktop.create === 'function'`) && await fetch(a.url.replace(/\/[\w-]+\/$/, '/not-the-token/')).then(r => r.status) === 404,
      'the app\'s address is Desktop\'s own page, only with its token');
    // Processors, in Desktop's Settings: the harnesses Vindu may use; its picker follows, and a task is refused one it may not use
    await page.click('#setup-open');
    await until(() => js<boolean>(`!!document.querySelector('${codex}')`), 'Processors in Settings');
    const picker = page.locator('#setup-harnesses input[data-processor]');
    check((await page.locator('#setup-harnesses label span').allTextContents()).join(',') === 'Claude Code,Codex'
      && await picker.count() === 2 && await picker.evaluateAll(inputs => inputs.every(input => (input as HTMLInputElement).checked)),
      'the registered processors are selected for Vindu, in Settings');
    await page.click(codex);
    await until(async () => await harnesses() === 'claude', 'Codex gone from Desktop\'s picker');
    const unpicked = await js<string>(`desktop.create({ id: 'no-pick', harness: 'claude', folder: ${JSON.stringify(work)} }).then(() => 'started', e => String(e.message))`);
    check(/Choose the working folder/.test(unpicked) && !a.tasks.size, 'a task can use only a folder chosen in its window');
    const refused = await js<string>(`desktop.create({ id: 'not-granted', harness: 'codex', title: 'x', servers: [] }).then(() => 'started', e => String(e.message))`);
    check(a.celler.grants().includes('claude') && !a.celler.grants().includes('codex') && /Codex is not one of Vindu's processors/.test(refused) && !a.tasks.size,
      'untick Codex for Desktop: its picker has Claude Code alone, and a task with Codex is refused all the same');
    await page.click(codex);
    await until(async () => await harnesses() === 'claude,codex', 'Codex back in Desktop\'s picker');
    check(true, 'tick it again: Codex is back in Desktop\'s picker, at once');
    await page.click('#setup-done');
    // as web apps, in full Chromium with a profile of its own, as the person's browser is (its headless shell says nothing
    // stands in the way of any page): Desktop's page installs, opening at its token's address; a page with no manifest (the
    // test's ledger) does not
    const profile = tmp('profile-'), installs = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true });
    try {
      const asApp = async (url: string) => {
        const p = await installs.newPage(); await p.goto(url);
        const s = await installs.newCDPSession(p);
        const m = await s.send('Page.getAppManifest'), { installabilityErrors } = await s.send('Page.getInstallabilityErrors');
        await p.close();
        const data = (m.data ? JSON.parse(m.data) : {}) as { name?: string; start_url?: string };
        return { name: data.name, start: data.start_url && new URL(data.start_url, m.url).href, errors: [...m.errors.map(e => e.message), ...installabilityErrors.map(e => e.errorId)] };
      };
      const desktopApp = await asApp(a.url), none = await asApp(base);
      check(desktopApp.name === 'Vindu' && desktopApp.start === a.url && !desktopApp.errors.length,
        'Desktop\'s page installs as a web app: nothing in the way, a manifest from its name and icon, opening at its token\'s address');
      check(none.errors.includes('no-manifest'), 'a page with no manifest does not (the test\'s ledger)');
    } finally { await installs.close(); fs.rmSync(profile, { recursive: true, force: true }); }
    await page.bringToFront();
    await until(() => js<boolean>('!!document.getElementById("place")'), 'the window');
    await until(() => js<boolean>(`!document.getElementById('connectors').hidden`), 'the connectors by the prompt');
    check(await js<boolean>(`(() => { const b = document.querySelector('#connectors button[data-connector="accounts"]'); return !!b && b.textContent.trim() === 'Accounts' && b.getAttribute('aria-pressed') === 'true' && b.classList.contains('missing') && /no key yet/.test(b.title); })()`),
      'the new task\'s prompt offers the connectors, each on, and says which has no key yet');
    check(await js<boolean>('typeof window.keys === "undefined" && typeof window.desktop.keys === "function"'), 'Desktop\'s page can open the keys page, and cannot reach the keys');
    await click('#place'); // the person picks the folder (the test's): with it, the task starts with no prompt
    await until(() => js<boolean>('!document.getElementById("send").disabled'), 'a folder for the next task');
    await click('#send');
    task = await until(() => [...a.tasks.keys()][0], 'a task in the folder');
    const t = a.tasks.get(task)!, views = t.views!;
    await until(() => js<boolean>('!document.getElementById("opens").hidden'), 'its thread\'s bar');
    check(true, 'the task\'s thread has Terminal and Browser once it is open');

    // Layout arrives before the content. The real Vindu renderer fills the same pane on show_view.
    const layoutClient = new Client({ name: 'layout-smoke', version: '1' });
    await layoutClient.connect(new StreamableHTTPClientTransport(new URL(t.ui.url)));
    const layoutCall = async (name: string, args: Record<string, unknown>) => {
      const result = await layoutClient.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    try {
      const reserved = await layoutCall('arrange', {
        reserve: [{ name: 'early-summary', title: 'Summary' }, { name: 'early-detail', title: 'Details' }],
        layout: [{ view: 'early-summary', size: 0.6 }, 'early-detail'], report: 'layout',
      });
      check(reserved.panes.length === 2 && Boolean(reserved.geometry?.viewport),
        'the harness receives two computed pane positions and sizes before either result arrives');
      await until(() => js<boolean>(`document.querySelectorAll('.task:not([hidden]) .vindu-loading').length === 2`), 'two loading panes');
      const before = await rect(pane('early-summary'));
      await shot('waiting');
      await layoutCall('show_view', { name: 'early-summary', title: 'Summary', panels: [{ id: 'n', card: 'kpi', title: 'Items', data: 12 }] });
      await until(() => js<boolean>(`!document.querySelector('${pane('early-summary')} .vindu-loading') && document.querySelector('${pane('early-summary')}')?.textContent.includes('Items')`), 'reserved pane filled');
      check(JSON.stringify(before) === JSON.stringify(await rect(pane('early-summary'))) &&
        await js<boolean>(`!!document.querySelector('${pane('early-detail')} .vindu-loading')`), 'content fills its reservation without moving the other loading pane');
      await layoutCall('arrange', { release: ['early-detail'] });
      await views.end('early-summary');
    } finally { await layoutClient.close(); }

    // a terminal: the person's own shell in the task's folder, drawn by Vindu's terminal pane; not shared until they share it
    await click('#term');
    await until(() => js<boolean>(`!!document.querySelector('${pane('t1')} .xterm-rows')`), 'the terminal pane');
    await js(`document.querySelector('${pane('t1')} .xterm-helper-textarea').focus()`);
    await until(() => views.terminals!.screen('t1').length > 0, 'the prompt');
    await page.keyboard.insertText('echo synthetic-$((6*7))');
    await until(() => views.terminals!.screen('t1').includes('echo synthetic-$((6*7))'), 'the keys in the shell'); // text and keys come by different ways: Enter after the text
    await page.keyboard.press('Enter');
    await until(() => js<boolean>(`document.querySelector('${pane('t1')} .xterm-rows').textContent.includes('synthetic-42')`), 'the output, drawn in the pane').catch(async e => {
      throw new Error(`${(e as Error).message}; the shell's screen: ${JSON.stringify(views.terminals!.screen('t1'))}; the pane's: ${JSON.stringify(await js(`document.querySelector('${pane('t1')} .xterm-rows').textContent`))}; focused: ${await js('document.activeElement?.className')}`);
    });
    check(views.terminals!.commands('t1').at(-1)?.output === 'synthetic-42', 'what the person typed in the pane ran in the shell, with its output from the shell\'s marks');
    check(!views.terminals!.info('t1').shared && await js<boolean>(`!document.querySelector('${pane('t1')} .vindu-share input').checked`), 'the terminal is not shared until the person shares it');
    await click(`${pane('t1')} .vindu-share input`);
    await until(() => views.terminals!.info('t1').shared, 'shared from its pane');
    check(true, 'the person shares it from its pane');

    // a browser page of the person's: in the app's own Chromium, pictured in its pane, at the pane's size
    await click('#page');
    await until(() => pageOf('b1')?.casting, 'the page, pictured');
    await js(`(() => { const f = document.querySelector('${pane('b1')} form.vindu-viewbar'); f.querySelector('input.vindu-address').value = '${base.replace('http://', '')}'; f.requestSubmit(); })()`);
    await until(() => pageOf('b1')?.url === base, 'the address the person typed (no scheme: http for this machine)');
    const slot = (await rect(`${pane('b1')} .vindu-slot`))!;
    await until(() => js<boolean>(`(() => { const i = document.querySelector('${pane('b1')} .vindu-slot img'); return !!i && i.naturalWidth > 0; })()`), 'its picture in the pane');
    const b1 = pageOf('b1')!, laid = await a.pageEval(task, 'b1', '[innerWidth, innerHeight]') as number[];
    check(b1.box?.w === slot.w && b1.box?.h === slot.h && laid[0] === slot.w && laid[1] === slot.h, `the page is laid out at its pane's size, and pictured there (${slot.w} × ${slot.h})`);
    await until(() => js<boolean>(`document.querySelector('${pane('b1')} input.vindu-address').value === '${base}'`), 'the address bar follows the page');
    check(await js<string>(`document.querySelector('${pane('b1')} .vindu-note').textContent`) === 'Your page', 'its bar says whose page it is');

    // the model's side: the UI server, as the harness reaches it; terminals and pages are views like any other
    const ui = new Client({ name: 'smoke', version: '1' }); await ui.connect(new StreamableHTTPClientTransport(new URL(t.ui.url)));
    const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await ui.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean }; return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text); };
    const look = await call('look');
    check(look.panes.find((p: { view: string }) => p.view === 't1')?.kind === 'terminal' && look.panes.find((p: { view: string }) => p.view === 'b1')?.about.shared === false, 'look shows the terminal and the page as panes, like any view');
    check(/has not shared Browser 1 with you/.test((await call('read_view', { view: 'b1' })).error), 'the model cannot read the person\'s page until they share it');
    check((await call('read_view', { view: 't1', last: 1 })).commands?.[0]?.output === 'synthetic-42', 'the shared terminal: the model reads its commands, with their output');
    const view1 = { executeJavaScript: (code: string) => a.pageEval(task, 'b1', code) as Promise<any> }; // the page itself, as the app's Chromium runs it
    await view1.executeJavaScript('document.cookie = "signed_in_as=person-synthetic; path=/"');
    await click(`${pane('b1')} .vindu-share input`);
    const snap: { title: string; tree: { role: string; name: string; ref: string }[] } = await until(async () => (await call('read_view', { view: 'b1' })).snapshot, 'shared');
    const btn = snap.tree.find(n => n.role === 'button')!;
    check(snap.title === 'Ledger (synthetic)' && btn?.name === 'Pay INV-2026-0412', 'shared: the model reads it as its accessibility tree, with references');
    const after = await call('act_in_view', { view: 'b1', action: 'click', ref: btn.ref });
    check(after.snapshot.tree.find((n: { role: string }) => n.role === 'button')?.name === 'Paid' && await view1.executeJavaScript('document.querySelector("button").textContent') === 'Paid', 'the model\'s click lands in the page the person sees');

    // a page of the model's own: show_view with an address, in a pane of its own
    const own = await call('show_view', { name: 'ledger', title: 'Ledger', browser: { url: base } });
    check(own.owner === 'model' && own.snapshot?.title === 'Ledger (synthetic)', 'the model opens a page of its own with show_view: this machine opens without asking');
    await until(() => pageOf('ledger')?.casting, 'its picture, shown');
    await until(() => js<boolean>(`document.querySelector('${pane('ledger')} .vindu-note')?.textContent === "The model's page"`), 'its bar says it is the model\'s');
    const view2 = { executeJavaScript: (code: string) => a.pageEval(task, 'ledger', code) as Promise<any> };
    check(await view2.executeJavaScript('document.cookie') === '' && (await view1.executeJavaScript('document.cookie')).includes('person-synthetic'), 'the model\'s page carries none of the person\'s sign-ins');
    await until(() => a.pages(task).filter(v => v.casting).length === 2, 'both pages pictured');
    // each page laid out and pictured at its pane's size now, after the layout changed for the second
    const fits = async () => { const out: string[] = []; for (const name of ['b1', 'ledger']) {
      const r = (await rect(`${pane(name)} .vindu-slot`))!, b = pageOf(name)?.box, vp = await a.pageEval(task, name, '[innerWidth, innerHeight]') as number[];
      const img = await js<number[]>(`(() => { const i = document.querySelector('${pane(name)} .vindu-slot img'); return i ? [i.naturalWidth, i.naturalHeight] : []; })()`);
      if (!(b?.w === r.w && b?.h === r.h && vp[0] === r.w && vp[1] === r.h && img[0] === r.w && img[1] === r.h)) out.push(`${name}: slot ${r.w}×${r.h}, box ${b?.w}×${b?.h}, page ${vp.join('×')}, picture ${img.join('×')}`);
    } return out; };
    await until(async () => !(await fits()).length, 'each page at its pane\'s size', 5000).catch(async e => { throw new Error(`${(e as Error).message}: ${(await fits()).join('; ')}`); });
    check(true, 'each page is laid out and pictured at its pane\'s size as the layout changes');
    await shot('tiled');

    // another site: the model's page opens it only on the person's yes, asked in the window; once per site
    const link = own.snapshot.tree.find((n: { role: string }) => n.role === 'link');
    await call('act_in_view', { view: 'ledger', action: 'click', ref: link.ref });
    const ask = '#thread .ask:not(.done)'; // what is asked, in the task's thread
    await until(() => js<boolean>(`(document.querySelector('${ask} .ask-title')?.textContent ?? '').includes('Let the model open other-site.test:${port}?')`), 'the person asked, in the window');
    check(pageOf('ledger')!.url === base, 'nothing of the other site loads before the person answers');
    await shot('ask');
    check(await press(ask, 'Deny'), 'the person says no, in the window');
    await until(() => js<boolean>(`!document.querySelector('${ask}')`), 'the ask answered');
    await sleep(300);
    check(pageOf('ledger')!.url === base, 'no: the page stays where it was');
    // the page reaching for it again by itself: a site the person refused stays refused, and nothing is asked
    await call('act_in_view', { view: 'ledger', action: 'click', ref: link.ref });
    await sleep(300);
    check(!(await js<boolean>(`!!document.querySelector('${ask}')`)) && pageOf('ledger')!.url === base, 'the page reaching for it again: a refused site stays refused, unasked');
    // the model asking for the address itself: the person is asked again, each time until a yes
    const going = call('act_in_view', { view: 'ledger', action: 'go_to', url: other });
    await until(() => js<boolean>(`!!document.querySelector('${ask}')`), 'the model asks for it itself: asked again');
    check(await press(ask, 'Allow'), 'the person says yes');
    await going;
    await until(() => pageOf('ledger')?.url === other, 'the other site, loaded');
    const again = await call('act_in_view', { view: 'ledger', action: 'go_to', url: `${other}?again` });
    check(again.snapshot?.title === 'Elsewhere (synthetic)' && !(await js<boolean>(`!!document.querySelector('${ask}')`)), 'the same site again: no second ask');

    // a pane maximized: the others' pages are not pictured while hidden, and are again on restore
    a.send('command', { type: 'maximize', view: 't1' });
    await until(() => a.pages(task).every(v => !v.casting), 'the pages hidden behind the maximized terminal');
    check(true, 'a maximized terminal: the hidden pages are not pictured');
    a.send('command', { type: 'restore' });
    await until(() => a.pages(task).filter(v => v.casting).length === 2, 'back');
    check(true, 'restored: the pages are pictured again, each in its pane');

    // pointing: a row Alt-clicked in a pane, and an element of a page picked with Point: each a chip over the prompt
    await call('show_view', { name: 'inv', title: 'Invoices', panels: [{ id: 'list', card: 'table', data: [{ number: 'INV-2026-0412', amount: 31050 }, { number: 'INV-2026-0431', amount: 17160 }] }] });
    const cell = await until(() => js<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll('${pane('inv')} *')].find(x => x.context?.dataContext?.path === '/panels/p_list/rows/1'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`), 'the row, drawn');
    await page.keyboard.down('Alt'); await page.mouse.click(cell.x, cell.y); await page.keyboard.up('Alt');
    await until(() => js<boolean>(`[...document.querySelectorAll('#chips .chip')].some(c => c.textContent.includes('Invoices: INV-2026-0431'))`), 'the row as a chip');
    check(true, 'Alt-click on a row: a chip over the prompt says what it is, by its values');
    await call('look');
    const pointingLayout = await call('arrange', { layout: [{ column: ['t1', 'inv'] }, { column: ['b1', 'ledger'] }] });
    check(!pointingLayout.error, 'the browser and record are visible together for pointing');
    await until(() => pageOf('b1')?.casting, 'browser visible to point');
    const clicks = await view1.executeJavaScript('window.clicks ?? 0');
    await click(`${pane('b1')} .vindu-point`);
    await sleep(400);
    const at = await view1.executeJavaScript(`(() => { const r = document.querySelector('button').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const s1 = (await rect(`${pane('b1')} .vindu-slot`))!; // the person's mouse is over the page's picture, in its pane
    await page.mouse.move(s1.x + at.x - 4, s1.y + at.y); await page.mouse.move(s1.x + at.x, s1.y + at.y); await sleep(100); // over it first, as a hand does: the page shows what it would pick
    await page.mouse.click(s1.x + at.x, s1.y + at.y);
    await until(() => js<boolean>(`[...document.querySelectorAll('#chips .chip')].some(c => c.textContent.includes('Browser 1: button "Paid"'))`), 'the element as a chip').catch(async e => {
      throw new Error(`${(e as Error).message}; chips: ${await js('[...document.querySelectorAll("#chips .chip")].map(c => c.textContent).join(" | ")')}; selection: ${JSON.stringify(t.selection())}; clicks: ${await view1.executeJavaScript('window.clicks ?? 0')} (before ${clicks}); point button: ${await js(`document.querySelector('${pane('b1')} .vindu-point')?.outerHTML ?? 'none'`)}; notes: ${await js('document.getElementById("thread").textContent')}`);
    });
    check(await view1.executeJavaScript('window.clicks ?? 0') === clicks, 'Point in a page: the click picked the button, by its role and name, and never reached the page');
    check((t.selection() as { element?: string }[]).some(x => x.element), 'what the person points at in a page carries its reference in the model\'s snapshot');
    await js(`document.querySelector('#chips .chip button').click()`);
    await until(() => js<boolean>(`document.querySelectorAll('#chips .chip').length === 1`), 'one taken back');
    check(true, 'a chip\'s × takes it back');

    // Pin this view: a template file, offered when the next task starts
    await click('#pin'); await js(`document.getElementById('pin-name').value = 'Smoke view'`); await click('#pin-save');
    await until(() => fs.existsSync(path.join(a.templatesDir, 'smoke-view.json')), 'the template file');
    await until(() => js<boolean>(`[...document.querySelectorAll('#template option')].some(o => o.textContent === 'View: Smoke view')`), 'offered for the next task');
    check(true, 'Pin this view: kept as a template file, offered when a task starts');

    // a slot the person fills by capturing waits in the bar (and on the phone window); the view is static until let go
    const started = t.useTemplate({ name: 'Site visit', slots: { photos: { title: 'Photos', block: 'media', by: 'person', ask: { capture: 'photo', about: 'Photos of the damage' } } } });
    await until(() => js<boolean>(`document.getElementById('captures').textContent.includes('Photos of the damage (photo)')`), 'the capture, waiting in the bar');
    await until(() => js<boolean>(`document.getElementById('mode').textContent === 'Static view: Site visit' && !document.getElementById('dynamic').hidden`), 'the bar says the view is static');
    check(a.captures().length === 1, 'a slot of the person\'s waits for their photo, in the bar');
    await js(`[...document.querySelectorAll('#captures button')].find(b => b.textContent === 'Not now').click()`);
    await until(() => js<boolean>(`!document.getElementById('captures').textContent`), 'let go');
    await click('#dynamic');
    await until(() => js<boolean>(`document.getElementById('mode').textContent === 'The model composes the view'`), 'dynamic again');
    check((await started).started === true, 'Not now lets the capture go; Let the model change it makes the view dynamic again');

    // the phone window: off until the person turns it on; its page only with the token in its address
    await click('#phone');
    const phoneUrl = await until(() => js<string>(`(document.getElementById('thread').textContent.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\/[\\w-]+\\//) ?? [''])[0]`), 'its address');
    const got = await fetch(phoneUrl);
    check(got.status === 200 && (await got.text()).includes('Views on this phone') && (await fetch(phoneUrl.replace(/\/[\w-]+\/$/, '/not-the-token/'))).status === 404, 'the phone window: on at the person\'s word, on this computer only, its page only with the token');
    await click('#phone');
    await until(() => !a.phone(), 'off');
    check(true, 'and off again');

    // the connector in the task: the note says what it reaches, and that it has no key yet
    await until(() => js<boolean>(`document.getElementById('thread').textContent.includes('Selected connector: Accounts (key missing).')`), 'the connector\'s note');
    check(t.connectors.length === 1 && t.connectors[0].name === 'accounts', 'the task reaches the connector the person left on');

    // reminders: a chip in the bar, the pane with its buttons; the model sets one, the system works out when
    const chip = `.task:not([hidden]) .vindu-bar-rem`;
    await until(() => js<boolean>(`!!document.querySelector('${chip}') && !document.querySelector('${chip}').hidden && document.querySelector('${chip}').textContent === 'Reminders'`), 'the chip');
    const set = await call('remind', { what: 'Chase Havgap Media for INV-2026-0412', when: 'tomorrow at 08:30' });
    check(/^tomorrow \(\d{4}-\d{2}-\d{2}\), at 08:30: /.test(set.set?.how ?? ''), `the model sets a reminder; the system works out when (${set.set?.how})`);
    await until(() => js<boolean>(`document.querySelector('${chip}').textContent === 'Reminders · 1'`), 'the chip counts it');
    await until(() => js<boolean>(`!!document.querySelector('${pane('reminders')}')`), 'the Reminders pane');
    check(await press(pane('reminders'), 'Drop') && await press(pane('reminders'), 'New reminder'), 'the Reminders pane has the person\'s buttons: drop one, set one');
    await until(() => js<boolean>(`document.querySelector('${chip}').textContent === 'Reminders'`), 'dropped');
    const form = await until(() => js<string>(`document.querySelector('${ask}')?.dataset.view ?? ''`), 'the new reminder\'s form, in the thread');
    const inForm = `#thread .ask[data-view="${form}"]`;
    check(await js<boolean>(`(() => { const ins = [...document.querySelectorAll(${JSON.stringify(`${inForm} input`)})].map(e => e.type); return ins.includes('date') && ins.includes('time'); })()`),
      'its When has a date input and a time input');
    check(await press(inForm, 'Decline'), 'the person lets it go');
    a.notify(task, { id: 'm9', what: 'Send the VAT report', at: new Date().toISOString(), said: 'now', how: 'given', by: 'person', state: 'due', set_at: new Date().toISOString() });
    await until(() => js<boolean>(`document.getElementById('thread').textContent.includes('a reminder is due: Send the VAT report')`), 'the due note');
    check(true, `a reminder that comes due: a note in the window${a.notices() ? ', and the system\'s notification' : ' (this system shows no notifications)'}`);

    // the Connector Keys window: its own page and preload; a key goes one way, encrypted by the system's store, or not kept at all
    const kw = await context.newPage(); watch(kw); await kw.goto(await a.openKeys());
    const kjs = <T = unknown>(code: string) => kw.evaluate(code) as Promise<T>;
    await until(() => kjs<boolean>(`document.querySelectorAll('.key').length === 1`), 'its keys');
    check(await kjs<boolean>(`document.querySelector('.key .name').textContent === 'Accounts' && /^None yet: set it here, or as VINDU_KEY_ACCOUNTS_KEY/.test(document.querySelector('.key .where').textContent)`), 'the keys window lists the key Accounts takes, and where it is: none yet');
    const safe = await kjs<boolean>(`!document.querySelector('.key input').disabled`);
    if (safe) {
      await kjs(`(() => { const i = document.querySelector('.key input'); i.value = 'sk-smoke-synthetic'; document.querySelector('.key').requestSubmit(); })()`);
      await until(() => kjs<boolean>(`document.querySelector('.key .where').textContent === "Kept by this computer's keychain"`), 'kept');
      const kept = fs.readFileSync(a.keysFile, 'utf8');
      check(!kept.includes('sk-smoke-synthetic') && JSON.parse(kept)['accounts-key'], 'a key set there is kept encrypted, never as it is');
    } else check(await kjs<boolean>(`document.querySelector('.warn').textContent.startsWith('This system has no safe store for keys')`) && !fs.existsSync(a.keysFile), 'without a safe store on this system, no key is kept: the window says to give it in the environment');
    check(new URL(kw.url()).origin !== a.desktop.origin && await kjs<boolean>(`typeof window.desktop === 'undefined'`), 'the keys page: an origin of its own, which reaches the keys and nothing else');
    await kw.close();

    // the task as one archive: the record and the window's, each file with its digest
    await click('#export');
    await until(() => fs.existsSync(exportTo), 'the archive');
    const zip = readZip(fs.readFileSync(exportTo));
    check(zip.some(f => f.name === 'manifest.json') && zip.some(f => f.name === 'task/answers.jsonl' || f.name.startsWith('task/')) && zip.every(f => f.crcOk), `Export: one archive with its manifest (${zip.length} files)`);

    // each terminal and page ends from its own button; the task's close leaves nothing behind
    await click(`${pane('t1')} button[aria-label="End this terminal (its shell stops)"]`);
    await until(() => !views.terminals!.has('t1'), 'the terminal ended');
    await until(() => js<boolean>(`!document.querySelector('${pane('t1')}')`), 'its pane gone');
    check(true, 'ending a terminal stops its shell and takes its pane away');
    await click(`${pane('b1')} button[aria-label="Close this page"]`);
    await until(() => !pageOf('b1'), 'the page closed');
    check(true, 'closing a page takes it away, picture and all');

    // a new task from this view: a fresh session in the same folder, starting from the view as it is
    await click('#branch');
    const second = await until(() => [...a.tasks.keys()].find(k => k !== task), 'the new task');
    const t2 = a.tasks.get(second)!;
    await t2.branched;
    await until(() => js<boolean>(`!!document.querySelector('.task[data-task="${second}"]:not([hidden]) .vindu-pane[data-view="inv"]')`), 'the new task shows the carried view');
    check(t2.snapshot().views.some(v => v.name === 'inv' && v.title === 'Invoices') && t2.mode().kind === 'dynamic' && t2.cwd === t.cwd && t2.attached && t.attached,
      'New task from here: a fresh session in the same folder, with the view as the person left it');
    await until(() => js<boolean>(`document.getElementById('thread').textContent.includes('a new task from the view of task ${task}: a fresh session')`), 'its note');
    check(true, 'its note names the task it came from');

    // two tasks: the one in front keeps the window; the other moves its entry in the activity column, by what it needs
    const front = () => js<string>(`document.querySelector('.task:not([hidden])')?.dataset.task ?? ''`);
    await until(() => js<boolean>(`document.querySelectorAll('#tasks .act').length === 2`), 'Activity, with both tasks');
    check(await front() === second && a.front() === second, 'the new task is in front, as the person started it; the activity column lists both tasks');
    await js(`desktop.prompt('${task}', 'Run the tests', []).catch(() => null), true`);
    await until(() => a.activity().entries.find(e => e.id === task)?.state === 'waiting', 'the first task waits for the person');
    await until(() => js<boolean>(`document.querySelector('#tasks .act[data-task="${task}"]')?.dataset.state === 'waiting' && document.querySelector('#tasks h3')?.textContent === 'Waiting for you'`), 'its entry, under Waiting for you');
    check(await front() === second, 'a task in the background asks the person: its entry moves to Waiting for you; the window stays on the task in front');
    const waiting = a.activity();
    check(waiting.next?.id === task && await js<boolean>(`document.getElementById('next').textContent.includes('npm test')`), `Next says which task waits, and why: ${waiting.next?.reason}`);
    await shot('activity');
    await click('#go-next');
    await until(async () => await front() === task && a.front() === task, 'brought in front');
    await until(() => js<boolean>(`!!document.querySelector('${ask}')`), 'its ask, in front');
    check(true, 'Next brings that task in front, with its ask');
    await click(`#tasks .act[data-task="${second}"] .act-mute`);
    await until(() => a.activity().entries.at(-1)?.id === second && a.activity().entries.at(-1)?.muted === true, 'muted');
    await until(() => js<boolean>(`[...document.querySelectorAll('#tasks h3')].at(-1)?.textContent === 'Muted'`), 'under Muted');
    check(true, 'a muted task goes last, under Muted');
    check(await press(ask, 'No'), 'the person answers it in front');

    // a view's hooks: the system tells the person what it was written to, and starts a job once they turn it on
    const overdue = a.tasks.get(task)!.observe({ connector: 'ledger', tool: 'overdue', input: {}, result: { content: [{ type: 'text', text: JSON.stringify([{ customer: 'Havgap Media', amount: 75000 }]) }] } });
    const hooked = { name: 'watch', title: 'Watch', panels: [
      { id: 'total', card: 'kpi', title: 'Overdue', data: 75000 },
      { id: 'rows', card: 'table', title: 'Invoices', from: overdue, columns: ['customer', 'amount'] },
      { id: 'row', card: 'record', title: 'Invoice', detail: { of: 'rows' } },
    ], hooks: [
      { when: { crosses: { panel: 'total', above: 50000 } }, do: { notify: 'More than 50 000 is overdue' } },
      { label: 'Who first', when: { picked: 'rows' }, do: { job: { prompt: 'Who should be chased first? [echo]' } } },
    ] };
    const w1 = await call('show_view', hooked);
    check(w1.hooks?.[1]?.state === 'off until the person turns it on, in the window', 'a hook\'s job is off until the person turns it on');
    await until(() => js<boolean>(`document.getElementById('thread').textContent.includes('Watch: More than 50 000 is overdue')`), 'the hook\'s notice');
    check(true, 'the hook tells the person what it was written to, by itself');
    check(await press(pane('watch'), 'Turn on'), 'the person turns the job on, in its view');
    await until(() => js<boolean>(`(document.querySelector('${pane('watch')}')?.textContent ?? '').includes('· on')`), 'on');
    // a row picked sets the job off, as the window sends it: the model showing the view again would take the yes with it
    a.tasks.get(task)!.event({ type: 'view', view: 'watch', action: 'select', panel: 'p_rows', from: 0 });
    const job = await until(() => a.activity().entries.find(e => e.job === 'Who first')?.id, 'the job, as a task of its own');
    check(a.front() === task && await front() === task, 'the job runs in the background: the task in front stays in front');
    await until(() => a.tasks.has(job) && a.activity().entries.find(e => e.id === job)?.state === 'done', 'the job done', 60_000);
    const jt = a.tasks.get(job)!;
    await until(() => jt.snapshot().views.some(v => v.name === 'watch'), 'the job\'s views, carried', 30_000).catch(e => { throw new Error(`${(e as Error).message}: ${JSON.stringify(jt.snapshot().views.map(v => v.name))}`); }); // its entry is done once it shows views not seen, which may be before all are carried
    check(jt.connectors.every(c => c.kind === 'http') && jt.snapshot().views.some(v => v.name === 'watch'), 'the job starts from the view as it was, with the connectors it may use, reads only');
    await until(() => js<boolean>(`document.querySelector('#tasks .act[data-task="${job}"]')?.dataset.state === 'done'`), 'its entry, done');
    check(true, 'its result waits in the activity column, under Done');
    await js(`desktop.close('${job}')`); await until(() => !a.tasks.has(job), 'the job closed');
    await js(`desktop.close('${second}')`); await until(() => !a.tasks.has(second), 'the new task closed');
    await until(() => js<boolean>(`document.querySelectorAll('#tasks .act').length === 1`), 'one task left');
    check(true, 'closed tasks leave Activity');
    await ui.close();
    await js(`desktop.close('${task}')`);
    await until(() => a.pages(task).length === 0 && !a.tasks.has(task), 'the task closed');
    check(true, 'closing the task closes its pages');

    // a task with no folder picked: a new one under the tasks folder, made for it, by its first words
    await until(() => js<boolean>(`!document.querySelector('#tasks .act') && !document.getElementById('list').hidden`), 'Activity, back to its list');
    await js(`(() => { const p = document.getElementById('prompt'); p.value = 'Hello again'; p.dispatchEvent(new Event('input')); })()`);
    await click('#send');
    const boxed = await until(() => [...a.tasks.keys()][0], 'the new task');
    const bt = a.tasks.get(boxed)!;
    check(path.dirname(bt.cwd) === fs.realpathSync(tasksRoot) && path.basename(bt.cwd).endsWith('hello-again') && fs.existsSync(bt.cwd), `it works in a new folder under the tasks folder: ${path.basename(bt.cwd)}`);
    await js(`document.querySelector('#tasks .act[data-task="${boxed}"] .act-go')?.click()`); // its thread
    const toldText = await until(() => js<string>(`document.querySelector('#thread .told pre')?.textContent ?? ''`), 'what the window told the model, with the prompt');
    check(toldText.length > 20 && await js<boolean>(`!!document.querySelector('#thread .told summary')?.textContent.includes('what the window told the model')`), 'with the prompt, its thread shows what the window told the model, the words a click away');
    // the tab reloaded: the page loads again from the app, with its tasks in Activity as the app has them
    await page.reload();
    await until(() => js<boolean>(`!!document.querySelector('#tasks .act[data-task="${boxed}"]')`), 'Activity again, after a reload');
    check(true, 'Desktop\'s tab reloaded: its tasks are in Activity again, as the app has them');
    await js(`desktop.close('${boxed}')`); await until(() => !a.tasks.has(boxed), 'the new task closed');
    check(errors.length === 0, `no errors in the window${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    code = 0;
  } catch (e) {
    console.log(`not ok - ${(e as Error).message}`);
  } finally {
    console.log(`# ${passed} passed${code ? ', then a failure' : ''}`);
    await browser.close().catch(() => undefined); await a.close().catch(() => undefined); site.close();
    process.exit(code);
  }
})();
