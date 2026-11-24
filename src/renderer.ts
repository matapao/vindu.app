// Connect the shared workspace to this window's Activity, task panes and composer.
import { createTaskOptions } from './renderer/task-options.js';
import { createTaskTurns } from './renderer/task-turns.js';
import { bindContextChips } from './renderer/context-chips.js';
import { bindTaskToolbar } from './renderer/task-toolbar.js';
import { bindSettings } from './renderer/settings-view.js';
import {
  createActivityCard,
  refreshActivityCard,
  cardAge,
  cardStatus,
  groupActivityCards,
} from './renderer/activity-cards.js';
import { mountWorkspace, useTheme, type ShellHandle, type ShellState } from '@matapao/vindu/renderer';
import type { Shown } from '@matapao/vindu/server';
import { ago as since } from './activity.js';
import { desktop } from './desktop-client.js';
import type { Arranged, Opened, Picked } from './renderer/desktop-api.js';
import { byId, button, element, errorMessage, firstLine, lastPart } from './renderer/dom.js';
import { bindPaneNavigation, mountTaskPanes } from './renderer/task-panes.js';
import { createTaskThread } from './renderer/task-thread.js';
import type { Task } from './renderer/task-state.js';

const tasks = new Map<string, Task>(),
  closed = new Set<string>();
let made = 0;
let activeTask: Task | undefined; // the thread shown in Activity, if one is
let visibleTask: Task | undefined; // the task whose views are in the middle
const fresh = { draft: '', files: [] as Picked[] }; // the prompt for a new task
let activity: Arranged = { entries: [] };
const promptBox = byId<HTMLTextAreaElement>('prompt'),
  thread = byId('thread');

const messages = createTaskThread(thread, (task) => activeTask === task, refreshTaskStatus);
const { appendNote, appendAppNotice, appendUserMessage, showQuestion } = messages;
const options = createTaskOptions(() => activeTask, refreshSendButton, messages);
const turns = createTaskTurns(options.selectedServers, messages, refreshTaskStatus);
useTheme();
// Adopt the page's controls so the installed app and an embedded workspace share
// navigation and input behavior. Desktop adds its own task actions and connectors.
const workspace = mountWorkspace(document.body, {
  styles: false,
  elements: {
    views: byId('views'),
    sidebar: {
      element: byId('side'),
      header: byId('head'),
      back: byId<HTMLButtonElement>('back'),
      title: byId('title'),
      list: byId('list'),
      thread,
    },
    composer: {
      element: byId<HTMLFormElement>('composer'),
      input: promptBox,
      context: byId('chips'),
      tools: byId('tools'),
      send: byId<HTMLButtonElement>('send'),
    },
  },
  canSend: canSendPrompt,
  onInput: (value) => {
    (activeTask ?? fresh).draft = value;
  },
  onSend: () => {
    void send();
  },
  onBack: leave,
});

function viewsOf(task: Task): ShellHandle {
  if (!task.views) {
    task.views = mountTaskPanes(task, visibleTask === task, (message) => appendNote(task, message, true));
    if (visibleTask === task) byId('empty').hidden = true;
  }
  drawToViews();
  return task.views.shell;
}
const { narrow, paneTo, drawToViews } = bindPaneNavigation(() => activeTask);

function showViews(task: Task | undefined) {
  const was = visibleTask;
  visibleTask = task;
  if (task) sessionStorage.setItem('vindu.views', task.id);
  else sessionStorage.removeItem('vindu.views');
  for (const x of tasks.values()) if (x.views) x.views.el.hidden = x !== task;
  byId('empty').hidden = !!task?.views;
  if (task && task !== was) {
    desktop.shown(task.id);
    drawActivity();
  } // the main process shows only this task's native views (its pages)
}

// ---- Activity: a line per task, by what each needs from the person

