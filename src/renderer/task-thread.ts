import { desktop } from '../desktop-client.js';
import type { ThreadItem } from '../task-checkpoint.js';
import type { Shown } from '@matapao/vindu/server';
import type { Act } from '../work.js';
import { byId, chip, element, firstLine } from './dom.js';
import { renderQuestion } from './task-questions.js';
import { renderMarkdown } from './thread-markdown.js';
import type { Task } from './task-state.js';

export function createTaskThread(
  thread: HTMLElement,
  isActive: (task: Task) => boolean,
  refreshTask: (task: Task) => void,
) {
  const near = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  /** Add to a task's thread, keeping its end in sight if the person is reading there. What follows the harness's text starts a new reply. */
  function add(task: Task, el: HTMLElement) {
    task.reply = undefined;
    const stick = isActive(task) && near();
    task.turns.append(el);
    if (stick) thread.scrollTop = thread.scrollHeight;
  }
  function appendUserMessage(task: Task, text: string, files: { name: string }[]) {
    if (text) add(task, element('div', 'you', text));
    if (files.length) {
      const f = element('div', 'files');
      f.append(...files.map((x) => chip(x.name)));
      add(task, f);
    }
  }
  function appendNote(task: Task, text: string, bad = false) {
    add(task, element('div', bad ? 'note bad' : 'note', text));
  }
  /** What the app told the model with the person's prompt: one quiet line under it, the exact words a click away. */
  function appendContextMessage(task: Task, said: string) {
    const d = element('details', 'told');
    const head = element('summary');
    head.append(
      element('span', 'told-kind', 'with it'),
      element('span', 'told-title', 'what the window told the model'),
    );
    d.append(head, element('pre', '', said));
    add(task, d);
  }
  /** A note for no task (a connector that could not be read, the phone window): above the list. */
  function appendAppNotice(text: string) {
    const n = byId('appnotes');
    n.prepend(element('div', 'note', text));
    while (n.children.length > 4) n.lastElementChild!.remove();
  }
  function appendReply(task: Task, chunk: string) {
    if (!task.reply) {
      const box = element('div', 'said');
      add(task, box);
      task.reply = { box, text: '' };
    }
    const r = task.reply;
    r.text += chunk;
    task.last = firstLine(r.text);
    if (task.status === 'working') task.doing = 'Writing';
    draw(r, task);
    refreshTask(task);
  }
  const drawing = new WeakSet<object>();
  function draw(r: { box: HTMLElement; text: string }, task: Task) {
    // once a frame, however fast the text comes
    if (drawing.has(r)) return;
    drawing.add(r);
    requestAnimationFrame(() => {
      drawing.delete(r);
      const stick = isActive(task) && near();
      r.box.replaceChildren(renderMarkdown(r.text));
      if (stick) thread.scrollTop = thread.scrollHeight;
    });
  }

  const KIND: Record<string, string> = {
    read: 'read',
    edit: 'edit',
    delete: 'delete',
    move: 'move',
    search: 'search',
    execute: 'run',
    think: 'think',
    fetch: 'fetch',
    switch_mode: 'mode',
  };
  const named = (title: string) => title.replace(/^mcp__(.+?)__/, '$1 · '); // an MCP tool: its server, then its name
  /** What the harness did, as one quiet line in its thread (a click shows its input and output); its plan; its thinking. */
  function renderAction(task: Task, a: Act) {
    if (a.type === 'thinking') {
      if (task.status === 'working' && task.doing !== 'Thinking') {
        task.doing = 'Thinking';
        refreshTask(task);
      }
      return;
    }
    if (a.type === 'plan') {
      if (!task.plan) {
        task.plan = element('div', 'plan');
        add(task, task.plan);
      }
      task.plan.replaceChildren(
        ...a.entries.map((e) => {
          const d = element('div', '', e.content);
          d.dataset.status = e.status;
          return d;
        }),
      );
      const now = a.entries.find((e) => e.status === 'in_progress');
      if (now && task.status === 'working') {
        task.doing = now.content;
        refreshTask(task);
      }
      return;
    }
    let row = task.calls.get(a.id);
    if (!row) {
      row = element('details', 'call');
      const head = element('summary');
      head.append(element('span', 'call-kind', 'tool'), element('span', 'call-title'));
      row.append(head, element('pre', 'call-in'), element('pre', 'call-out'));
      task.calls.set(a.id, row);
      add(task, row);
    }
    const part = (cls: string) => row.querySelector(`.${cls}`) as HTMLElement;
    if (a.kind) part('call-kind').textContent = KIND[a.kind] ?? a.kind;
    if (a.title) {
      part('call-title').textContent = named(a.title);
      row.title = a.title;
    }
    if (a.status) row.dataset.status = a.status;
    if (a.input) part('call-in').textContent = a.input;
    if (a.output) part('call-out').textContent = a.output;
    if ((a.status === 'pending' || a.status === 'in_progress') && task.status === 'working') {
      task.doing = part('call-title').textContent ?? '';
      refreshTask(task);
    }
  }

  /** What the harness asks, in its thread, as vindu has it. */
  function showQuestion(task: Task, v: Shown) {
    let p = task.asks.get(v.name);
    if (!p) {
      p = { ask: v.ask!, box: element('div', 'ask') };
      p.box.dataset.view = v.name;
      task.asks.set(v.name, p);
      add(task, p.box);
    }
    p.ask = v.ask!;
    renderQuestion(task, v.name, p);
    refreshTask(task); // drawn again when vindu sends it back with what to fix, or with the files picked
  }
  /** An ask has left: answered here, declined, or no longer waited on. It stays in the thread as one quiet line. */
  function dismissQuestion(task: Task, view: string, action: string) {
    const p = task.asks.get(view);
    if (!p) return;
    task.asks.delete(view);
    p.box.className = 'ask done';
    p.box.replaceChildren(
      element('span', 'ask-title', p.ask.title),
      element(
        'span',
        '',
        action === 'accept'
          ? (p.picked ?? 'Answered')
          : action === 'decline'
            ? (p.picked ?? 'Declined')
            : 'No longer asked',
      ),
    );
    refreshTask(task);
  }

  function bindEvents(taskForId: (id: string) => Task | undefined, windowId: string) {
    desktop.onUser((id, item, origin) => {
      const t = taskForId(id);
      if (t && origin !== windowId) appendUserMessage(t, item.text, item.files);
    });
    desktop.onText((id, text) => {
      const t = taskForId(id);
      if (t) appendReply(t, text);
    });
    desktop.onNote((id, n) => {
      const t = taskForId(id);
      if (t) appendNote(t, n);
    });
    desktop.onTold((id, said) => {
      const t = taskForId(id);
      if (t) appendContextMessage(t, said);
    });
    desktop.onAct((id, a) => {
      const t = taskForId(id);
      if (t) renderAction(t, a);
    });
    desktop.onAskGone((id, view, action) => {
      const t = taskForId(id);
      if (t) dismissQuestion(t, view, action);
    });
  }

  function restore(t: Task, history: ThreadItem[]) {
    t.turns.replaceChildren();
    t.reply = undefined;
    t.asks.clear();
    t.calls.clear();
    t.plan = undefined;
    for (const msg of history) {
      switch (msg.kind) {
        case 'user':
          appendUserMessage(t, msg.text, msg.files);
          break;
        case 'text':
          appendReply(t, msg.text);
          break;
        case 'told':
          appendContextMessage(t, msg.text);
          break;
        case 'act':
          renderAction(t, msg.event);
          break;
        case 'note':
        case 'error':
          appendNote(t, msg.text, msg.kind === 'error');
          break;
      }
    }
  }
  return {
    bindEvents,
    restore,
    appendUserMessage,
    appendNote,
    appendContextMessage,
    appendAppNotice,
    appendReply,
    renderAction,
    showQuestion,
    dismissQuestion,
  };
}

export type TaskThread = ReturnType<typeof createTaskThread>;
