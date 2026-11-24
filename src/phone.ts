// The phone window's page: the task shown on the computer, drawn with Vindu's shell at the phone's own width (one pane
// after another), and what the person does there sent back: answers, approvals, pointing, opening a bar, operations.
// Never the layout: that is the computer's. Pages and MCP Apps show on the computer only; photos, video and sound come
// through the computer, as they are. A slot that wants a photo, a file or a signature says so at the top, with the
// phone's own camera or a pad to sign on. What is sent while offline waits here, in order, and goes when it can:
// answers and pointing in the page's storage, photos and files in its database (they may be large), until sent.
import { fileSelection, PHONE_BODY_LIMIT } from './phone-transfer.js';
import type { Ask, Field } from '@matapao/vindu/server';
import { mountShell, type ShellHandle, type ShellState, type View } from '@matapao/vindu/renderer';

type Capture = { id: string; task: string; slot: string; kind: string; min?: number; max?: number; about?: string };
type Msg = Record<string, unknown>;
const SENDS = new Set(['action', 'select', 'attach', 'drill', 'page', 'operation']); // what the person does to what is shown
const KEY = 'vindu-phone-queue';
const base = location.pathname.endsWith('/') ? location.pathname : location.pathname.replace(/[^/]*$/, '');
const $ = (id: string) => document.getElementById(id)!;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const status = (t: string) => { const s = $('status'); s.textContent = t; s.hidden = !t; };

