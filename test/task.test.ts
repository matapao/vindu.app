// A processor attaches to a task and uses its real UI endpoint. No model is called.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connectConsumer } from './consumer.js';
import os from 'node:os';
import path from 'node:path';
import { startVindu, type Shown } from '@matapao/vindu/server';
import type { Switch } from '../src/task.js';
import { openTask, type TaskRouter } from '../src/task.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const until = async (f: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 25)); } };

test('the processor supplies settings, asks, activity and exact results to the task window', async () => {
  const uiProvider = await startVindu();
  const asks: Shown[] = []; const opened: string[] = []; const switched: Switch[][] = []; let text = '';
  const activity: unknown[] = [];
  const cwd = tmp('work-'), home = tmp('home-'), data = tmp('data-');
  const t = await openTask({ harness: 'claude', cwd, dataDir: data, home, uiProvider, connect: connectConsumer, env: { PATH: '/bin', HOME: home },
    onShow: v => {
      if (!v.ask) return;
      asks.push(v); const k = v.ask; const answer = (context: Record<string, unknown>) => setTimeout(() => t.event({ type: 'action', view: v.name, name: 'answer', context: { ticket: k.ticket, ...context } }), 20);
      if (k.kind === 'permission') answer({ choice: k.choices![0], n: 0 });
      if (k.kind === 'elicitation') answer({ 'f:suite': 'invoices' });
      if (k.kind === 'link') answer({});
    },
    onText: s => { text += s; }, onSwitches: s => switched.push(s), onActivity: entry => activity.push(entry), openLink: url => { opened.push(url); } });
  try {
    assert.equal(t.attached, true);
    assert.equal(t.switches()[0]?.id, 'report');
    await t.prompt('Run the tests and show them.');
    const out = JSON.parse(text);
    assert.ok(switched.length > 0);
    assert.deepEqual(activity, [{ type: 'call', id: 'tests', title: 'npm test', status: 'pending' }, { type: 'call', id: 'tests', status: 'completed' }]);
    assert.deepEqual(out.servers, ['ui']);
    const ask = asks.find(a => a.ask!.kind === 'permission')!.ask!;
    assert.deepEqual(ask.choices, ['Yes', 'No']); // its options, its words, its order
    assert.equal(ask.title, 'npm test'); assert.ok(ask.details!.some(d => d.label === 'input' && d.text.includes('"command": "npm test"'))); // the call as the harness reported it
    assert.deepEqual(out.picked, { option: 'allow' });
    assert.deepEqual(out.form, { accept: true, content: { suite: 'invoices' } });
    assert.deepEqual(out.page, { accept: true }); assert.deepEqual(opened, ['https://ledger.example/oauth/authorize?state=x1']);
    assert.equal(out.account.panels[0].ref, 'ctx:r1'); assert.equal(out.account.panels[0].seen, 'exact');
    assert.equal(t.record.get('r1')?.kind, 'result');
    await t.set('report', 'full');
    text = '';
    await t.prompt('Thanks.');
    const second = JSON.parse(text);
    assert.equal(second.report, 'full');
    assert.equal(second.prompt, 'Thanks.');
    assert.match(second.context, /the person answered the question "Which suite should run again\?".*the request to open a page at ledger\.example/);
  } finally { await t.close(); await uiProvider.close(); } // whatever happened, nothing is left running
});

