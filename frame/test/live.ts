// Live browser panes in the desktop app: a task's browser views' pages live in the app, each a page of its own laid over
// its pane in Desktop's window, and the core drives each over the DevTools protocol, as it drives a page in its own
// hidden Chromium (where a browser's tab shows pictures of it, as Desktop's browser test checks). The person's page and
// the model's, each in a session of its own. With a core of the test's own (core.ts): its harness calls no model, and its
// tasks run on this computer; and a site of the test's own, on this computer. Synthetic data only. Its windows show on the
// screen while it runs:
//   pnpm build (in vindu, then here), then pnpm test here
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { launchEnv } from './launch-env.js';

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string; // the package gives its program's path
const FRAME = path.join(import.meta.dirname, '..', '..');
const PORT = 17810;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const check = (cond: unknown, what: string) => { if (!cond) throw new Error(`not ok: ${what}`); console.log(`ok ${++passed} - ${what}`); };
async function until<T>(f: () => Promise<T> | T, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); }
}
const answers = (port: number) => new Promise<boolean>(r => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
const ADDRESS = /^http:\/\/localhost:(\d+)\/([\w-]{20,})\/$/;
type Rect = { x: number; y: number; w: number; h: number };
type Page = { name: string; live: boolean; casting: boolean; url: string; box: { w: number; h: number } | null };

// the test's own site, on this computer: an invoice, a button that pays it, a link to another site
const site = http.createServer((_q, res) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Ledger (synthetic)</title><body style="font:15px system-ui;padding:16px"><h1>Invoices</h1><p>INV-2026-0412 · 31 050 kr · overdue</p><button onclick="this.textContent=\'Paid\'">Pay INV-2026-0412</button></body>'));
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
const receipt = randomUUID(), resourceUri = 'ui://billing/invoice';
const providerHtml = `<!doctype html><main><h1>Invoice</h1><output></output></main><script>
  const send = message => parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  addEventListener('message', e => {
    if (e.source !== parent) return;
    if (e.data.id === 1 && e.data.result) send({ method: 'ui/notifications/initialized' });
    if (e.data.method === 'ui/notifications/tool-result') document.querySelector('output').textContent = e.data.params.structuredContent.receipt;
  });
  send({ id: 1, method: 'ui/initialize', params: { protocolVersion: '2025-11-21', appInfo: {name: 'Billing', version: '1'}, appCapabilities: {} } });
</script>`;
const connector = http.createServer(toNodeHandler(createMcpHandler(() => {
  const server = new McpServer({ name: 'billing', version: '1' });
  server.registerTool('lookup', { annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri } } },
    async () => ({ content: [{ type: 'text', text: receipt }], structuredContent: { receipt } }));
  server.registerResource('Invoice', resourceUri, { mimeType: 'text/html;profile=mcp-app' },
    async () => ({ contents: [{ uri: resourceUri, mimeType: 'text/html;profile=mcp-app', text: providerHtml }] }));
  return server;
})));
await new Promise<void>(resolve => connector.listen(0, '127.0.0.1', resolve));
const data = tmp('frame-live-core-'), frameData = tmp('frame-live-app-');
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  apps: { servers: { billing: 'on' } }, servers: [{ type: 'http', name: 'billing', url: `http://127.0.0.1:${(connector.address() as net.AddressInfo).port}/mcp` }],
}));
const env = launchEnv({ VINDU_PORT: String(PORT), VINDU_USER_DATA: data, VINDU_FRAME_DATA: frameData, VINDU_CORE: path.join(import.meta.dirname, 'core.js') });