// ── sending, in order, offline too ────────────────────────────────────────────────────────────────────────────────
let queue: { task: string; e: Msg; who?: string }[] = [];
try { queue = JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { queue = []; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(queue)); } catch { /* it waits in memory */ } };
// A file may reach IndexedDB just before its companion answer reaches the queue.
const staging = new Set<string>();
let flushing = false;
async function flush(): Promise<void> {
  if (flushing) return; flushing = true;
  try {
    do {
      const item = queue[0];
      if (!(await sendKept())) return; // form attachments must reach the host before their answer
      if (!item || queue[0] !== item) continue;
      const context = item.e.context as Msg | undefined;
      if (Array.isArray(context?.pendingFiles) && context.pendingFiles.length) {
        queue.shift(); save(); drawAsks(); status('Choose the missing files again before submitting.'); continue;
      }
      try { const r = await fetch(`${base}event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) }); if (r.status >= 500 || r.status === 0) throw new Error(String(r.status)); }
      catch { status(`Offline: ${queue.length} waiting to be sent`); return; }
      queue.shift(); save(); status('');
      if (front === item.task && item.e.type === 'action') drawAsks();
    } while (queue.length);
  } finally { flushing = false; }
}
const NAME = 'vindu-phone-name';
const who = () => { try { return localStorage.getItem(NAME) ?? ''; } catch { return ''; } };
const send = (task: string, e: Msg) => { if (!SENDS.has(String(e.type))) return; queue.push({ task, e, who: who() }); save(); void flush(); };
{ // who answers here: their name goes with each answer, for what needs more than one person's yes (it is not verified)
  const i = $('who') as HTMLInputElement; i.value = who();
  i.addEventListener('change', () => { try { localStorage.setItem(NAME, i.value.trim()); } catch { /* for this visit only */ } });
}

// ── what the computer shows, fitted for here ──────────────────────────────────────────────────────────────────────
const MEDIA = /^http:\/\/[a-f0-9]{32}\.localhost:\d+\/media\//;
const through = (v: unknown): unknown => (typeof v === 'string' ? (MEDIA.test(v) ? `${base}media?u=${encodeURIComponent(v)}` : v)
  : Array.isArray(v) ? v.map(through) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, through(x)])) : v);
const onComputer = (c: Msg) => (c.component === 'Page' || c.component === 'McpApp'
  ? { id: c.id, component: 'Text', text: c.component === 'Page' ? 'This page shows on the computer.' : 'This app shows on the computer.' } : c);
const fit = (msgs: unknown) => (Array.isArray(msgs) ? msgs.map((m: Msg) => {
  const u = m.updateComponents as { components?: Msg[] } | undefined, d = m.updateDataModel;
  if (u?.components) return { ...m, updateComponents: { ...u, components: u.components.map(onComputer) } };
  if (d) return { ...m, updateDataModel: through(d) };
  return m;
}) : msgs);
const here = (v: View): View => ({ ...v, wide: fit((v as Msg).wide), compact: fit((v as Msg).compact) } as View);

const tasks = new Map<string, { views: Map<string, View>; state?: ShellState }>();
let front: string | undefined; let shell: ShellHandle | undefined; let captures: Capture[] = [];
const of = (task: string) => { let t = tasks.get(task); if (!t) tasks.set(task, t = { views: new Map() }); return t; };
function show(task: string) {
  front = task; shell?.destroy(); const root = $('views'); root.replaceChildren();
  const el = h('section', 'task'); root.append(el);
  shell = mountShell(el, { onEvent: e => send(task, e as Msg), theme: 'auto', labels: { noDrawer: k => `This ${k === 'terminal' ? 'terminal' : k === 'browser' ? 'page' : k} shows on the computer.` } });
  const t = of(task); for (const v of t.views.values()) shell.view(v); if (t.state) shell.state(t.state);
  drawCaptures(); drawAsks();
}

// ── what the task asks the person: the computer draws it in its thread; here, above the views, with the same choices ─
type AskView = View & { ask?: Ask };
function drawAsks() {
  const box = $('asks'); box.replaceChildren(); const task = front;
  if (!task) { box.hidden = true; return; }
  const x = of(task); // an ask the window lays out as a pane is the shell's; one the host draws in its thread is drawn here
  const open = [...x.views.values()].filter(v => !!(v as AskView).ask && !x.state?.views.some(p => p.name === v.name)) as AskView[];
  for (const v of open) {
    const k = v.ask!, el = h('div', 'ask'); box.append(el);
    const pending = queue.some(m => m.task === task && m.e.type === 'action' && (m.e.context as Msg | undefined)?.ticket === k.ticket);
    const act = (name: string, context: Msg) => { send(task, { type: 'action', view: v.name, name, context: { ticket: k.ticket, ...context } }); drawAsks(); };
    if (k.kind === 'permission' && k.op) el.append(h('div', 'ask-op', k.op)); // the call it asks about, as the thread shows it
    el.append(h('div', 'ask-title', k.title));
    if (k.message) el.append(h('p', '', k.message));
    for (const d of k.details ?? []) { if (d.label === 'tool' && d.text === k.op) continue; if (d.label) el.append(h('div', 'ask-label', d.label)); el.append(h('pre', '', d.text)); }
    if (k.link) el.append(h('div', 'ask-op', k.link));
    if (k.error) el.append(h('p', 'ask-error', k.error));
    const opts = h('div', 'ask-opts');
    const button = (label: string, f: () => void, main = false) => { const b = h('button', main ? 'primary' : 'plain', label); b.type = 'button'; b.disabled = pending; b.addEventListener('click', f); opts.append(b); };
    const fields = Object.entries(k.fields ?? {});
    if (k.choices?.length) k.choices.forEach((c, n) => button(c, () => act('answer', { choice: c, n }))); // the harness's options, its order, its words, none put first
    else if (k.link) { button('Open the page', () => act('answer', {}), true); button('Decline', () => act('decline', {})); }
    else if (k.confirm && !fields.length) { button('Allow', () => act('answer', {}), true); button('Deny', () => act('decline', {})); }
    else {
      const picked = new Map<string, File[]>();
      const read = fields.map(([key, field]) => [key, fieldOn(el, key, field, (k.required ?? []).includes(key), files => picked.set(key, files), k.files?.[key]?.names)] as const);
      button('Submit', () => {
        const values = Object.fromEntries(read.flatMap(([key, get]) => get ? [[`f:${key}`, get()]] : []));
        for (const b of opts.querySelectorAll('button')) b.disabled = true;
        void (async () => {
          const submission = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
          const selection = fileSelection(k);
          const uploads: (Kept & { form: { field: string } })[] = [];
          for (const [field, files] of picked) {
            const data = await readSelection(files);
            if (data.length) {
              const upload = { form: { task, ticket: k.ticket, field, submission }, files: data };
              uploadBody(upload); // validate all fields before storing any of them
              uploads.push(upload);
            }
          }
          staging.add(submission);
          try {
            for (const upload of uploads) await keep(upload);
            act('answer', { ...values, fileSelection: selection, submission, pendingFiles: uploads.map(upload => upload.form.field) });
          } finally { staging.delete(submission); }
        })().catch(error => { status(error instanceof UploadTooLarge ? error.message : 'Could not read the selected file. Choose it again.'); drawAsks(); });
      }, true);
      button('Decline', () => act('decline', {}));
    }
    el.append(opts);
    if (pending) el.append(h('p', 'hint', 'Sent: the computer takes it from here'));
  }
  box.hidden = !open.length;
}
function fieldOn(form: HTMLElement, key: string, f: Field, required: boolean, pick: (files: File[]) => void, names?: string[]): (() => unknown) | undefined {
  const wrap = h('label', 'ask-field'), name = `${f.title ?? key}${required ? '' : ' (optional)'}`; form.append(wrap);
  if (f.type === 'boolean' && !f.enum) { const i = h('input'); i.type = 'checkbox'; i.checked = f.default === true; wrap.append(i, ` ${name}`); return () => i.checked; }
  wrap.append(h('span', 'ask-label', name)); if (f.description) wrap.append(h('span', 'hint', f.description));
  if (f.enum) {
    const select = h('select'); select.multiple = !!f.multi;
    if (f.default === undefined && !f.multi) select.append(new Option('', ''));
    f.enum.forEach((v, n) => select.append(new Option(f.labels?.[n] ?? v, v, false, Array.isArray(f.default) ? f.default.includes(v) : f.default === v)));
    wrap.append(select); return () => f.multi ? [...select.selectedOptions].map(option => option.value) : select.value;
  }
  if (f.format === 'file') {
    const input = h('input'); input.type = 'file'; input.multiple = true; input.accept = f.accept ?? '';
    input.addEventListener('change', () => pick([...(input.files ?? [])])); wrap.append(input);
    if (names?.length) wrap.append(h('span', 'hint', names.join(', ')));
    return undefined;
  }
  const number = f.type === 'number' || f.type === 'integer', i = f.long ? h('textarea') : h('input');
  if (i instanceof HTMLInputElement) {
    if (number) i.inputMode = 'decimal';
    if (f.format === 'date' || f.format === 'time' || f.format === 'email') i.type = f.format;
    if (f.format === 'date-time') i.type = 'datetime-local';
  }
  if (f.default !== undefined) i.value = String(f.default); wrap.append(i);
  return () => (number && i.value.trim() !== '' ? Number(i.value) : i.value);
}

// ── captures: the phone's camera, its files, a pad to sign on ────────────────────────────────────────────────────
const ACCEPT: Record<string, string> = { photo: 'image/*', video: 'video/*', audio: 'audio/*', file: '' };
const TAKE: Record<string, string> = { photo: 'Take a photo', video: 'Record a video', audio: 'Record sound', file: 'Choose a file' };
const readFile = (f: File) => new Promise<{ name: string; mime: string; data: string }>((resolve, reject) => {
  const r = new FileReader(); r.onload = () => resolve({ name: f.name || 'capture', mime: f.type || 'application/octet-stream', data: String(r.result).split(',')[1] ?? '' }); r.onerror = () => reject(r.error); r.readAsDataURL(f);
});
type Kept = ({ id: string } | { form: { task: string; ticket: string; field: string; submission?: string } }) & { files: { name: string; mime: string; data: string }[] };
const DB = 'vindu-phone', STORE = 'captures'; const inMemory: Kept[] = []; // memory only where the browser keeps no database
const open = () => new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE, { autoIncrement: true }); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const store = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => { const d = await open(); return new Promise<T>((resolve, reject) => { const q = f(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); }); };
async function keep(k: Kept) { try { await store('readwrite', s => s.add(k)); } catch { inMemory.push(k); } }
async function kept(): Promise<{ key?: IDBValidKey; k: Kept }[]> {
  let rows: { key?: IDBValidKey; k: Kept }[] = [];
  try { const keys = await store('readonly', s => s.getAllKeys()); const vals = await store('readonly', s => s.getAll()); rows = keys.map((key, i) => ({ key, k: vals[i] as Kept })); } catch { /* no database */ }
  return [...rows, ...inMemory.map(k => ({ k }))];
}
const forget = async (r: { key?: IDBValidKey; k: Kept }) => { if (r.key !== undefined) await store('readwrite', s => s.delete(r.key!)).catch(() => undefined); else inMemory.splice(inMemory.indexOf(r.k), 1); };
class UploadTooLarge extends Error {
  constructor() { super('Choose smaller files. This selection is too large to send.'); }
}
async function readSelection(files: File[]) {
  const encodedSize = files.reduce((bytes, f) => bytes + 4 * Math.ceil(f.size / 3), 0);
  if (encodedSize > PHONE_BODY_LIMIT) throw new UploadTooLarge();
  return Promise.all(files.map(readFile));
}
function uploadBody(upload: Kept) {
  const body = JSON.stringify({ ...upload, who: who() });
  if (body.length > PHONE_BODY_LIMIT || new Blob([body]).size > PHONE_BODY_LIMIT) throw new UploadTooLarge();
  return body;
}
async function post(upload: Kept) {
  const r = await fetch(`${base}capture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: uploadBody(upload) });
  if (r.status === 413) throw new UploadTooLarge();
  if (r.status >= 500) throw new Error(String(r.status));
  if (!r.ok) return [];
  return (await r.json() as { ids?: string[] }).ids ?? [];
}
/** Photos and files taken while offline, in order: true once none waits. */
async function sendKept(): Promise<boolean> {
  for (const r of await kept()) {
    const form = 'form' in r.k ? r.k.form : undefined;
    if (form?.submission && staging.has(form.submission)) continue;
    const answer = form && queue.find(item => {
      const context = item.e.context as Msg | undefined;
      return item.task === form.task && item.e.name === 'answer' && context?.ticket === form.ticket && context?.submission === form.submission;
    });
    if (form && !answer) { await forget(r); continue; }
    try {
      const ids = await post(r.k);
      if (form && answer) {
        if (!ids.length) { queue = queue.filter(item => item !== answer); drawAsks(); }
        else {
          const context = answer.e.context as Msg;
          context.fileSelection = { ...(context.fileSelection as Record<string, string[]>), [form.field]: ids };
          if (Array.isArray(context.pendingFiles)) context.pendingFiles = context.pendingFiles.filter(field => field !== form.field);
        }
        save(); // persist the exact receipt before removing the upload
      }
      await forget(r); status(ids.length ? '' : 'Not kept: the slot no longer waits for it');
    }
    catch (error) {
      if (!(error instanceof UploadTooLarge)) { status('Offline: what you took waits here, and goes once connected'); return false; }
      await forget(r);
      if (answer) { queue = queue.filter(item => item !== answer); save(); drawAsks(); }
      status(error.message);
    }
  }
  return true;
}
async function upload(c: Capture, files: { name: string; mime: string; data: string }[]) {
  if (!files.length) return;
  status('Sending…');
  try { const ids = await post({ id: c.id, files }); status(ids.length ? '' : 'Not kept: the slot no longer waits for it'); }
  catch (error) { if (error instanceof UploadTooLarge) { status(error.message); return; } await keep({ id: c.id, files }); status('Offline: what you took waits here, and goes once connected'); }
}
function signPad(c: Capture) {
  const pad = h('div', 'pad'); const canvas = h('canvas'); canvas.width = 1000; canvas.height = 400;
  const bar = h('div', 'pad-bar'); const clear = h('button', '', 'Clear'), cancel = h('button', '', 'Cancel'), done = h('button', 'primary', 'Done');
  bar.append(clear, cancel, done); pad.append(h('p', '', c.about ?? 'Sign here'), canvas, bar); document.body.append(pad);
  const g = canvas.getContext('2d')!; g.lineWidth = 4; g.lineCap = 'round'; g.strokeStyle = '#111'; let drawing = false, marks = 0;
  const at = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height] as const; };
  canvas.addEventListener('pointerdown', e => { drawing = true; canvas.setPointerCapture(e.pointerId); const [x, y] = at(e); g.beginPath(); g.moveTo(x, y); });
  canvas.addEventListener('pointermove', e => { if (!drawing) return; const [x, y] = at(e); g.lineTo(x, y); g.stroke(); marks++; });
  canvas.addEventListener('pointerup', () => { drawing = false; });
  clear.addEventListener('click', () => { g.clearRect(0, 0, canvas.width, canvas.height); marks = 0; });
  cancel.addEventListener('click', () => pad.remove());
  done.addEventListener('click', () => { if (!marks) return; const data = canvas.toDataURL('image/png').split(',')[1] ?? ''; pad.remove(); void upload(c, [{ name: 'signature.png', mime: 'image/png', data }]); });
}
function drawCaptures() {
  const box = $('captures'); box.replaceChildren();
  for (const c of captures.filter(x => x.task === front)) {
    const row = h('div', 'cap'); row.append(h('span', 'cap-what', c.about ?? c.slot));
    if (c.kind === 'signature') { const b = h('button', 'primary', 'Sign'); b.addEventListener('click', () => signPad(c)); row.append(b); }
    else {
      const l = h('label', 'primary', TAKE[c.kind] ?? 'Choose'); const i = h('input'); i.type = 'file'; i.accept = ACCEPT[c.kind] ?? '';
      if (c.kind !== 'file') i.setAttribute('capture', c.kind === 'photo' || c.kind === 'video' ? 'environment' : 'user');
      i.multiple = (c.max ?? 2) > 1; i.addEventListener('change', () => { void readSelection([...(i.files ?? [])]).then(fs => upload(c, fs)).catch(e => status(e instanceof UploadTooLarge ? e.message : 'Could not read the selected file.')); });
      l.append(i); row.append(l);
    }
    box.append(row);
  }
  box.hidden = !box.children.length;
}

