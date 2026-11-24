import path from 'node:path';
import type { Reminder } from '@matapao/vindu/server';
import { APP } from './desktop-settings.js';
import type { DesktopHost } from './desktop-host.js';
import type { OpenTask, TaskRouter } from './task.js';
import { TaskCheckpoints, type Opening, type ThreadItem } from './task-checkpoint.js';
import { arrange, stateOf, notifies, type Activity, type ActState } from './activity.js';

export type TaskActivity = ReturnType<typeof taskActivity>;

export function taskActivity(host: DesktopHost) {
  const { userData, send, desktop, network, tilde } = host;
  const tasks = new Map<string, OpenTask>();
  let closing = false;
  const routers = new Map<string, TaskRouter>(); // each task's way in, from the moment its window exists
  // what each task shows now, for a phone window that comes later
  const latest = new Map<string, { views: Map<string, unknown>; state?: unknown }>();
  const seen = (task: string) => { let l = latest.get(task); if (!l) latest.set(task, l = { views: new Map() }); return l; };
  const startedWith = new Map<string, string>(); // task → its template's file
  const opened = new Map<string, { q: Opening; cwd: string; readsOnly: boolean }>();
  const need = (id: string) => { const t = tasks.get(id); if (!t) throw new Error(`no task ${id}`); return t; };
  let front: string | undefined;
  let seeing = { visible: false, focused: false }, screens: { width: number; height: number; scale: number } | undefined;
  const onScreen = () => seeing.visible && seeing.focused;
  // a reminder that came due: the system's notification; a click brings the window, and the task's Reminders pane
  const notices = new Map<string, () => void>(); let noticed = 0; // each notice the page shows, and what its click does
  /** A notice for a task, as the browser's notification on Desktop's page: a click brings the page, with that task in front. */
  const notice = (task: string, title: string, body: string, then?: () => void) => {
    const id = `n${++noticed}`;
    notices.set(id, () => { send('front', task); then?.(); });
    send('notice', { id, task, title, body });
    if (!onScreen()) void network?.notify({ title, body, tag: `desktop:${task}` }); // and on the person's devices, when they are away from this one
  };
  const looking = (task: string) => task === front && onScreen();
  const notify = (task: string, r: Reminder) => {
    send('note', task, `a reminder is due: ${r.what}`);
    const a = acts.get(task); if (a) { a.due = { count: Math.max(1, a.due.count), since: a.due.since ?? Date.now(), what: r.what }; changed(task, true); }
    if (a?.muted || looking(task)) return; // the bar's chip says it
    notice(task, 'Reminder', r.what, () => tasks.get(task)?.showReminders());
  };
  // the activity column: each task by what it needs from the person
  const acts = new Map<string, Activity>();
  const unavailable: string[] = [];
  const checkpoints = new TaskCheckpoints(path.join(userData, 'tasks'));
  const threads = new Map<string, ThreadItem[]>();
  const saves = new Map<string, ReturnType<typeof setTimeout>>();
  const save = (id: string) => {
    clearTimeout(saves.get(id)); saves.delete(id);
    const activity = acts.get(id), task = tasks.get(id), opening = opened.get(id);
    if (!activity || !task || !opening) return;
    const { cwd, q, readsOnly } = opening;
    checkpoints.save(id, { version: 1, cwd, owner: { id: APP.id }, opening: q, readsOnly,
      activity, named: named.has(id), view: task.checkpoint(), thread: threads.get(id) ?? [] });
  };
  const scheduleSave = (id: string) => {
    if (closing || !tasks.has(id) || saves.has(id)) return;
    saves.set(id, setTimeout(() => {
      try { save(id); } catch { send('app-note', 'Could not save this task for restart. Check available disk space.'); }
    }, 100));
  };
  const remember = (id: string, item: ThreadItem) => {
    const thread = threads.get(id);
    if (!thread) return;
    const last = thread.at(-1);
    if (item.kind === 'text' && last?.kind === 'text') last.text += item.text;
    else thread.push(item);
    scheduleSave(id);
  };
  const threadAsks = new Map<string, Set<string>>(); // the asks each task's thread draws (uiProvider makes no pane for them)
  /** An ask came to the thread, or left it: the task's entry says so. */
  const threadAsk = (id: string, view: string, title?: string) => {
    const a = acts.get(id); let set = threadAsks.get(id); if (!set) threadAsks.set(id, set = new Set());
    if (title !== undefined) { set.add(view); if (a && !a.asks.some(x => x.view === view)) a.asks.push({ view, title, since: Date.now() }); }
    else { set.delete(view); if (a) a.asks = a.asks.filter(x => x.view !== view); }
    changed(id);
  };
  const was = new Map<string, ActState>(); const named = new Set<string>(); const noted = new Map<string, Set<string>>();
  let actTimer: ReturnType<typeof setTimeout> | undefined;
  const tellActivity = () => { if (actTimer) return; actTimer = setTimeout(() => { actTimer = undefined; send('activity', arrange([...acts.values()], front)); }, 40); };
  /** A task's entry changed: what the person is looking at counts as seen; the column hears of it; what newly blocks a
   *  task they are not looking at is the system's notification (quiet: the caller notifies, as a reminder does). */
  const changed = (id: string, quiet = false) => {
    const a = acts.get(id); if (!a) return;
    if (looking(id)) { a.seenAt = Date.now(); a.unseen = []; }
    const s = stateOf(a); const before = was.get(id); was.set(id, s.state);
    if (!quiet && s.state === 'waiting' && notifies(before, s.state, { front: id === front, focused: onScreen(), muted: a.muted })) notice(id, `${a.title}: waiting for you`, s.reason);
    scheduleSave(id); tellActivity();
  };
  /** What the task's window says now: its open asks, its due reminders, and each yes that did not go as approved. */
  const fromShell = (id: string, st: { views: { name: string; title: string; ask?: boolean }[]; reminders?: { due: number } }) => {
    const a = acts.get(id); if (!a) return;
    const now = Date.now();
    const panes = st.views.filter(v => v.ask).map(v => ({ view: v.name, title: v.title, since: a.asks.find(x => x.view === v.name)?.since ?? now }));
    a.asks = [...panes, ...a.asks.filter(x => !panes.some(p => p.view === x.view) && threadAsks.get(id)?.has(x.view))]; // an ask the thread draws has no pane
    const due = st.reminders?.due ?? 0;
    if (due !== a.due.count) {
      const what = due === 1 ? tasks.get(id)?.reminders().find(r => r.state === 'due')?.what : undefined;
      a.due = due ? { count: due, since: a.due.count ? a.due.since : now, ...(what ? { what } : {}) } : { count: 0 };
    }
    const seen = noted.get(id) ?? new Set<string>(); noted.set(id, seen);
    for (const r of tasks.get(id)?.receipts() ?? []) if ((r.state === 'differs' || r.state === 'failed') && !seen.has(r.ticket)) {
      seen.add(r.ticket); a.problems.push({ at: now, what: `${r.label}: ${r.state === 'differs' ? 'went, but not as approved' : 'approved, but it failed'}` });
    }
    changed(id);
  };
  // the activity column: the person pins a task to the top, or mutes one (last, no notifications, never the next)
  desktop.handle('activity:list', () => arrange([...acts.values()], front));
  desktop.handle('activity:restore', () => ({
    activity: arrange([...acts.values()], front), unavailable: [...unavailable],
    tasks: [...tasks].map(([id, task]) => ({ id, thread: threads.get(id) ?? [], views: [...(latest.get(id)?.views.values() ?? [])],
      state: latest.get(id)?.state, switches: task.switches(), mode: task.mode(), where: tilde(task.cwd) })),
  }));
  desktop.handle('activity:pin', (_e, id: string, on: boolean) => { const a = acts.get(id); if (a) { a.pinned = !!on; if (on) a.muted = false; scheduleSave(id); tellActivity(); } });
  desktop.handle('activity:mute', (_e, id: string, on: boolean) => { const a = acts.get(id); if (a) { a.muted = !!on; if (on) a.pinned = false; scheduleSave(id); tellActivity(); } });
  // Desktop's page: what the person can see of it, the screen it is on, and the notices it showed
  desktop.on('page:attention', (_e, a: { visible?: unknown; focused?: unknown }) => { const was = onScreen(); seeing = { visible: a?.visible === true, focused: a?.focused === true }; if (!was && onScreen() && front) changed(front); }); // what the person now sees is seen
  desktop.on('page:screen', (_e, x: { width?: unknown; height?: unknown; scale?: unknown }) => { screens = { width: Number(x?.width) || 0, height: Number(x?.height) || 0, scale: Number(x?.scale) || 1 }; });
  desktop.on('notice:click', (_e, id: string) => { const f = notices.get(id); notices.delete(id); f?.(); });
  desktop.on('notice:closed', (_e, id: string) => { notices.delete(id); });

  function clear(id: string) {
    acts.delete(id); was.delete(id); named.delete(id); noted.delete(id); threadAsks.delete(id); tellActivity();
  }

  function closeCheckpoint(id: string) {
    save(id);
    checkpoints.close(id);
    clearTimeout(saves.get(id));
    saves.delete(id);
    opened.delete(id);
    threads.delete(id);
  }
  return { tasks, routers, opened, threads, acts, seen, latest, startedWith, named, threadAsks, checkpoints, unavailable,
    remember, threadAsk, changed, fromShell, notify, notices, save, tellActivity, need, clear, closeCheckpoint,
    get screens() { return screens; },
    get front() { return front; }, set front(id) { front = id; },
    get closing() { return closing; }, set closing(value) { closing = value; },
    list: () => arrange([...acts.values()], front),
  };
}