const entryOf = (task: Task) => activity.entries.find((e) => e.id === task.id);
function refreshTaskStatus(task: Task) {
  const [status, line] = cardStatus(task, entryOf(task));
  task.card.dataset.status = status;
  (task.card.querySelector('.card-line') as HTMLElement).textContent = line;
  (task.card.querySelector('.card-when') as HTMLElement).textContent = cardAge(task.at);
  if (activeTask !== task) return;
  byId('doing').hidden = status !== 'starting' && status !== 'working';
  byId('doing').dataset.status = status;
  byId('doing-text').textContent = line;
  refreshSendButton();
}
// while the pointer is in the list, its entries keep their places (their words change in place): nothing moves under the hand
let hovering = false;
byId('tasks').addEventListener('mouseenter', () => {
  hovering = true;
});
byId('tasks').addEventListener('mouseleave', () => {
  hovering = false;
  drawActivity();
});
function drawActivity() {
  const box = byId('tasks'),
    { entries, next } = activity;
  const known = new Set(entries.map((e) => e.id));
  const order = [
    ...[...tasks.values()].filter((task) => !known.has(task.id)).reverse(),
    ...entries.flatMap((e) => tasks.get(e.id) ?? []),
  ]; // a task still starting comes first
  for (const task of tasks.values()) {
    const e = entryOf(task);
    refreshActivityCard(task, e, task === visibleTask, options.processorName(task.harness), () => {
      if (activeTask === task) refreshHeading(task);
    });
    refreshTaskStatus(task);
  }
  const n = byId('next');
  n.replaceChildren();
  n.hidden = !next;
  if (next) {
    const b = button('tool', 'Next', () => goNext());
    b.id = 'go-next';
    b.title = 'Go to the next task that needs you (⌘.)';
    n.append(b, element('span', '', `${next.title}: ${next.reason} · ${since(next.since)}`));
  }
  groupActivityCards(box, order, hovering, entryOf);
}
const goNext = () => {
  const task = activity.next && tasks.get(activity.next.id);
  if (task) enter(task);
};
function refreshHeading(task: Task | undefined) {
  workspace.showThread(task?.title ?? null);
  byId('where').textContent = task
    ? [options.processorName(task.harness), task.where].filter(Boolean).join(' · ')
    : '';
  byId('where').title = task?.where ?? '';
  byId('where').hidden = !task;
  byId('reveal').hidden = !task?.live;
  byId('opens').hidden = !task?.live;
  byId('viewbar').hidden = !task?.live;
  drawToViews();
}
/** Into a task's thread: Activity shows it, and the task comes in front: the middle shows its views. */
function enter(task: Task) {
  sessionStorage.setItem('vindu.thread', task.id);
  if (activeTask && activeTask !== task) activeTask.draft = promptBox.value;
  activeTask = task;
  thread.replaceChildren(task.turns);
  if (narrow.matches) paneTo('side'); // a phone: its thread first, its views a tap away
  refreshHeading(task);
  refreshComposer();
  showViews(task);
  refreshTaskStatus(task);
  drawActivity();
  drawCaptures();
  drawMode(task);
  void refreshMode(task);
  thread.scrollTop = thread.scrollHeight;
  if (!narrow.matches) promptBox.focus(); // a phone's keyboard comes up when the person taps in
}
function leave() {
  sessionStorage.removeItem('vindu.thread');
  if (activeTask) activeTask.draft = promptBox.value;
  activeTask = undefined;
  thread.replaceChildren();
  byId('doing').hidden = true;
  paneTo('side');
  refreshHeading(undefined);
  refreshComposer();
  drawCaptures();
  if (!narrow.matches) promptBox.focus();
}

// ---- the thread's bar: terminals and pages, the view (static or dynamic, kept as a template), a new task from it, export

bindSettings();
const { drawMode, refreshMode, templates, drawCaptures } = bindTaskToolbar({
  getTask: () => activeTask,
  command: (command) => visibleTask?.views?.shell.command(command),
  goNext,
  started,
  appendNote,
  appendAppNotice,
});

// ---- the prompt: a new task's in Activity, or the open thread's

const chips = bindContextChips(() => activeTask, fresh.files);
/** Send, or stop: a thread whose turn is running is stopped, not sent to. A new task may start with no prompt when the
 *  person picked its folder or its view. */
function canSendPrompt(value: string) {
  if (activeTask)
    return (
      !!value.trim() &&
      activeTask.live &&
      !!activeTask.harness &&
      activeTask.status !== 'starting' &&
      activeTask.status !== 'working'
    );
  return value.trim()
    ? !!byId<HTMLSelectElement>('harness').value
    : options.hasFolder() || !!byId<HTMLSelectElement>('template').value;
}
function refreshSendButton() {
  const task = activeTask,
    busy = !!task && (task.status === 'starting' || task.status === 'working');
  byId('send').hidden = busy;
  byId('stop').hidden = !busy;
  workspace.composer?.refresh();
}
function promptPlaceholder(task: Task | undefined) {
  if (!task) return 'Start a task…';
  if (!task.harness) return 'No processor connected';
  if (!task.live && task.status !== 'starting') return 'This task did not start';
  return matchMedia('(pointer: fine)').matches
    ? 'Reply… (Alt-click or Alt-drag anything in a pane to point at it)'
    : 'Reply…';
}