test('what the person sends from a page reaches the next turn, once: the host hears of it, and the prompt says it', async () => {
  const uiProvider = await startVindu();
  const sent: string[] = []; let text = '';
  const cwd = tmp('work-'), home = tmp('home-'), data = tmp('data-');
  const t = await openTask({ harness: 'claude', cwd, dataDir: data, home, uiProvider, connect: connectConsumer, env: { PATH: '/bin', HOME: home },
    onShow: v => {
      if (!v.ask) return; const k = v.ask; const answer = (context: Record<string, unknown>) => setTimeout(() => t.event({ type: 'action', view: v.name, name: 'answer', context: { ticket: k.ticket, ...context } }), 20);
      if (k.kind === 'permission') answer({ choice: k.choices![0], n: 0 });
      if (k.kind === 'elicitation') answer({ 'f:suite': 'invoices' });
      if (k.kind === 'link') answer({});
    },
    onText: s => { text += s; }, app: { onSend: view => sent.push(view) } });
  try {
    await t.prompt('Run the tests and show them.');
    text = ''; await t.prompt('Show a page that sends.');
    assert.equal(JSON.parse(text).account.panels[0].page, 'not checked: this host has no page driver');
    assert.equal(t.event({ type: 'send', view: 'run', panel: 'elsewhere', value: 'x' }), false); // not a page panel shown there
    assert.equal(t.event({ type: 'send', view: 'run', panel: 'runner', value: { command: 'npm test' } }), true); // as the window sends it, the person's click checked
    assert.deepEqual(sent, ['run']);
    assert.deepEqual(t.unheard().map(x => [x.view, x.panel, x.sent]), [['run', 'runner', { command: 'npm test' }]]);
    text = ''; await t.prompt('The person sent what is above from a page in the window.');
    // the page's value, said as the page's: never as the person's own words
    assert.match(JSON.parse(text).context, /p\d+: the page panel "runner" in view "run" sent, on the person's click or key \(the value is the page's, not the person's words\) → \{"command":"npm test"\}/);
    assert.deepEqual(t.unheard(), []); // heard: the next turn does not say it again
    text = ''; await t.prompt('Thanks.');
    assert.doesNotMatch(JSON.parse(text).context, /the page panel "runner" in view "run" sent/);
  } finally { await t.close(); await uiProvider.close(); }
});
test('a terminal is a view of the UI server: the person shares it; the model reads it and runs a command only on their yes; what it read is kept, exactly', async () => {
  const uiProvider = await startVindu();
  const cwd = tmp('work-'), home = tmp('home-'), data = tmp('data-'); let text = ''; const asked: string[] = [];
  const t = await openTask({ harness: 'claude', cwd, dataDir: data, home, uiProvider, connect: connectConsumer, env: { PATH: process.env.PATH ?? '/bin', HOME: home, HISTFILE: '/dev/null' },
    views: { terminal: { shell: 'bash', login: false, run: true } }, onText: s => { text += s; },
    onShow: v => { // the person, in the window: yes to the first command the model wants to run, no to the second
      if (v.ask?.kind !== 'operation' || !v.ask.confirm) return;
      const k = v.ask; asked.push(k.details![0].text);
      setTimeout(() => t.event({ type: 'action', view: v.name, name: asked.length === 1 ? 'answer' : 'decline', context: { ticket: k.ticket } }), 20);
    } });
  try {
    const views = t.views!;
    const term = views.openTerminal({ cols: 80, rows: 20 }); // the person opens a terminal, and shares it
    await views.share(term.id, true);
    await until(() => views.terminals!.screen(term.id).length > 0);
    views.terminals!.input(term.id, 'echo synthetic-$((6*7))\r'); // and runs something in it
    await until(() => views.terminals!.commands(term.id).length === 1);
    await t.prompt('[views] What did I run?');
    const out = JSON.parse(text);
    assert.deepEqual(out.servers, ['ui']); // no other server: a terminal is a view of the window's own
    const pane = out.look.panes.find((p: { view: string }) => p.view === 't1');
    assert.equal(pane.kind, 'terminal'); assert.equal(pane.title, 'Terminal 1'); assert.equal(pane.about.shared, true);
    assert.deepEqual([out.read.commands[0].command, out.read.commands[0].output, out.read.commands[0].exit], ['echo synthetic-$((6*7))', 'synthetic-42', 0]);
    assert.match(out.context, /the person shared Terminal 1 with you/);
    assert.match(out.context, /the person ran `echo synthetic-\$\(\(6\*7\)\)` in Terminal 1 \(exit 0\)/); // told once, with the prompt
    assert.deepEqual(asked, ['echo from-the-model', 'rm -rf build']); // the exact commands, put to the person first
    assert.equal(out.ran.done.output, 'from-the-model'); assert.equal(out.declined.ran, false); assert.equal(out.declined.declined, 'the person said no');
    const after = out.after.panes.find((p: { view: string }) => p.view === 't1');
    assert.equal(after.about.last.command, 'echo from-the-model');
    assert.deepEqual(out.after.person ?? [], []); // what the model ran is not told back as the person's
    const kept = t.record.all().filter(e => e.kind === 'result' && e.server === 'ui');
    assert.deepEqual(kept.map(e => e.kind === 'result' && [e.tool, e.fidelity, e.via]), [['read_view', 'exact', 'window'], ['act_in_view', 'exact', 'window'], ['act_in_view', 'exact', 'window']]); // what it read and did in the terminal, as the window gave it; look is not task data
    const read = kept[0]; assert.ok(read.kind === 'result');
    assert.equal(out.read.id, read.id); assert.deepEqual(read.value, (({ id: _id, ...r }) => r)(out.read)); // kept as the model got it, under the id it was told
    const log = fs.readFileSync(path.join(data, 'ui-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.views).map(l => l.views);
    assert.deepEqual(log.map(l => l.opened ?? l.shared ?? `${l.command}: ${l.yes}`), ['terminal', true, 'echo from-the-model: true', 'rm -rf build: false']);
    await views.share(term.id, false); // the person takes it back
    text = ''; await t.prompt('Thanks.');
    assert.match(JSON.parse(text).context, /the person stopped sharing Terminal 1 with you/);
    await views.end(term.id);
    assert.equal(views.terminals!.has(term.id), false);
  } finally { await t.close(); await uiProvider.close(); }
});

test('a static view: the app reads its sources itself, read-only tools only; what the person points at goes with their message; their answer carries their name; the task exports as one archive', async () => {
  const uiProvider = await startVindu();
  const cwd = tmp('work-'), home = tmp('home-'), data = tmp('data-'); let text = ''; const shown: Shown[] = [];
  const router: TaskRouter = {};
  const invoices = { invoices: [
    { number: 'INV-2026-0412', amount: 31050, status: 'overdue' },
    { number: 'INV-2026-0431', amount: 17160, status: 'overdue' },
  ] };
  const template = { name: 'Overdue', about: 'What is overdue, and a note', slots: {
    invoices: { title: 'Invoices', block: 'table', columns: ['number', 'amount'], source: { server: 'accounts', tool: 'list_invoices', args: { status: 'overdue' } } },
    note: { title: 'Note', block: 'text', by: 'person', ask: { fields: { text: { type: 'string', title: 'Note' } } } } } };
  const t = await openTask({ harness: 'claude', cwd, dataDir: data, home, uiProvider, connect: connectConsumer, env: { PATH: process.env.PATH ?? '/bin', HOME: home },
    router, template, person: { name: 'Kari' },
    sources: {
      isRead: (server, tool) => server === 'accounts' && tool === 'list_invoices',
      source: async ({ server, tool, args }) => {
        assert.equal(server, 'accounts'); assert.equal(tool, 'list_invoices'); assert.deepEqual(args, { status: 'overdue' });
        return router.observe!({ connector: server, tool, input: args, result: { structuredContent: invoices, content: [] } });
      },
    },
    onText: s => { text += s; }, onShow: v => shown.push(v) });
  try {
    const started = await t.started as { started: boolean; read: string[] };
    assert.equal(started.started, true); assert.deepEqual(started.read, ['invoices from accounts.list_invoices (r1)']);
    const r1 = t.record.get('r1'); assert.ok(r1?.kind === 'result');
    assert.deepEqual([r1.server, r1.tool, r1.fidelity, r1.via], ['accounts', 'list_invoices', 'exact', 'connector']); // read by the app, kept exact
    assert.equal(t.mode().kind, 'static');
    // the person's note, answered in the window: kept with their name and window
    await until(() => shown.some(v => v.ask?.op === 'fill note'));
    const a = shown.filter(v => v.ask?.op === 'fill note').at(-1)!;
    t.event({ type: 'action', view: a.name, name: 'answer', context: { ticket: a.ask!.ticket, 'f:text': 'Call Ingrid first' } });
    await until(() => fs.existsSync(path.join(data, 'answers.jsonl')) && fs.readFileSync(path.join(data, 'answers.jsonl'), 'utf8').includes('Call Ingrid first'));
    const answer = fs.readFileSync(path.join(data, 'answers.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(x => x.to === 'slot note');
    assert.deepEqual(answer.who, ['Kari (main)']);
    // the person points at a row; it goes with their next message
    assert.equal(t.event({ type: 'select', by: 'click', items: [{ view: 'invoices', panel: 'invoices', row: 1 }] }), true);
    const sel = t.selection() as { row: { ref: string; number: string } }[];
    assert.equal(sel[0].row.number, 'INV-2026-0431'); assert.match(sel[0].row.ref, /^ctx:r1#\/invoices\/1$/);
    await t.prompt('[echo] Which of these is oldest?');
    assert.equal(JSON.parse(text).prompt, '[echo] Which of these is oldest?');
    const said = JSON.parse(text).context as string;
    assert.match(said, /\[the window: \{"pointed_at":"p\d+","items":\[\{"view":"invoices","panel":"invoices","card":"table","row":\{"ref":"ctx:r1#\/invoices\/1","number":"INV-2026-0431","amount":17160\}\}\]\}\]/);
    assert.match(said, /This task uses the static view "Overdue"/);
    const pointedAt = fs.readFileSync(path.join(data, 'answers.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(x => x.to === 'what the person points at');
    assert.deepEqual(pointedAt.who, ['Kari (main)']); // who pointed, as the window says
    // one archive: the record and the window's, each file with its digest
    const out = path.join(tmp('out-'), 'task.zip');
    const z = t.archive(out);
    assert.ok(z.files > 3); assert.ok(fs.statSync(out).size > 100);
    assert.ok(z.manifest.files.some(f => f.path === 'task/answers.jsonl' && 'sha256' in f && /^[0-9a-f]{64}$/.test(f.sha256)));
  } finally { await t.close(); await uiProvider.close(); }
});

test('slash commands and ordinary text reach the processor exactly as typed', async () => {
  const uiProvider = await startVindu();
  const cwd = tmp('work-'), home = tmp('home-'), data = tmp('data-'); let text = '';
  const t = await openTask({ harness: 'claude', cwd, dataDir: data, home, uiProvider, connect: connectConsumer, env: { PATH: '/bin', HOME: home },
    onShow: () => undefined, onText: s => { text += s; } });
  try {
    await t.prompt('/compact [echo]');
    assert.equal((JSON.parse(text) as { prompt: string }).prompt, '/compact [echo]');
    text = '';
    await t.prompt('/tmp is full [echo]');
    const said = (JSON.parse(text) as { prompt: string }).prompt;
    assert.equal(said, '/tmp is full [echo]');
  } finally { await t.close(); await uiProvider.close(); }
});

test('the device\'s own data: a server of the app\'s, each kind read only after the person\'s yes in the window, once a task, kept as exact', async () => {
  const uiProvider = await startVindu();
  const cwd = tmp('work-'), home = tmp('home-'), data = tmp('data-'); const shown: Shown[] = []; const notes: string[] = []; let answer = 'answer';
  const t = await openTask({ harness: 'claude', cwd, dataDir: data, home, uiProvider, connect: connectConsumer, env: { PATH: process.env.PATH ?? '/bin', HOME: home },
    device: [{ name: 'read_clipboard', description: 'The text on the clipboard now.', asks: 'your clipboard', read: () => ({ text: 'INV-2026-0412 is paid' }) }],
    onText: () => undefined, onNote: n => notes.push(n),
    onShow: v => { if (v.ask?.kind !== 'permission') return; shown.push(v); const k = v.ask; setTimeout(() => t.event({ type: 'action', view: v.name, name: 'answer', context: { ticket: k.ticket, choice: k.choices![answer === 'answer' ? 0 : 1], n: answer === 'answer' ? 0 : 1 } }), 20); } });
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const mcp = new Client({ name: 'harness', version: '1' }); await mcp.connect(new StreamableHTTPClientTransport(new URL(t.device!.url))); // as the harness reaches it
  try {
    const tools = await mcp.listTools();
    assert.deepEqual(tools.tools.map(x => [x.name, x.annotations?.readOnlyHint]), [['read_clipboard', true]]);
    const first = await mcp.callTool({ name: 'read_clipboard', arguments: {} }) as { content: { text: string }[] };
    assert.equal(shown.length, 1); assert.equal(shown[0].ask!.title, 'Let the model read your clipboard?'); assert.deepEqual(shown[0].ask!.choices, ['Allow for this task', 'Deny']);
    const r = JSON.parse(first.content[0].text);
    assert.deepEqual(r, { id: 'r1', text: 'INV-2026-0412 is paid' });
    const kept = t.record.get('r1'); assert.ok(kept?.kind === 'result');
    assert.deepEqual([kept.server, kept.tool, kept.fidelity, kept.via], ['device', 'read_clipboard', 'exact', 'device']);
    await mcp.callTool({ name: 'read_clipboard', arguments: {} });
    assert.equal(shown.length, 1); // once a task
    assert.match(notes.join(' | '), /you let the model read your clipboard \| the model read read_clipboard from this device \(r1\)/);
  } finally { await mcp.close(); await t.close(); }
  answer = 'deny'; shown.length = 0;
  const t2 = await openTask({ harness: 'claude', cwd, dataDir: tmp('data-'), home, uiProvider, connect: connectConsumer, env: { PATH: process.env.PATH ?? '/bin', HOME: home },
    device: [{ name: 'read_clipboard', description: 'The text on the clipboard now.', asks: 'your clipboard', read: () => ({ text: 'never read' }) }],
    onText: () => undefined, onShow: v => { if (v.ask?.kind !== 'permission') return; shown.push(v); const k = v.ask; setTimeout(() => t2.event({ type: 'action', view: v.name, name: 'answer', context: { ticket: k.ticket, choice: k.choices![1], n: 1 } }), 20); } });
  const mcp2 = new Client({ name: 'harness', version: '1' }); await mcp2.connect(new StreamableHTTPClientTransport(new URL(t2.device!.url)));
  try {
    const no = await mcp2.callTool({ name: 'read_clipboard', arguments: {} }) as { content: { text: string }[]; isError?: boolean };
    assert.equal(no.isError, true); assert.equal(no.content[0].text, 'not read: the person said no to your clipboard');
    assert.equal(t2.record.all().length, 0); // nothing was read, so nothing is kept
  } finally { await mcp2.close(); await t2.close(); await uiProvider.close(); }
});

test('a template\'s first question can be answered while its task opens: the answer is not lost', async () => {
  const uiProvider = await startVindu();
  const cwd = tmp('work-'), home = tmp('home-'), data = tmp('data-'); const router: TaskRouter = {}; let answeredEarly = false; let t: Awaited<ReturnType<typeof openTask>> | undefined;
  const template = { name: 'Follow-up', inputs: { customer: { type: 'string', title: 'Customer' } }, slots: { note: { title: 'Note', block: 'text', needs: 'a note' } } };
  t = await openTask({ harness: 'claude', cwd, dataDir: data, home, uiProvider, connect: connectConsumer, env: { PATH: process.env.PATH ?? '/bin', HOME: home }, template, router,
    onText: () => undefined,
    onShow: v => { if (v.ask?.op !== 'start Follow-up') return; const k = v.ask; answeredEarly = !t; // the task is not open yet
      queueMicrotask(() => {
        assert.equal(t, undefined);
        assert.ok(router.event!({ type: 'action', view: v.name, name: 'answer', context: { ticket: k.ticket, 'f:customer': 'Havgap Media' } }));
      }); } });
  try {
    const started = await t.started as { started: boolean };
    assert.equal(answeredEarly, true); assert.equal(started.started, true);
    const kept = fs.readFileSync(path.join(data, 'answers.jsonl'), 'utf8');
    assert.match(kept, /"to":"the inputs of Follow-up","by":"person","values":\{"customer":"Havgap Media"\},"who":\["the person \(main\)"\]/);
  } finally { await t.close(); await uiProvider.close(); }
});

test('a new task from a view: a fresh session in the same folder, from the view as the person left it, what it shows carried exactly', async () => {
  const uiProvider = await startVindu({ waitMs: 300 });
  const cwd = tmp('work-'), home = tmp('home-'); const env = { PATH: '/bin', HOME: home };
  const invoices = [{ number: 'INV-2026-0412', amount: 31050 }, { number: 'INV-2026-0418', amount: 19800 }, { number: 'INV-2026-0431', amount: 17160 }];
  const shownA: Shown[] = [], shownB: Shown[] = []; let text = '';
  const a = await openTask({ harness: 'claude', cwd, dataDir: tmp('data-a-'), home, uiProvider, connect: connectConsumer, env, onShow: v => shownA.push(v), onText: () => undefined });
  const mcp = new Client({ name: 'harness', version: '1' });
  let b: Awaited<ReturnType<typeof openTask>> | undefined;
  try {
    const r = a.record.addResult({ server: 'accounts', tool: 'list_invoices', input: { status: 'overdue' }, text: '', rows: invoices, raw: { content: [{ type: 'text', text: JSON.stringify(invoices) }] }, fidelity: 'exact', via: 'tap' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(a.ui.url))); // as the harness shows a view
    await mcp.callTool({ name: 'show_view', arguments: { name: 'inv', title: 'Overdue', panels: [{ id: 'rows', card: 'table', from: r.id, columns: ['number', 'amount'] }] } });
    const n = shownA.length;
    a.event({ type: 'action', view: 'inv', name: 'view_action', context: { action: 'sort', panel: 'rows', field: 'amount' } }); // the person sorts it
    await until(() => shownA.length > n);
    b = await openTask({ harness: 'claude', cwd, dataDir: tmp('data-b-'), home, uiProvider, connect: connectConsumer, env, from: { snapshot: a.snapshot(), record: a.record, task: 'A' },
      onShow: v => shownB.push(v), onText: s => { text += s; } });
    await b.branched;
    const c = b.record.get('r1') as any; // carried, exactly
    assert.deepEqual([c.carried, c.digest, c.fidelity], [{ task: 'A', id: 'r1' }, r.digest, 'exact']);
    const rows = ((shownB.filter(v => v.name === 'inv').at(-1)!.wide.find((m: any) => m.updateDataModel) as any).updateDataModel.value.panels.p_rows.rows as any[]).map(x => x.c0);
    assert.deepEqual(rows, ['INV-2026-0431', 'INV-2026-0418', 'INV-2026-0412']); // as the person left it
    await b.prompt('[echo]');
    const out = JSON.parse(text);
    assert.match(out.context, /This task starts from a view of an earlier task, as the person left it: "Overdue", on what that task got, carried here exactly under this task's ids: r1 \(was r1\)\. Done in it: the person sorted Overdue by amount, smallest or earliest first\./);
  } finally { await mcp.close(); await b?.close(); await a.close(); await uiProvider.close(); }
});
