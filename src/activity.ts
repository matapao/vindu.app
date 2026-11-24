// The activity column: every open task, by what it needs from the person. A task in the background never takes the
// window; it moves its entry here instead, and only the person switches. The order is the system's, and says why:
//   Waiting for you   an ask is open in the task (the harness's permission, a form, a page to open, the model's question)
//   Went wrong        a turn failed, or a yes did not go as approved, since the person last looked at the task
//   Due               a reminder of the task's is due
//   Noticed           a view's hook told the person something (a value crossed a line, a read changed)
//   Done              the task finished, or showed views, since the person last looked at it
//   Running           a turn is under way
//   Quiet             nothing new
// Within a group the longest wait comes first. A task the person pins comes first of all, and one they mute comes last,
// says nothing to the system's notifications, and is never the next. The next is the first entry that needs the
// person and is not in front. No model is asked: it costs nothing, and the same tasks give the same order.
// Pure: no DOM, no I/O. desktop-task-activity.ts keeps each task's Activity; the window draws arrange()'s entries.

export type ActState = 'waiting' | 'wrong' | 'due' | 'noticed' | 'running' | 'done' | 'quiet';
export type Activity = {
  id: string; title: string; folder: string; harness: string;
  job?: string;                                   // a hook's job: what started it
  opened: number;
  running?: { since: number; what: string };
  ended?: { at: number; stop: string };
  asks: { view: string; title: string; since: number }[];
  due: { count: number; since?: number; what?: string };
  problems: { at: number; what: string }[];
  notices?: { at: number; what: string }[];       // what a view's hook told the person
  unseen: string[]; changedAt?: number;           // views shown or changed while the task was not in front
  seenAt: number;                                 // when the task was last in front
  pinned: boolean; muted: boolean;
};
export type Entry = { id: string; title: string; folder: string; harness: string; job?: string; state: ActState; group: string; reason: string; since: number; front: boolean; pinned: boolean; muted: boolean };
export const GROUPS: Record<ActState, string> = { waiting: 'Waiting for you', wrong: 'Went wrong', due: 'Due', noticed: 'Noticed', done: 'Done', running: 'Running', quiet: 'Quiet' };
/** The order of the groups in the column. */
export const ORDER: ActState[] = ['waiting', 'wrong', 'due', 'noticed', 'done', 'running', 'quiet'];
/** What counts as needing the person: what the next may be. */
const NEEDS: ActState[] = ['waiting', 'wrong', 'due', 'noticed', 'done'];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Status = { state: ActState; reason: string; since: number };

function recentStatus(state: 'wrong' | 'noticed', events: Activity['problems'], seenAt: number): Status | undefined {
  const fresh = events.filter(event => event.at > seenAt);
  if (!fresh.length) return undefined;
  const latest = fresh[fresh.length - 1];
  const reason = fresh.length === 1 ? latest.what : `${latest.what} (and ${plural(fresh.length - 1, 'more')})`;
  return { state, since: fresh[0].at, reason };
}

/** The first matching state wins. ORDER separately controls how entries appear in the column. */
export function stateOf(a: Activity): Status {
  if (a.asks.length) {
    const asks = [...a.asks].sort((x, y) => x.since - y.since);
    const reason = asks.length === 1 ? asks[0].title : `${plural(asks.length, 'question')}: ${asks.map(ask => ask.title).join('; ')}`;
    return { state: 'waiting', since: asks[0].since, reason };
  }

  const problem = recentStatus('wrong', a.problems, a.seenAt);
  if (problem) return problem;
  if (a.due.count) {
    const reason = a.due.count === 1 && a.due.what ? `reminder: ${a.due.what}` : `${plural(a.due.count, 'reminder')} due`;
    return { state: 'due', since: a.due.since ?? a.seenAt, reason };
  }
  const notice = recentStatus('noticed', a.notices ?? [], a.seenAt);
  if (notice) return notice;
  if (a.running) return { state: 'running', since: a.running.since, reason: `working on "${a.running.what}"` };

  const ended = a.ended && a.ended.at > a.seenAt ? a.ended : undefined;
  if (ended || a.unseen.length) {
    const views = a.unseen.length ? `${plural(a.unseen.length, 'new view')}, not seen yet` : 'not seen yet';
    const stop = ended && ended.stop !== 'end_turn' ? ` (${ended.stop})` : '';
    return { state: 'done', since: ended?.at ?? a.changedAt ?? a.seenAt, reason: ended ? `finished${stop}: ${views}` : views };
  }
  return { state: 'quiet', since: a.seenAt, reason: 'nothing new' };
}

/** The column: pinned first, then each group in its order, the longest wait first; muted last. And the next task to go
 *  to: the first entry that needs the person, not in front and not muted. */
export function arrange(list: Activity[], front?: string): { entries: Entry[]; next?: Entry } {
  const entries = list.map(a => { const s = stateOf(a); return { id: a.id, title: a.title, folder: a.folder, harness: a.harness, ...(a.job ? { job: a.job } : {}), ...s, group: GROUPS[s.state], front: a.id === front, pinned: a.pinned, muted: a.muted }; });
  const rank = (e: Entry) => (e.pinned && !e.muted ? 0 : e.muted ? 2 : 1);
  entries.sort((x, y) => rank(x) - rank(y) || ORDER.indexOf(x.state) - ORDER.indexOf(y.state) || x.since - y.since || x.id.localeCompare(y.id));
  const next = entries.find(e => !e.front && !e.muted && NEEDS.includes(e.state));
  return { entries, ...(next ? { next } : {}) };
}

/** Whether a task's change is worth the system's notification: only what blocks it (a new ask), a due reminder or what a
 *  view's hook was written to tell the person, only
 *  when the person is not already looking at it, and never for a task they muted. */
export function notifies(was: ActState | undefined, now: ActState, o: { front: boolean; focused: boolean; muted: boolean }): boolean {
  if (o.muted || (o.front && o.focused)) return false;
  return (now === 'waiting' || now === 'due' || now === 'noticed') && was !== now;
}

/** How long ago, in a few letters: now, 4 min, 2 h, 3 d. */
export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