function refreshComposer() {
  const task = activeTask;
  promptBox.placeholder = promptPlaceholder(task);
  promptBox.value = task ? task.draft : fresh.draft;
  byId('fresh').hidden = !!task;
  byId('settings').hidden = true;
  options.settings(task);
  void chips();
  refreshSendButton();
}

async function send() {
  const text = promptBox.value.trim(),
    task = activeTask;
  if (!canSendPrompt(text)) return;
  const files = (task ? task.files : fresh.files).splice(0);
  if (task) task.draft = '';
  else fresh.draft = '';
  promptBox.value = '';
  void chips();
  refreshSendButton();
  if (task) await turns.send(task, text, files);
  else await start(text, files);
}
/** A task the window shows at once: its entry, its thread, its shell to come. */
function newTask(id: string, title: string, harness: string): Task {
  const task: Task = {
    id,
    title,
    harness,
    status: 'starting',
    doing: '',
    last: '',
    at: Date.now(),
    live: false,
    switches: [],
    asks: new Map(),
    calls: new Map(),
    card: element('div'),
    turns: element('div', 'turns'),
    draft: '',
    files: [],
    titles: new Map(),
  };
  task.card = createActivityCard(task, enter, entryOf);
  tasks.set(id, task);
  drawActivity();
  return task;
}
/** A new task: it shows in Activity at once, it opens its UI session, then passes any prompt to the connected processor. */
async function start(text: string, files: Picked[]) {
  const id = `t${Date.now().toString(36)}${++made}`,
    harness = byId<HTMLSelectElement>('harness').value;
  const picked = byId<HTMLSelectElement>('template'),
    template = picked.value || undefined;
  const where = options.takeFolder();
  const title =
    firstLine(text) ||
    (where ? lastPart(where) : (picked.selectedOptions[0]?.textContent?.replace(/^View: /, '') ?? 'A task'));
  const task = newTask(id, title, harness);
  appendUserMessage(task, text, files);
  if (text) showViews(task);
  else enter(task); // the person started it: it comes in front
  try {
    const r = await desktop.create({
      id,
      harness,
      folder: where,
      title: text || title,
      ...options.connections(),
      ...(template ? { template } : {}),
    });
    opened(task, r);
  } catch (err) {
    task.status = 'failed';
    task.doing = errorMessage(err);
    appendNote(task, task.doing, true);
    refreshTaskStatus(task);
    if (activeTask === task) refreshComposer();
    return;
  }
  if (text) await turns.send(task, text, files, false);
  else {
    task.status = 'idle';
    task.at = Date.now();
    refreshTaskStatus(task);
    if (activeTask === task) refreshComposer();
  }
}
/** The main process has the task: where it works, its switches, its view, and its notes. */
function opened(task: Task, r: Opened) {
  task.live = true;
  task.where = r.where;
  task.switches = r.switches;
  task.mode = r.mode;
  for (const n of r.notes) appendNote(task, n);
  if (activeTask === task) {
    refreshHeading(task);
    refreshComposer();
    drawMode(task);
  }
  drawActivity();
}
/** A task the main process opened from another (a new task from its view): it comes in front, as the person asked. */
function started(r: Opened, from: Task) {
  const task = tasks.get(r.id) ?? newTask(r.id, `${from.title}, from its view`, from.harness);
  opened(task, r);
  task.status = 'idle';
  enter(task);
}

const attach = (list: Picked[]) => {
  (activeTask ? activeTask.files : fresh.files).push(...list);
  void chips();
  promptBox.focus();
};
byId('attach').addEventListener('click', async () => attach(await desktop.pickFiles()));
desktop.onAppNote((n) => {
  if (activeTask) appendNote(activeTask, n);
  else appendAppNotice(n);
});
byId('stop').addEventListener('click', () => {
  if (activeTask) void desktop.cancel(activeTask.id);
}); // what the harness waits on is answered cancelled first
byId('reveal').addEventListener('click', () => {
  if (activeTask) void desktop.reveal(activeTask.id);
});

/** A task of the main process's that this window did not start (a new task from a view, a job a view's hook started):
 *  known from its first word, with what its entry in the activity says. One that has closed stays closed. */
