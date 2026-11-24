// A core for the desktop app's live panes test, started by the app as main.ts would be (VINDU_CORE): on the port and in
// the folder it is given, with the app's link taken out of its environment at once. The test supplies its own processor and an in-memory key store.
// For the test, it tells what it has at an address of its own (in test-core.json, in its folder): its tasks, their
// pages (each pictured, or live in the app), their UI servers, and what an expression gives in a page.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Desktop's folder: from here (frame/dist/test), three up. Its built files are taken as they are, as main.ts takes them. */
const DESKTOP = path.join(import.meta.dirname, '..', '..', '..');
const load = (rel: string) => import(pathToFileURL(path.join(DESKTOP, 'dist', 'src', rel)).href);
const { startApp } = await load('app.js') as { startApp: (o: Record<string, unknown>) => Promise<Core> };
const { connectSyntheticProcessor, processors } = await import(pathToFileURL(path.join(DESKTOP, 'dist', 'test', 'synthetic-processor.js')).href);
const { frameLink } = await load('frame-link.js') as { frameLink: () => Promise<unknown> };
type Core = { url: string; tasks: Map<string, { useTemplate(template: unknown): Promise<unknown> }>; pages(task: string): unknown[]; pageEval(task: string, name: string, js: string): Promise<unknown>; pairingCode(): string; close(): Promise<void> };

const userData = process.env.VINDU_USER_DATA ?? fs.mkdtempSync(path.join(os.tmpdir(), 'frame-core-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-work-'));
const kept = new Map<string, string>();
const secrets = { available: async () => true, set: async (n: string, v: string) => { kept.set(n, v); return 'memory'; }, get: async (n: string) => kept.get(n), clear: async (n: string) => { kept.delete(n); } };
const frame = await frameLink(); // out of the environment before anything is started
// The other side of this test connects exactly where the processor was told to connect.
type Endpoint = { name: string; url: string; headers: Record<string, string> };
const endpoints = new Map<string, Endpoint>();
const a = await startApp({ userData, port: Number(process.env.VINDU_PORT) || 17810, secrets, pickFolder: async () => work,
  processors, connect(task: { id: string; mcpServers: Endpoint[] }) {
    const ui = task.mcpServers.find(server => server.name === 'ui');
    if (!ui) throw new Error('Missing task UI endpoint');
    endpoints.set(task.id, ui);
    return connectSyntheticProcessor(task);
  }, ...(frame ? { frame } : {}) });

const answer = (r: http.ServerResponse, v: unknown) => r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v ?? null));
const inspect = http.createServer((q, r) => {
  const u = new URL(q.url ?? '/', 'http://x'), task = u.searchParams.get('task') ?? '';
  void (async () => {
    if (u.pathname === '/tasks') answer(r, [...a.tasks.keys()]);
    else if (u.pathname === '/code') answer(r, a.pairingCode()); // a code to pair with, as Phone in Settings makes one: for the app on "another computer"
    else if (u.pathname === '/desktop') answer(r, a.url);
    else if (u.pathname === '/pages') answer(r, a.pages(task));
    else if (u.pathname === '/ui') answer(r, a.tasks.has(task) ? endpoints.get(task) : null);
    else if (u.pathname === '/provider-pane') answer(r, await a.tasks.get(task)?.useTemplate({
      name: 'Invoice', slots: { invoice: { title: 'Invoice', block: 'app', source: { server: 'billing', tool: 'lookup' } } },
    }));
    else if (u.pathname === '/eval') answer(r, await a.pageEval(task, u.searchParams.get('name') ?? '', u.searchParams.get('js') ?? ''));
    else if (u.pathname === '/frame') answer(r, { linked: !!frame, connected: !!frame && (frame as { connected(): boolean }).connected(), window: u.searchParams.get('window') && !!frame && (frame as { has(w: string): boolean }).has(u.searchParams.get('window')!) });
    else r.writeHead(404).end();
  })().catch(e => { if (!r.headersSent) r.writeHead(500); r.end(String((e as Error)?.message ?? e)); });
});
await new Promise<void>(ok => inspect.listen(0, '127.0.0.1', ok));
const at = `http://127.0.0.1:${(inspect.address() as { port: number }).port}`;
fs.writeFileSync(path.join(userData, 'test-core.json'), JSON.stringify({ inspect: at }));
console.log(`test: ${at}`);
console.log(`vindu: ${a.url}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) process.exit(1); stopping = true;
  void a.close().finally(() => { inspect.close(); fs.rmSync(work, { recursive: true, force: true }); process.exit(0); });
});
