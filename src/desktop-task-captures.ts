import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskSetup } from './task.js';
import type { DeviceTool } from './device.js';
import { requireLocalDesktop, type DesktopHost } from './desktop-host.js';
import type { Settings } from './desktop-settings.js';
import type { TaskActivity } from './desktop-task-activity.js';
import { clipboardText, locale, pickFiles } from './os.js';
import { startRemote, type Remote } from './remote.js';

type Capture = { id: string; task: string; slot: string; kind: string; min?: number; max?: number; about?: string };
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json' };
const mimeOf = (file: string) => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
const FILTERS: Record<string, { name: string; extensions: string[] }[]> = { photo: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'] }],
  signature: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }], video: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm'] }], audio: [{ name: 'Sound', extensions: ['m4a', 'mp3', 'wav', 'ogg'] }], file: [] };

export type TaskCaptures = ReturnType<typeof taskCaptures>;

export function taskCaptures(host: DesktopHost, state: TaskActivity) {
  const { send, userData, readSettings, uiProvider, desktop, options: o } = host;
  const { tasks, routers, latest } = state;
  let phone: Remote | undefined;
  const toPhone = (event: string, data: unknown) => phone?.push(event, data);
  /** The device's data the person's settings turn on; each is asked for in the window before its first read. */
  const deviceTools = (d: Settings['device']): DeviceTool[] => [
    ...(d?.clipboard ? [{ name: 'read_clipboard', description: 'The text on the clipboard now.', asks: 'your clipboard', read: async () => ({ text: await clipboardText() }) }] : []),
    ...(d?.info ? [{ name: 'device_info', description: 'This device: its system, locale, time zone and screens.', asks: 'this device\'s system, locale, time zone and screens',
      read: () => ({ system: process.platform, locale: locale(), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, screens: state.screens ? [state.screens] : [] }) }] : []), // the screen Desktop's page is on
  ];
  // what a slot of the person's waits for: a file here, or the phone's camera or pad, whichever comes first
  const captures = new Map<string, Capture & { done: (ids: string[], by?: { name: string; window: string }) => void }>(); let captured = 0;
  const announce = () => { const list = [...captures.values()].map(({ done: _d, ...c }) => c); send('captures', list); toPhone('captures', { list }); };
  const keepFiles = (task: string, files: { name: string; mime: string; data?: Buffer; file?: string }[]) => {
    const record = tasks.get(task)?.record ?? routers.get(task)?.record; if (!record) return [];
    const dir = path.join(userData, 'tasks', task, 'captured'); fs.mkdirSync(dir, { recursive: true });
    return files.map(f => { const to = path.join(dir, `${randomUUID()}-${path.basename(f.name).replace(/[^\w. -]/g, '_')}`); if (f.file) fs.copyFileSync(f.file, to); else fs.writeFileSync(to, f.data!); return record.addAttachment(path.basename(f.name), f.mime, to).id; });
  };
  /** A form's file field: the picker at once; what the person picks is kept as attachments. */
  const pickNow = async (task: string, c: { about?: string; slot: string; max?: number; accept?: string }) => {
    const ext = (c.accept ?? '').split(',').map(x => x.trim()).filter(x => /^\.\w+$/.test(x)).map(x => x.slice(1));
    const picked = await pickFiles(c.about ?? c.slot, { many: (c.max ?? 2) > 1, extensions: ext });
    if (!picked.length) return { ids: [] };
    return { ids: keepFiles(task, picked.slice(0, c.max ?? 50).map(f => ({ name: path.basename(f), mime: mimeOf(f), file: f }))), by: { name: readSettings().person?.name ?? 'the person', window: 'main' } };
  };
  const phoneLog = (e: Record<string, unknown>) => fs.appendFileSync(path.join(userData, 'phone.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`);
  const togglePhone = async () => {
    if (phone) { const p = phone; phone = undefined; await p.close(); return null; }
    const s = readSettings();
    phone = await startRemote({ userData, lanName: o.lanName, lan: s.phone?.lan === true, port: s.phone?.port ?? 0, log: phoneLog, media: { port: uiProvider.pagesPort },
      files: { html: path.join(import.meta.dirname, '..', '..', 'static', 'phone.html'), js: path.join(import.meta.dirname, 'phone.bundle.js') },
      onEvent: (task, e, who) => routers.get(task)?.event?.(who && e.type === 'action' ? { ...e, by: { name: who, window: 'phone' } } : who && e.type === 'select' ? { ...e, from: { name: who, window: 'phone' } } : e, 'phone') ?? false,
      onFormFiles: (task, ticket, field, files) => tasks.get(task)?.ui.provideFiles(ticket, field, () => keepFiles(task, files)) ?? [],
      onCapture: async (id, files, who) => { const c = captures.get(id); if (!c) return []; const ids = keepFiles(c.task, files); if (ids.length) c.done(ids, { name: who ?? readSettings().person?.name ?? 'the person', window: 'phone' }); return ids; },
      replay: () => [...[...latest].flatMap(([task, l]) => [...[...l.views.values()].map(view => ({ event: 'view', data: { task, view } })), ...(l.state ? [{ event: 'shell', data: { task, state: l.state } }] : [])]),
        ...(state.front ? [{ event: 'front', data: { task: state.front } }] : []), { event: 'captures', data: { list: [...captures.values()].map(({ done: _d, ...c }) => c) } }] });
    return { url: phone.url, lan: phone.lan };
  };
  desktop.handle('capture:file', async (_e, cid: string) => { // a slot's capture, from a file here
    const c = captures.get(cid); if (!c) return [];
    const picked = await pickFiles(c.about ?? `For ${c.slot}`, { many: (c.max ?? 2) > 1, extensions: FILTERS[c.kind]?.[0]?.extensions ?? [] });
    if (!picked.length) return [];
    const ids = keepFiles(c.task, picked.slice(0, c.max ?? 50).map(f => ({ name: path.basename(f), mime: mimeOf(f), file: f }))); c.done(ids, { name: readSettings().person?.name ?? 'the person', window: 'main' }); return ids;
  });
  desktop.handle('capture:skip', (_e, cid: string) => { captures.get(cid)?.done([]); });
  desktop.handle('phone:toggle', e => { requireLocalDesktop(e); return togglePhone(); });
  const capture = (id: string, c: Parameters<NonNullable<TaskSetup['capture']>>[0]) => (
    c.now ? pickNow(id, c) : new Promise<{ ids: string[]; by?: { name: string; window: string } }>(resolve => {
      const cid = `c${++captured}`;
      captures.set(cid, { id: cid, task: id, ...c, done: (ids, by) => {
        captures.delete(cid);
        announce();
        resolve({ ids, ...(by ? { by } : {}) });
      } });
      announce();
    })
  );
  const cancelTask = (id: string) => { for (const c of captures.values()) if (c.task === id) c.done([]); };
  const close = async () => {
    await phone?.close();
    phone = undefined;
    for (const capture of captures.values()) capture.done([]);
  };
  return { capture, cancelTask, togglePhone, toPhone, deviceTools, close, phone: () => phone,
    list: () => [...captures.values()].map(({ done: _d, ...c }) => c) };
}