let code = 1, app: ElectronApplication | undefined;
try {
  app = await electron.launch({ executablePath: ELECTRON, args: [FRAME], env });
  const said: string[] = []; // what the app and its core printed, for a failure to show
  app.process().stdout?.on('data', d => said.push(String(d))); app.process().stderr?.on('data', d => said.push(String(d)));
  process.on('exit', () => { if (process.exitCode || code) console.log(`# the app said, at the end:\n${said.join('').split('\n').filter(l => /vindu/.test(l)).slice(-15).join('\n')}`); });
  const desk = await app.firstWindow(); // Desktop, the app's window
  await desk.waitForURL(ADDRESS, { timeout: 60_000 });
  const inspect = await until(() => { try { return (JSON.parse(fs.readFileSync(path.join(data, 'test-core.json'), 'utf8')) as { inspect: string }).inspect; } catch { return undefined; } }, 'the test core');
  const ask = async <T>(p: string) => (await (await fetch(`${inspect}${p}`)).json()) as T;
  await desk.waitForSelector('#prompt', { timeout: 30_000 });
  const js = <T = unknown>(code: string) => desk.evaluate(code) as Promise<T>;
  const click = (sel: string) => js<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const pane = (v: string) => `.task:not([hidden]) .vindu-pane[data-view="${v}"]`;
  /** A pane's place in Desktop's window: its page is the window's own. */
  const slot = (v: string) => js<Rect>(`(() => { const r = document.querySelector('${pane(v)} .vindu-slot').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  /** The pages laid over Desktop's window in the app: each one's place there and its address, as the app has them. */
  const views = () => app!.evaluate(({ BrowserWindow }, port) => {
    const w = BrowserWindow.getAllWindows().find(x => { try { return new URL(x.webContents.getURL()).port === String(port); } catch { return false; } });
    return (w?.contentView.children ?? []).map(v => ({ bounds: v.getBounds(), url: (v as unknown as { webContents?: { getURL(): string } }).webContents?.getURL() ?? '' }));
  }, PORT);
  const near = (b: { x: number; y: number; width: number; height: number }, r: Rect) => Math.abs(b.x - r.x) <= 1 && Math.abs(b.y - r.y) <= 1 && Math.abs(b.width - r.w) <= 1 && Math.abs(b.height - r.h) <= 1;
  check(Number(ADDRESS.exec(desk.url())![1]) === PORT, 'the app starts the core, and Desktop opens in its window');

  // a task, in a folder of the test's
  await until(() => js<boolean>('!!document.getElementById("place")'), 'the window');
  await desk.locator('button[data-connector="billing"][aria-pressed="true"]').waitFor();
  await click('#place');
  await until(() => js<boolean>('!document.getElementById("send").disabled'), 'a folder for the next task');
  await click('#send');
  const task = await until(async () => (await ask<string[]>('/tasks'))[0], 'a task in the folder');
  await until(() => js<boolean>('!document.getElementById("opens").hidden'), 'its thread\'s bar');
  const pageOf = async (name: string) => (await ask<Page[]>(`/pages?task=${encodeURIComponent(task)}`)).find(p => p.name === name);

  // the person's page: a page of its own in the app, laid over its pane, not pictured
  await click('#page');
  await until(async () => (await pageOf('b1'))?.live, 'the person\'s page, live in its pane').catch(async e => {
    const windows = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), views: w.contentView.children.length })));
    throw new Error(`${(e as Error).message}: the core has ${JSON.stringify(await pageOf('b1'))}; its link ${JSON.stringify(await ask('/frame'))}; the app's windows ${JSON.stringify(windows)}`);
  });
  const first = await until(async () => { const v = await views(); return v.length === 1 ? v : undefined; }, 'its page in Desktop\'s window');
  const s1 = await slot('b1');
  check(near(first[0].bounds, s1) && !(await pageOf('b1'))!.casting, `the person's page is a page of its own in the app, laid over its pane in Desktop's window (${Math.round(s1.w)} × ${Math.round(s1.h)}), not pictured`);
  await js(`(() => { const f = document.querySelector('${pane('b1')} form.vindu-viewbar'); f.querySelector('input.vindu-address').value = '${base.replace('http://', '')}'; f.requestSubmit(); })()`);
  await until(async () => (await pageOf('b1'))?.url === base, 'the address the person typed');
  await until(async () => (await views())[0]?.url === base, 'the live page, there');
  check(true, 'the address typed in its bar loads in the live page: the core drives it over the DevTools protocol');

  // the model's side, through the task's UI server, as the harness reaches it
  const ui = new Client({ name: 'frame-live', version: '1' });
  const endpoint = await ask<{ url: string; headers: Record<string, string> }>(`/ui?task=${encodeURIComponent(task)}`);
  await ui.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await ui.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean }; return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text); };
  await click(`${pane('b1')} .vindu-share input`);
  const snap = await until(async () => (await call('read_view', { view: 'b1' })).snapshot as { title: string; tree: { role: string; name: string; ref: string }[] } | undefined, 'shared');
  const btn = snap.tree.find(n => n.role === 'button')!;
  const after = await call('act_in_view', { view: 'b1', action: 'click', ref: btn.ref });
  const inApp = await app.evaluate(({ BrowserWindow }, port) => {
    const w = BrowserWindow.getAllWindows().find(x => { try { return new URL(x.webContents.getURL()).port === String(port); } catch { return false; } });
    const v = w?.contentView.children[0] as unknown as { webContents: { executeJavaScript(js: string): Promise<unknown> } } | undefined;
    return v?.webContents.executeJavaScript('document.querySelector("button").textContent');
  }, PORT);
  check(snap.title === 'Ledger (synthetic)' && after.snapshot.tree.find((n: { role: string }) => n.role === 'button')?.name === 'Paid' && inApp === 'Paid',
    'shared, the model reads the live page and clicks in it: the click lands in the page the person sees, in the app');

  // the model's own page: a second live page, over its own pane
  const own = await call('show_view', { name: 'ledger', title: 'Ledger', browser: { url: base } });
  check(own.owner === 'model' && own.snapshot?.title === 'Ledger (synthetic)', 'the model opens a page of its own with show_view');
  await until(async () => (await pageOf('ledger'))?.live, 'the model\'s page, live in its pane');
  const both = await until(async () => { const v = await views(); return v.length === 2 && v.every(x => x.url === base) ? v : undefined; }, 'two pages in Desktop\'s window');
  const fits = async () => { const v = await views(), r1 = await slot('b1'), r2 = await slot('ledger'); return v.length === 2 && v.some(x => near(x.bounds, r1)) && v.some(x => near(x.bounds, r2)); };
  await until(fits, 'each over its pane', 5000);
  check(both.length === 2, 'the model\'s page is a live page too, and each is laid over its own pane as the layout changes');
  await ask(`/eval?task=${encodeURIComponent(task)}&name=b1&js=${encodeURIComponent('document.cookie = "signed_in_as=person-synthetic; path=/"')}`);
  const cookies = { person: await ask<string>(`/eval?task=${encodeURIComponent(task)}&name=b1&js=document.cookie`), model: await ask<string>(`/eval?task=${encodeURIComponent(task)}&name=ledger&js=document.cookie`) };
  check(cookies.person.includes('person-synthetic') && cookies.model === '', 'the model\'s page carries none of the person\'s sign-ins: a session of its own');

  await call('show_view', { name: 'summary', title: 'Summary', panels: [{ id: 'report', card: 'page', html: '<!doctype html><p>Reviewed task output</p>' }] });
  const report = await until(() => desk.frames().find(f => /^http:\/\/[0-9a-f]{32}\.localhost:/.test(f.url())), 'the task output inside Electron');
  await report.getByText('Reviewed task output', { exact: true }).waitFor();
  check(true, 'task HTML renders in its own origin inside the desktop');

  const filled = await ask<{ started?: boolean; failed?: string[] }>('/provider-pane?task=' + encodeURIComponent(task));
  check(filled.started && !filled.failed?.length, `the task reads its selected connector through Celler (${JSON.stringify(filled)})`);
  const invoice = await until(() => desk.frames().find(f => f.parentFrame() === desk.mainFrame() && /^http:\/\/app-[a-f0-9]{32}\.localhost:/.test(f.url())), 'the provider iframe inside the task');
  await invoice.getByText(receipt, { exact: true }).waitFor();
  check(true, 'the provider resource renders its live tool result inside the Electron task');

  const layoutEndpoint = await ask<typeof endpoint>('/layout?task=' + encodeURIComponent(task));
  const coordinator = new Client({ name: 'frame-layout', version: '1' });
  try {
    await coordinator.connect(new StreamableHTTPClientTransport(new URL(layoutEndpoint.url), { requestInit: { headers: layoutEndpoint.headers } }));
    const tools = await coordinator.listTools();
    check(tools.tools.length === 1 && tools.tools[0].name === 'read_layout', 'the task gives its layout coordinator one read-only tool');
    const geometry = await until(async () => {
      const reply = await coordinator.callTool({ name: 'read_layout', arguments: {} });
      if (reply.isError || reply.content.length !== 1 || reply.content[0].type !== 'text') throw new Error('Expected one text layout report');
      const layout = JSON.parse(reply.content[0].text) as { viewport: { w: number; h: number; source: string }; mode: string; paneCount: number };
      const actual = await desk.locator('.task:not([hidden]) .vindu-shell').evaluate(shell => {
        const area = shell.querySelector<HTMLElement>('.vindu-desk')!;
        return { w: area.clientWidth, h: area.clientHeight, mode: (shell as HTMLElement).dataset.mode, panes: shell.querySelectorAll('.vindu-bar-view:not(.is-collapsed)').length };
      });
      if (actual.w <= 0 || actual.h <= 0 || actual.panes === 0 || layout.viewport.source !== 'reported' ||
          layout.viewport.w !== actual.w || layout.viewport.h !== actual.h || layout.mode !== actual.mode || layout.paneCount !== actual.panes) return;
      return JSON.stringify(reply);
    }, 'the coordinator sees the open panes and viewport of the Electron task');
    check([receipt, resourceUri, base, 'invoice', 'billing', 'ledger', 'reviewed task output'].every(value => !geometry.toLowerCase().includes(value.toLowerCase())),
      'the coordinator reads the Electron viewport and pane count while connector output, page contents, titles and addresses stay private');
  } finally { await coordinator.close(); }

  // the task closed: its pages go from the window, and from the core
  await js(`desktop.close(${JSON.stringify(task)})`);
  await until(async () => (await views()).length === 0 && (await ask<string[]>('/tasks')).length === 0, 'the task closed');
  check(true, 'the task closed: its pages are gone from the window');

  // Quit: the core stops
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); }).catch(() => undefined);
  await closed; app = undefined;
  await until(async () => !(await answers(PORT)), 'the core stopped', 30_000);
  check(true, 'Quit stops the core and its pages');
  console.log(`# ${passed} passed`);
  code = 0;
} catch (e) { console.log(String((e as Error)?.stack ?? e)); } finally {
  await app?.close().catch(() => undefined);
  site.close(); connector.closeAllConnections(); connector.close();
  await sleep(300);
  for (const d of [data, frameData]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(code);
}
