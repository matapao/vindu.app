import { mountShell, type ShellAction } from '@matapao/vindu/renderer';
import { terminalPane, type TerminalIO } from '@matapao/vindu/renderer/terminal';
import { browserPane, type BrowserIO } from '@matapao/vindu/renderer/browser';
import { desktop } from '../desktop-client.js';
import type { Off } from './desktop-api.js';
import { byId, element, errorMessage } from './dom.js';
import type { Task } from './task-state.js';

type ReportError = (message: string) => void;
/** Each terminal or page has its own end, in its title bar: collapsing its pane only puts it in the shelf, as any pane. */
const POWER =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v5M4.7 4.6a4.7 4.7 0 1 0 6.6 0"/></svg>';
const endings = (taskOwner: Task, reportError: ReportError): ShellAction[] =>
  (
    [
      ['terminal', 'End this terminal (its shell stops)'],
      ['browser', 'Close this page'],
    ] as const
  ).map(([kind, title]) => ({
    id: `end-${kind}`,
    title,
    icon: POWER,
    where: 'pane' as const,
    when: (v: { kind?: string }) => v.kind === kind,
    run: ({ view }: { view: { name: string } | null }) => {
      if (view) void desktop.viewEnd(taskOwner.id, view.name).catch((e) => reportError(errorMessage(e)));
    },
  }));
/** A terminal's bytes: what the main process sends for this task and terminal; all it shows so far comes first. */
const terminalIO = (taskId: string): TerminalIO => {
  const subscriptions = new Map<string, Off>();
  return {
    attach: async (name, onData) => {
      subscriptions.get(name)?.();
      subscriptions.set(
        name,
        desktop.onPty((eventTaskId, paneName, data) => {
          if (eventTaskId === taskId && paneName === name) onData(data);
        }),
      );
      return desktop.ptyAttach(taskId, name);
    },
    detach: (name) => {
      subscriptions.get(name)?.();
      subscriptions.delete(name);
      desktop.ptyDetach(taskId, name);
    },
    input: (name, d) => desktop.ptyInput(taskId, name, d),
    resize: (name, c, r) => desktop.ptyResize(taskId, name, c, r),
    share: (name, on) => desktop.viewShare(taskId, name, on),
    onExit: (name, cb) =>
      desktop.onPtyExit((eventTaskId, paneName, code) => {
        if (eventTaskId === taskId && paneName === name) cb(code);
      }),
  };
};
/** A page's bar, where its pane is, its pictures, and what the person does in it. */
const browserIO = (taskOwner: Task, reportError: ReportError): BrowserIO => ({
  state: (name) => desktop.browserState(taskOwner.id, name),
  onState: (name, cb) =>
    desktop.onBrowser((x, p, s) => {
      if (x === taskOwner.id && p === name) cb(s);
    }),
  navigate: (name, url) => desktop.browserNavigate(taskOwner.id, name, url),
  go: (name, to) => desktop.browserGo(taskOwner.id, name, to),
  share: (name, on) => desktop.viewShare(taskOwner.id, name, on),
  place: (name, box) => desktop.viewBox(taskOwner.id, name, box),
  frames: (name, cb) =>
    desktop.onFrame((x, p, f) => {
      if (x === taskOwner.id && p === name) cb(f);
    }),
  input: (name, e) => desktop.browserInput(taskOwner.id, name, e),
  point: (name) => desktop.browserPoint(taskOwner.id, name),
  stopPointing: (name) => {
    void desktop.browserStopPointing(taskOwner.id, name);
  },
  fail: reportError,
});

export function mountTaskPanes(task: Task, visible: boolean, reportError: ReportError) {
  const el = element('section', 'task');
  el.dataset.task = task.id;
  el.hidden = !visible;
  byId('views').append(el);
  const shell = mountShell(el, {
    onEvent: (event) => desktop.event(task.id, event),
    panes: {
      terminal: terminalPane(terminalIO(task.id)),
      browser: browserPane(browserIO(task, reportError)),
    },
    actions: endings(task, reportError),
  });
  return { el, shell };
}

/** Keep Activity and task panes reachable in a narrow window, without opening the keyboard. */
export function bindPaneNavigation(currentTask: () => Task | undefined) {
  const narrow = matchMedia('(max-width: 700px)');
  const viewCount = (t: Task | undefined) => (t?.views ? (t.state?.views.length ?? 0) : 0);
  /** Activity (the list, or a task's thread), or the views of the task open, once it has some. */
  function paneTo(pane: 'side' | 'views') {
    const open = currentTask();
    document.body.dataset.pane = pane === 'views' && viewCount(open) ? 'views' : 'side';
    if (open && document.body.dataset.pane === 'views') open.seen = viewCount(open);
    drawToViews();
  }
  /** Views, in the open task's head, once it has some; marked while it has more than the person last looked at. */
  function drawToViews() {
    const open = currentTask();
    const n = viewCount(open),
      b = byId('to-views');
    b.hidden = !n;
    byId('views-title').textContent = open?.title ?? '';
    if (document.body.dataset.pane === 'views' && !n) document.body.dataset.pane = 'side';
    if (open && document.body.dataset.pane === 'views') open.seen = n;
    if (n > (open?.seen ?? 0)) b.dataset.fresh = 'true';
    else delete b.dataset.fresh;
  }
  byId('to-views').addEventListener('click', () => paneTo('views'));
  byId('views-back').addEventListener('click', () => paneTo('side'));
  narrow.addEventListener('change', () => paneTo(document.body.dataset.pane === 'views' ? 'views' : 'side'));
  return { narrow, paneTo, drawToViews };
}