// ── the computer's stream: again after the phone was offline, from what the computer shows then ─────────────────
let events: EventSource | undefined;
const HANDLERS: Record<string, (d: Msg) => void> = {
  front: d => { const t = String(d.task ?? ''); if (t && t !== front) show(t); },
  view: d => { const t = String(d.task), v = here(d.view as View); of(t).views.set(v.name, v); if (t !== front) return; shell?.view(v); if ((v as AskView).ask) drawAsks(); },
  shell: d => { const t = String(d.task), s = d.state as ShellState; const x = of(t); x.state = s;
    for (const name of [...x.views.keys()]) if (!s.views.some(v => v.name === name) && !(x.views.get(name) as { ask?: unknown } | undefined)?.ask) x.views.delete(name); // a view that left the window; an open ask stays until it goes
    if (t === front) { shell?.state(s); drawAsks(); } },
  askGone: d => { const t = String(d.task); of(t).views.delete(String(d.view)); if (t === front) show(t); }, // answered here or on the computer
  app: () => undefined, // an MCP App's frame is on the computer only
  captures: d => { captures = (d.list as Capture[]) ?? []; drawCaptures(); },
  closed: d => { tasks.delete(String(d.task)); if (d.task === front) { shell?.destroy(); shell = undefined; $('views').replaceChildren(h('p', 'none', 'The task was closed on the computer.')); } },
};
function connect() {
  events?.close();
  const es = events = new EventSource(`${base}events`);
  for (const [name, f] of Object.entries(HANDLERS)) es.addEventListener(name, ev => { try { f(JSON.parse((ev as MessageEvent).data)); } catch { /* not for here */ } });
  es.addEventListener('open', () => { void flush(); });
  es.addEventListener('error', () => {
    status(queue.length ? `Offline: ${queue.length} waiting to be sent` : 'Offline: reconnecting…');
    if (es.readyState === EventSource.CLOSED) setTimeout(() => { if (events === es) connect(); }, 3000); // the browser gave up: again, later
  });
}
connect();
addEventListener('online', () => { void flush(); if (events?.readyState === EventSource.CLOSED) connect(); });
setInterval(() => { void flush(); }, 3000); // what waits goes as soon as it can
