import type { Entry } from '../activity.js';
import { desktop } from '../desktop-client.js';
import { button, element } from './dom.js';
import type { Task } from './task-state.js';

/** How a task is doing: a word for the styles, and a line for the person. What it asks comes first; then what the
 *  system says needs the person (went wrong, due, noticed); then how its turn goes; then what it last said. */
export function cardStatus(task: Task, entry: Entry | undefined): [string, string] {
  const ask = [...task.asks.values()][0];
  if (ask) return ['needs', `Needs you · ${ask.ask.title}`];
  if (entry && (entry.state === 'wrong' || entry.state === 'due' || entry.state === 'noticed'))
    return [entry.state === 'wrong' ? 'failed' : 'needs', entry.reason];
  if (task.status === 'starting') return ['starting', 'Opening task…'];
  if (task.status === 'working') return ['working', task.doing || 'Working'];
  if (task.status === 'idle')
    return [
      entry?.state === 'done' ? 'new' : 'idle',
      task.last || (entry?.state === 'done' ? entry.reason : 'Ready'),
    ];
  return [task.status, task.doing];
}
/** A task's entry: its card (a click opens its thread), and Pin and Mute beside it. */
export function createActivityCard(
  task: Task,
  enter: (task: Task) => void,
  entryOf: (task: Task) => Entry | undefined,
): HTMLElement {
  const d = element('div', 'act');
  d.dataset.task = task.id;
  const go = element('button', 'act-go card');
  go.type = 'button';
  go.append(
    element('span', 'dot'),
    element('span', 'card-title', task.title),
    element('span', 'card-when'),
    element('span', 'card-line'),
  );
  go.addEventListener('click', () => enter(task));
  const tools = element('span', 'act-tools');
  tools.append(
    button('act-pin', 'Pin', () => {
      void desktop.pinTask(task.id, !entryOf(task)?.pinned);
    }),
    button('act-mute', 'Mute', () => {
      void desktop.muteTask(task.id, !entryOf(task)?.muted);
    }),
  );
  d.append(go, tools);
  return d;
}

export function refreshActivityCard(
  task: Task,
  entry: Entry | undefined,
  selected: boolean,
  processor: string,
  onRename: () => void,
) {
  task.card.dataset.state = entry?.state ?? 'starting';
  task.card.classList.toggle('front', selected);
  if (selected) task.card.setAttribute('aria-current', 'true');
  else task.card.removeAttribute('aria-current');
  const pin = task.card.querySelector<HTMLElement>('.act-pin')!,
    mute = task.card.querySelector<HTMLElement>('.act-mute')!;
  pin.setAttribute('aria-pressed', String(!!entry?.pinned));
  pin.title = entry?.pinned ? 'Unpin' : 'Keep this task at the top';
  mute.setAttribute('aria-pressed', String(!!entry?.muted));
  mute.title = entry?.muted ? 'Unmute' : 'Last in the list, no notifications, never the next';
  (task.card.querySelector('.act-go') as HTMLElement).title =
    `${task.where ?? ''}${task.where && task.harness ? ' · ' : ''}${processor}${entry?.job ? ` · a job: ${entry.job}` : ''}`;
  if (entry?.title && entry.title !== task.title) {
    task.title = entry.title;
    (task.card.querySelector('.card-title') as HTMLElement).textContent = entry.title;
    onRename();
  } // named by its first prompt
}

export function groupActivityCards(
  box: HTMLElement,
  order: Task[],
  hovering: boolean,
  entryOf: (task: Task) => Entry | undefined,
) {
  if (hovering && box.children.length) {
    for (const t of order) if (!t.card.isConnected) box.append(t.card);
    return;
  } // in place: a new task goes last
  box.replaceChildren();
  let group = '';
  for (const t of order) {
    const e = entryOf(t);
    const g = !e ? 'Starting' : e.pinned && !e.muted ? 'Pinned' : e.muted ? 'Muted' : e.group;
    if (g !== group) {
      group = g;
      box.append(element('h3', '', g));
    }
    box.append(t.card);
  }
}

export function cardAge(at: number) {
  const seconds = (Date.now() - at) / 1000;
  if (seconds < 45) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
