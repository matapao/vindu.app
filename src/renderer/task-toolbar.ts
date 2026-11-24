import type { ShellCommand } from '@matapao/vindu/renderer';
import { desktop } from '../desktop-client.js';
import type { Capture, Opened, TemplateFile } from './desktop-api.js';
import { byId, button, element, errorMessage } from './dom.js';
import type { Task } from './task-state.js';

interface ToolbarActions {
  getTask(): Task | undefined;
  command(command: ShellCommand): void;
  goNext(): void;
  started(opened: Opened, from: Task): void;
  appendNote(task: Task, message: string, error?: boolean): void;
  appendAppNotice(message: string): void;
}

export function bindTaskToolbar({
  getTask,
  command,
  goNext,
  started,
  appendNote,
  appendAppNotice,
}: ToolbarActions) {
  const attempt = async (t: Task, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (err) {
      appendNote(t, errorMessage(err), true);
    }
  };
  /** Static (a template's) or dynamic (the model's), and what the person can do about it. */
  function drawMode(t: Task) {
    if (getTask() !== t) return;
    const m = t.mode ?? { kind: 'dynamic' };
    byId('mode').textContent =
      m.kind === 'static' ? `Static view: ${m.template}` : 'The model composes the view';
    byId('arrange').hidden = byId('dynamic').hidden = m.kind !== 'static';
  }
  const refreshMode = (t: Task) =>
    t.live
      ? desktop.mode(t.id).then(
          (m) => {
            t.mode = m;
            drawMode(t);
          },
          () => undefined,
        )
      : Promise.resolve();
  /** The templates the person keeps, to start a task with. */
  function templates(list: TemplateFile[]) {
    const s = byId<HTMLSelectElement>('template');
    const was = s.value;
    for (const o of [...s.options].slice(1)) o.remove();
    for (const t of list) {
      const o = new Option(`View: ${t.name}`, t.file);
      o.title = t.problem ?? t.about ?? '';
      o.disabled = !!t.problem;
      s.append(o);
    }
    s.value = [...s.options].some((o) => o.value === was) ? was : '';
  }
  byId('term').addEventListener('click', () => {
    const t = getTask();
    if (t) void attempt(t, () => desktop.ptyNew(t.id));
  });
  byId('page').addEventListener('click', () => {
    const t = getTask();
    if (t) void attempt(t, () => desktop.browserNew(t.id));
  });
  byId('branch').addEventListener('click', () => {
    const t = getTask();
    if (t) void attempt(t, async () => started(await desktop.branch(t.id), t));
  });
  byId('export').addEventListener('click', () => {
    const t = getTask();
    if (t) void attempt(t, () => desktop.exportTask(t.id));
  });
  byId('reminders').addEventListener('click', () => {
    const t = getTask();
    if (t) void attempt(t, () => desktop.reminders(t.id));
  });
  byId('connector-keys').addEventListener('click', () => {
    void desktop.keys().catch((err) => appendAppNotice(errorMessage(err)));
  }); // a tab of its own
  // the window's own keys, as its menu had them where a browser leaves them free: a pane maximized (⌘⇧↩) or collapsed into
  // the shelf (⌘⇧M), the next task that needs the person (⌘.), the task exported (⌘⇧E); Esc and F6 the views take themselves
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase(),
      c: ShellCommand | undefined =
        e.shiftKey && k === 'enter'
          ? { type: 'maximize' }
          : e.shiftKey && k === 'm'
            ? { type: 'collapse' }
            : undefined;
    if (c) {
      e.preventDefault();
      command(c);
    } else if (!e.shiftKey && k === '.') {
      e.preventDefault();
      goNext();
    } else if (e.shiftKey && k === 'e' && getTask()) {
      e.preventDefault();
      byId('export').click();
    }
  });
  byId('pin').addEventListener('click', () => {
    byId('pinning').hidden = !byId('pinning').hidden;
    if (!byId('pinning').hidden) byId<HTMLInputElement>('pin-name').focus();
  });
  const pinView = async () => {
    const t = getTask(),
      name = byId<HTMLInputElement>('pin-name').value.trim();
    if (!t || !name) return;
    await attempt(t, async () => {
      const r = await desktop.pin(t.id, name);
      templates(r.templates);
      appendNote(t, `kept the view as the template "${name}" (${r.file})`);
      for (const n of r.notes) appendNote(t, n);
    });
    byId('pinning').hidden = true;
    byId<HTMLInputElement>('pin-name').value = '';
  };
  byId('pin-save').addEventListener('click', () => {
    void pinView();
  });
  byId('pin-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void pinView();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      byId('pinning').hidden = true;
    }
  });
  byId('arrange').addEventListener('click', () => {
    const t = getTask();
    if (t)
      void attempt(t, async () => {
        const r = await desktop.arrangement(t.id);
        if (r) {
          templates(r.templates);
          appendNote(t, `kept your arrangement in ${r.file}`);
        }
      });
  });
  byId('dynamic').addEventListener('click', () => {
    const t = getTask();
    if (t)
      void attempt(t, async () => {
        await desktop.letModelChange(t.id);
        await refreshMode(t);
      });
  });
  byId('phone').addEventListener('click', () => {
    void desktop.phone().then(
      (r) => {
        byId('phone').setAttribute('aria-pressed', String(!!r));
        const text = r
          ? `the phone window is on: open ${r.url} on your phone${r.lan ? ' (it is on your local network)' : ' (this computer only: set phone.lan in your settings for the local network)'}`
          : 'the phone window is off';
        const current = getTask();
        if (current) appendNote(current, text);
        else appendAppNotice(text);
      },
      (err) => {
        const current = getTask();
        if (current) appendNote(current, errorMessage(err), true);
        else appendAppNotice(errorMessage(err));
      },
    );
  });
  desktop.onMenu((what) => {
    if (what === 'branch') byId('branch').click();
    if (what === 'next') goNext();
  });

  let captures: Capture[] = []; // what slots of the person's wait for: a file from here, or the phone's camera or pad
  /** What slots of the open task's wait for: a file from here (or the phone's camera or pad). */
  function drawCaptures() {
    const box = byId('captures');
    box.replaceChildren();
    for (const c of captures.filter((x) => x.task === getTask()?.id)) {
      const p = element('div', 'capture');
      p.append(element('span', '', `${c.about ?? c.slot} (${c.kind})`));
      p.append(
        button('btn', c.kind === 'photo' ? 'Choose photos…' : 'Choose a file…', () => {
          void desktop.captureFile(c.id).catch((err) => {
            const current = getTask();
            if (current) appendNote(current, errorMessage(err), true);
          });
        }),
        button('btn', 'Not now', () => {
          void desktop.captureSkip(c.id);
        }),
      );
      box.append(p);
    }
  }
  desktop.onCaptures((list) => {
    captures = list;
    drawCaptures();
  });
  return { drawMode, refreshMode, templates, drawCaptures };
}
