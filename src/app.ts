// The app's core: it opens Desktop's tasks and connects each to the processor that runs it. Celler brokers connector
// tools. Vindu serves task views and questions, in the desktop window, browser and paired devices.
import fs from 'node:fs';
import path from 'node:path';
import type { Sender } from './web.js';
import type { Opening } from './task-checkpoint.js';
import { workFolder } from './work.js';
import { openPath, pickFiles, pickFolder, pickSave } from './os.js';
import { APP, type AppOptions } from './desktop-settings.js';
import { openDesktopHost, requireLocalDesktop } from './desktop-host.js';
import { taskActivity } from './desktop-task-activity.js';
import { taskCaptures } from './desktop-task-captures.js';
import { taskPanes } from './desktop-task-panes.js';
import { desktopTasks } from './desktop-tasks.js';

export type { AppOptions } from './desktop-settings.js';
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'template';

export async function startApp(o: AppOptions = {}) {
  const host = await openDesktopHost(o);
  const { userData, home, send, tasksFolder, tilde, desktop, granted, celler, network, doors } = host;
  const { availableConnectors, keyOf, connectorsDir, openKeys, keysFile } = host.connectors;
  const { files, attach } = host.attachments;
  const state = taskActivity(host);
  const { tasks, opened, latest, routers, startedWith, need, acts, save, changed, checkpoints, unavailable,
    notices, notify } = state;
  const media = taskCaptures(host, state);
  const { toPhone, togglePhone } = media;
  const panes = taskPanes(host, state);
  const { pages } = panes;
  const { start, runPrompt } = desktopTasks(host, state, media, pages);

  // templates: files in the app's folder, each a static view the person can start a task with
  const templatesDir = path.join(userData, 'templates');
  const listTemplates = () => {
    fs.mkdirSync(templatesDir, { recursive: true });
    return fs.readdirSync(templatesDir).filter(f => f.endsWith('.json')).sort().map(file => {
      try { const j = JSON.parse(fs.readFileSync(path.join(templatesDir, file), 'utf8')); return { file, name: String(j.name ?? file), ...(j.about ? { about: String(j.about) } : {}), ...(j.version !== undefined ? { version: j.version } : {}) }; }
      catch { return { file, name: file, problem: 'not a template: its JSON does not read' }; }
    });
  };
  const readTemplate = (file: string) => { if (path.basename(file) !== file || !file.endsWith('.json')) throw new Error(`no template "${file}"`); return JSON.parse(fs.readFileSync(path.join(templatesDir, file), 'utf8')) as unknown; };
  const saveTemplate = (t: { name: string }, file?: string) => {
    fs.mkdirSync(templatesDir, { recursive: true });
    let f = file; if (!f) { const s = slug(t.name); f = `${s}.json`; for (let n = 2; fs.existsSync(path.join(templatesDir, f)); n++) f = `${s}-${n}.json`; }
    fs.writeFileSync(path.join(templatesDir, f), `${JSON.stringify(t, null, 2)}\n`); return f;
  };
  const exportTask = async (id: string) => {
    const t = need(id);
    const out = o.pickSave ? await o.pickSave(`task-${id}.zip`) : await pickSave('Export the task', `task-${id}.zip`, path.join(home, 'Documents'));
    if (!out) return null;
    const z = t.archive(out); send('note', id, `exported the task: ${z.files} files, ${z.bytes} bytes, in ${out}`); return { file: z.file, files: z.files, bytes: z.bytes };
  };
  const pickedFolders = new WeakMap<Sender, { selection: string; cwd: string }>();
  desktop.handle('settings:servers', () => []);
  desktop.handle('templates:list', () => listTemplates());
  desktop.handle('templates:delete', (_e, file: string) => { readTemplate(file); fs.rmSync(path.join(templatesDir, file)); return listTemplates(); });
  desktop.handle('settings:connectors', async () => { const { connectors, failed } = availableConnectors(); // what the person may give a task, and why any did not read
    return { list: await Promise.all(connectors.map(async c => ({ name: c.name, title: c.title, kind: c.kind, guide: !!c.skill, ...(c.kind === 'http' && c.http?.auth ? { key: (await keyOf(c)) ? 'set' : 'missing' } : {}) }))), failed }; });
  desktop.handle('keys:open', e => { requireLocalDesktop(e); return openKeys(); }); // the keys page's address: the page opens it in a tab of its own
  desktop.handle('task:reminders', (_e, id: string) => { need(id).showReminders(); });
  /** A new task from a task's view, as the person left it: the same harness, folder, servers and connectors, a fresh
   *  session, and the view carried with what it points at (exact, under the new task's ids). */
  desktop.handle('task:branch', async (_e, from: string) => {
    const was = opened.get(from); const t0 = need(from); if (!was) throw new Error(`no task ${from}`);
    const snapshot = t0.snapshot(); if (!snapshot.views.length) throw new Error('this task shows no view of cards to start from yet');
    return start({ ...was.q, template: undefined }, was.cwd, {
      from: { snapshot, record: t0.record, task: from },
    });
  });
  /** Open the task in its chosen folder, or in a new workspace named from the prompt. */
  desktop.handle('task:create', async ({ sender }, q: Opening & { id: string; folder?: string | null; title?: string }) => {
    const template = q.template ? readTemplate(q.template) : undefined;
    const opening = { harness: q.harness, servers: q.servers, connectors: q.connectors, template: q.template, ...(q.inference ? { inference: q.inference } : {}) };
    const picked = pickedFolders.get(sender);
    if (q.folder && picked?.selection !== q.folder) throw new Error('Choose the working folder for this task');
    pickedFolders.delete(sender);
    const made = !q.folder; const cwd = q.folder && picked ? picked.cwd : workFolder(tasksFolder(), q.title ?? '');
    try { return await start(opening, cwd, { template, id: String(q.id) }); }
    catch (e) { if (made) try { fs.rmdirSync(cwd); } catch { /* not empty: left as it is */ } throw e; }
  });
  desktop.handle('app:processors', () => granted()); // the harnesses Desktop may use, as Processors in Settings give them
  desktop.handle('settings:inference', () => []);
  desktop.handle('settings:folder', () => ({ root: tilde(tasksFolder()) })); // where a task gets a folder of its own when the person picks none
  desktop.handle('pick:folder', async ({ sender }) => {
    const folder = await (o.pickFolder ? o.pickFolder() : pickFolder("The task's working folder"));
    if (folder) pickedFolders.set(sender, { selection: folder, cwd: fs.realpathSync(folder) });
    return folder;
  });
  desktop.handle('pick:files', async () => attach(await pickFiles('Attach files', { many: true })));
  // a turn: the files it carries are named by their ids; the window never gives a path
  desktop.handle('task:prompt', (_e, id: string, text: string, servers?: string[], attached: string[] = [], origin?: string) => runPrompt(id, text, servers, attached.flatMap(f => files.get(f) ?? []), origin));
  desktop.handle('task:cancel', async (_e, id: string) => { await need(id).cancel(); });
  desktop.handle('task:reveal', (_e, id: string) => { openPath(need(id).work); });
  desktop.handle('task:unheard', (_e, id: string) => tasks.get(id)?.unheard() ?? []);
  desktop.handle('task:set', async (_e, id: string, sw: string, value: string | boolean) => { const t = need(id); await t.set(sw, value); return t.switches(); });
  // the view: pin it as a template, keep the person's arrangement of the template, let the model change it again
  desktop.handle('task:mode', (_e, id: string) => need(id).mode());
  desktop.handle('task:pin', async (_e, id: string, name: string) => { const r = await need(id).pin(name); const file = saveTemplate(r.template); return { file, notes: r.notes, templates: listTemplates() }; });
  desktop.handle('task:arrangement', (_e, id: string) => { const tpl = need(id).arrangement(); if (!tpl) return null; const file = saveTemplate(tpl, startedWith.get(id)); return { file, templates: listTemplates() }; });
  desktop.handle('task:let-model-change', (_e, id: string) => need(id).letModelChange());
  desktop.handle('task:selection', (_e, id: string) => need(id).selection());
  desktop.handle('task:export', (_e, id: string) => exportTask(id));
  const closeTask = async (id: string) => {
    if (!opened.has(id)) return;
    state.closeCheckpoint(id);
    panes.detach(id);
    media.cancelTask(id);
    const t = tasks.get(id); // its folder stays as the harness left it
    try { await t?.close(); } finally {
      tasks.delete(id); routers.delete(id); latest.delete(id); startedWith.delete(id); toPhone('closed', { task: id }); void doors.release(id);
      state.clear(id);
      await pages.closeTask(id);
    }
  };
  desktop.handle('task:close', (_e, id: string) => closeTask(id));
  desktop.on('task:shown', (_e, id: string) => {
    if (state.front !== id) toPhone('front', { task: id }); state.front = id; pages.front(id);
    const a = acts.get(id); if (a) { a.seenAt = Date.now(); a.unseen = []; } changed(id); // what the person now looks at is seen
  });
  desktop.on('shell:event', ({ sender }, id: string, ev: unknown) => {
    routers.get(id)?.event?.(ev, 'main', (view, panel, msg) => sender.send('app', id, view, panel, msg));
  });

  for (const { id, load } of checkpoints.open()) {
    try {
      const saved = load();
      // a task another app started, from when Vindu.app hosted other apps: there is no app to reopen it in
      if (saved.owner.id !== APP.id || saved.owner.folder !== undefined) throw new Error('The task’s original app is unavailable.');
      await start(saved.opening, saved.cwd, { id, saved });
    } catch (error) {
      unavailable.push(`Could not reopen task ${id}: ${(error as Error).message}`);
    }
  }

  const close = async () => {
    if (state.closing) return;
    state.closing = true;
    for (const id of tasks.keys()) { try { save(id); } catch { console.warn(`Could not save task ${id} before shutdown.`); } }
    await network?.close();
    doors.close();
    await media.close();
    notices.clear();
    await Promise.allSettled([...tasks.values()].map(task => task.close()));
    tasks.clear();
    await pages.stop();
    await host.close();
  };
  /** Desktop's address, for the person; for a test: Desktop's page, the tasks, where each page's pane is and whether it is pictured, and Celler. */
  return {
    url: desktop.url, desktop, send, tasks, close, togglePhone, phone: media.phone,
    templatesDir, connectorsDir, openKeys, keysFile, notify, notices: () => notices.size, captures: media.list,
    activity: state.list, front: () => state.front, act: (id: string) => acts.get(id),
    pages: (task: string) => pages.pages(task), pageEval: (task: string, name: string, js: string) => pages.evaluate(task, name, js),

    celler,
    /** The network side: a code to pair with, as Phone in Settings makes one (a test's other computer). */
    pairingCode: () => network!.devices.newCode().code,
  };
}
export type App = Awaited<ReturnType<typeof startApp>>;
