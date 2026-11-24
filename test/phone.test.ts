// The phone window, with a real Chromium as the phone: the task's views at the phone's width, answers and approvals
// from there with the name the person there gives, a photo taken for a slot, what is sent offline waiting and going in
// order, pages on the computer only, media passed through, and nothing of the layout sent back. Not Electron: the app's
// main process gives remote.ts the same things as here. Synthetic data only.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { makeLanIdentity, wifiName } from './lan-identity.js';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { startVindu, memoryResults, type Operation, type Shown, type ShellState } from '@matapao/vindu/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startRemote } from '../src/remote.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { chromium, devices }: any = createRequire(import.meta.url)('playwright');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, what: string, ms = 10_000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(40); } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('the phone window: the views at its width, answers with its own name, a photo for a slot, offline in order, no layout back', async () => {
  const transfer: Operation = { name: 'approve_transfer', description: 'Approve a transfer.', effect: 'external', approve: 2, input: { amount: z.number(), to: z.string() }, run: i => ({ transferred: i.amount }) };
  const uiProvider = await startVindu({ waitMs: 300, operations: [transfer] });
  const dir = tmp('phone-'), results = memoryResults(dir), log: Record<string, unknown>[] = [];
  results.add({ server: 'accounts', tool: 'list_invoices', value: [{ number: 'INV-2026-0412', customer: 'Havgap Media', amount: 31050 }, { number: 'INV-2026-0431', customer: 'Havgap Media', amount: 17160 }] });
  const png = path.join(dir, 'site.png'); fs.writeFileSync(png, PNG); results.attach('site.png', 'image/png', png);
  const views = new Map<string, Shown>(); let state: ShellState | undefined;
  let push: ((e: string, d: unknown) => void) | undefined;
  let waiting: { id: string; done: (ids: string[]) => void } | undefined;
  const ui = uiProvider.open({ results, dir }, { onView: v => { views.set(v.name, v); push?.('view', { task: 'T1', view: v }); }, onState: s => { state = s; push?.('shell', { task: 'T1', state: s }); },
    capture: c => new Promise(resolve => { waiting = { id: 'c1', done: resolve }; push?.('captures', { list: [{ id: 'c1', task: 'T1', ...c }] }); }) });
  ui.event({ type: 'window', w: 1400, h: 900 }); // the computer's window
  const remote = await startRemote({ log: e => log.push(e), media: { port: uiProvider.pagesPort },
    files: { html: path.join(import.meta.dirname, '..', '..', 'static', 'phone.html'), js: path.join(import.meta.dirname, '..', 'src', 'phone.bundle.js') },
    onEvent: (_task, e, who) => ui.event(who && e.type === 'action' ? { ...e, by: { name: who, window: 'phone' } } : e),
    onCapture: async (id, files) => { if (!waiting || waiting.id !== id) return []; const ids = files.map(f => { const p = path.join(dir, f.name); fs.writeFileSync(p, f.data); return results.attach(f.name, f.mime, p).id; }); waiting.done(ids); waiting = undefined; return ids; },
    replay: () => [...[...views.values()].map(view => ({ event: 'view', data: { task: 'T1', view } })), ...(state ? [{ event: 'shell', data: { task: 'T1', state } }] : []), { event: 'front', data: { task: 'T1' } }] });
  push = remote.push;
  const mcp = new Client({ name: 'test', version: '1' }); await mcp.connect(new StreamableHTTPClientTransport(new URL(ui.url)));
  const json = async (name: string, args: Record<string, unknown>) => JSON.parse(((await mcp.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text);
  const browser = await chromium.launch();
  try {
    assert.match(remote.url, /^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32}\/$/); assert.equal(remote.lan, false); // this machine only, unless the settings say so
    const wrong = await fetch(remote.url.replace(/\/[\w-]{32}\//, '/not-the-token/'));
    assert.equal(wrong.status, 404); assert.ok(log.some(e => e.phone === 'refused'));
    await json('show_view', { name: 'invoices', title: 'Invoices', panels: [{ id: 'list', card: 'table', from: 'r1', columns: ['number', 'customer', 'amount'] }] });
    await json('show_view', { name: 'site', title: 'Site', panels: [{ id: 'photo', card: 'media', media: 'a1' }, { id: 'map', card: 'page', html: '<!doctype html><p>a 3D model</p>' }] });
    const before = await json('look', {});
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const phone = await ctx.newPage(); const errors: string[] = []; phone.on('pageerror', (e: Error) => errors.push(e.message));
    await phone.goto(remote.url);
    await phone.locator('.vindu-pane[data-view="invoices"]').waitFor();
    assert.match(await phone.locator('.vindu-pane[data-view="invoices"]').innerText(), /INV-2026-0431/);
    await until(() => phone.evaluate(() => { const img = [...document.querySelectorAll('.vindu-pane[data-view="site"] *')].flatMap((e: any) => [e, ...(e.shadowRoot ? [...e.shadowRoot.querySelectorAll('img')] : [])]).find((e: any) => e.tagName === 'IMG') as HTMLImageElement | undefined; return !!img && img.complete && img.naturalWidth === 1 && img.src.includes('/media?u='); }), 'the photo, passed through');
    assert.match(await phone.locator('.vindu-pane[data-view="site"]').innerText(), /This page shows on the computer\./);
    const after = await json('look', {});
    assert.equal(after.mode, before.mode); assert.deepEqual(after.window, before.window); // the phone's width changed nothing of the computer's layout
    assert.ok(log.some(e => e.phone === 'connected'));

    // two people must say yes: one at the computer, one on the phone, with the name given there
    const call = json('approve_transfer', { amount: 250000, to: 'Kobberdal Bygg' });
    await until(() => [...views.values()].some(v => v.ask?.op === 'approve_transfer'), 'the ask');
    const ask = [...views.values()].find(v => v.ask?.op === 'approve_transfer')!;
    ui.event({ type: 'action', view: ask.name, name: 'answer', context: { ticket: ask.ask!.ticket }, by: { name: 'Kari', window: 'main' } });
    await phone.fill('#who', 'Ola'); await phone.locator('#who').dispatchEvent('change');
    const pane = phone.locator(`.vindu-pane[data-view="${ask.name}"]`);
    await pane.getByText('Kari', { exact: false }).first().waitFor(); // the first yes is shown there too
    await pane.getByRole('button', { name: /^Allow/ }).first().click();
    // the call waits a while for both, then says pending, as it would to a model: the ticket is then waited on, until both said yes
    let r = await call;
    for (let n = 0; r.pending && n < 20; n++) r = await json('await_answer', { ticket: r.ticket });
    assert.deepEqual(r.output, { transferred: 250000 }, `what the call returned: ${JSON.stringify(r)}`);
    assert.deepEqual((ui.answers().at(-1) as any).who, ['Kari (main)', 'Ola (phone)']);
    assert.ok(log.some(e => e.phone === 'event' && e.who === 'Ola' && e.ok === true));

    // offline: what the person does waits on the phone, and goes when it can, in order
    await ctx.setOffline(true);
    await phone.locator('.vindu-pane[data-view="invoices"] .vindu-chat').click();
    await phone.locator('#status').getByText(/Offline: 1 waiting/).waitFor();
    assert.deepEqual(state!.pointing?.attached ?? [], []);
    await ctx.setOffline(false);
    await until(() => (state!.pointing?.attached ?? []).includes('invoices'), 'sent once online', 15_000);

    // a slot of the person's that wants a photo: the phone's camera (here, a file), kept as an attachment
    const t = ui.useTemplate({ name: 'Site visit', slots: { photos: { title: 'Photos', block: 'media', by: 'person', ask: { capture: 'photo', min: 1, about: 'Photos of the damage' } } } });
    await phone.locator('#captures').getByText('Photos of the damage').waitFor();
    await ctx.setOffline(true); // on site, without a network: the photo waits on the phone
    await phone.locator('#captures input[type=file]').setInputFiles({ name: 'damage.png', mimeType: 'image/png', buffer: PNG });
    await phone.locator('#status').getByText(/what you took waits here/).waitFor();
    assert.equal(ui.answers().some((a: any) => a.to === 'slot photos'), false);
    await ctx.setOffline(false);
    await until(() => ui.answers().some((a: any) => a.to === 'slot photos'), 'the photo kept for the slot, once online', 15_000);
    assert.deepEqual((ui.answers().find((a: any) => a.to === 'slot photos') as any).values, { files: ['a2'] });
    assert.equal((await t).started, true);
    assert.ok(!log.some(e => e.phone === 'ignored')); // the phone sent nothing of the layout (its size, the panes)
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await mcp.close(); await remote.close(); ui.close(); await uiProvider.close(); }
});

test('the task phone accepts input over trusted HTTPS when Wi-Fi sharing is requested', async () => {
  const userData = tmp('phone-tls-'), events: unknown[] = [];
  const options = { userData, lan: true, lanName: wifiName, lanBind: '127.0.0.1', log: () => {}, media: { port: 1 },
    files: { html: path.join(import.meta.dirname, '..', '..', 'static', 'phone.html'), js: '' },
    onEvent: (task: string, e: Record<string, unknown>) => { events.push({ task, e }); return true; },
    onCapture: async () => [], replay: () => [] };
  await assert.rejects(startRemote(options), /TLS certificate/);
  const tls = makeLanIdentity(userData);
  await assert.rejects(startRemote({ ...options, lanName: 'wrong.local' }), /TLS certificate/);
  const remote = await startRemote(options);
  try {
    const url = new URL(remote.url);
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, wifiName);
    const ask = (pathname: string, event?: object, origin?: string) => new Promise<number>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: remote.port, path: pathname, ...tls, method: event ? 'POST' : 'GET',
        headers: { host: url.host, ...(origin ? { origin } : {}) } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end(event && JSON.stringify(event));
    });
    assert.equal(await ask('/missing/'), 404);
    assert.equal(await ask('*'), 400);
    assert.equal(await ask(url.pathname), 200);
    const action = { task: 'one', e: { type: 'action', name: 'answer' } };
    assert.equal(await ask(url.pathname + 'event', action, 'https://another.local'), 403);
    assert.equal(await ask(url.pathname + 'event', action, url.origin), 200);
    assert.deepEqual(events, [action]);
  } finally { await remote.close(); }
});