const findOrCreateTask = (id: string): Task | undefined => {
  let task = tasks.get(id);
  if (!task && !closed.has(id)) {
    const e = activity.entries.find((x) => x.id === id);
    task = newTask(id, e?.title ?? 'A task', e?.harness ?? '');
    task.live = true;
    task.status = e?.state === 'running' ? 'working' : 'idle';
    task.where = e?.folder;
  }
  return task;
};
/** A task that has closed: its entry, its thread and its views leave the window. */
function removeTask(task: Task) {
  closed.add(task.id);
  tasks.delete(task.id);
  task.card.remove();
  if (activeTask === task) leave();
  if (visibleTask === task) showViews(undefined);
  task.views?.shell.destroy();
  task.views?.el.remove();
}
function drawView(task: Task, v: Shown) {
  if (v.ask) showQuestion(task, v);
  else viewsOf(task).view(v);
}
desktop.onView((id, v) => {
  const task = findOrCreateTask(id);
  if (task) drawView(task, v);
});
function drawShell(task: Task, st: ShellState) {
  task.titles = new Map(st.views.map((v) => [v.name, v.title ?? v.name]));
  task.state = st;
  viewsOf(task).state(st);
  const p = JSON.stringify(st.pointing ?? null);
  if (task.pointedAt !== p) {
    task.pointedAt = p;
    if (activeTask === task) void chips();
  }
  if (activeTask === task) void refreshMode(task); // a template started, or let go
}
desktop.onShell((id, st) => {
  const task = findOrCreateTask(id);
  if (task) drawShell(task, st);
});
messages.bindEvents(findOrCreateTask, turns.windowId);
desktop.onSent((id) => {
  const task = findOrCreateTask(id);
  if (!task) return;
  if (task.status === 'starting' || task.status === 'working') task.wake = true;
  else void turns.sendPending(task);
});
desktop.onApp((id, view, panel, msg) => findOrCreateTask(id)?.views?.shell.app(view, panel, msg)); // the UI server's answers to an app
desktop.onSwitches((id, list) => {
  const task = findOrCreateTask(id);
  if (!task) return;
  task.switches = list;
  if (activeTask === task) {
    const keep = !byId('settings').hidden;
    options.settings(task);
    byId('settings').hidden = !keep;
  }
});
desktop.onSuggest((id, text) => {
  const task = findOrCreateTask(id);
  if (!task) return;
  task.draft = text;
  if (activeTask === task) {
    promptBox.value = text;
    refreshSendButton();
  }
}); // the person sends it, or not
desktop.onCommand((c) => {
  visibleTask?.views?.shell.command(c);
}); // the menu's View entries, on the views in the middle
function showActivity(a: Arranged) {
  activity = a;
  for (const e of a.entries) {
    const task = findOrCreateTask(e.id);
    if (task) task.listed = true;
  } // a job a view's hook started is known from here
  for (const e of a.entries) {
    const task = tasks.get(e.id);
    if (!task || task.localTurn) continue;
    if (e.state === 'running') task.status = 'working';
    else if (task.status === 'working' && !task.asks.size) task.status = 'idle';
  }
  for (const task of [...tasks.values()])
    if (task.listed && task.live && !a.entries.some((e) => e.id === task.id)) removeTask(task); // closed; one that failed to start keeps its entry, with why
  drawActivity();
}
desktop.onActivity(showActivity);
desktop.onFront((id) => {
  const task = findOrCreateTask(id);
  if (task) enter(task);
}); // the person asked for it elsewhere (its notification)
desktop.onFiles(attach);
options.bind();
void desktop.templates().then(templates, (err) => appendAppNotice(errorMessage(err)));
void desktop.restoreActivity().then(
  (saved) => {
    const lastThread = sessionStorage.getItem('vindu.thread'),
      lastView = sessionStorage.getItem('vindu.views');
    for (const reason of saved.unavailable) appendAppNotice(reason);
    showActivity(saved.activity);
    for (const data of saved.tasks) {
      const task = findOrCreateTask(data.id);
      if (!task) continue;
      task.where = data.where;
      task.mode = data.mode;
      task.switches = data.switches;
      messages.restore(task, data.thread);
      for (const view of data.views) drawView(task, view);
      if (data.state) drawShell(task, data.state);
    }
    const task = lastThread && tasks.get(lastThread),
      middle = lastView && tasks.get(lastView);
    if (task) enter(task);
    else if (middle) showViews(middle);
  },
  (err) => appendAppNotice(errorMessage(err)),
);
refreshComposer();
refreshHeading(undefined);
setInterval(() => {
  for (const task of tasks.values())
    (task.card.querySelector('.card-when') as HTMLElement).textContent = cardAge(task.at);
  drawActivity();
}, 30_000);
