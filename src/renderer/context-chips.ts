import type { ShellState } from '@matapao/vindu/renderer';
import { desktop } from '../desktop-client.js';
import type { Picked, Pointed } from './desktop-api.js';
import { byId, chip } from './dom.js';
import type { Task } from './task-state.js';

/** Choose the most specific description available for the current selection. */
function describeSelection(item: Pointed): string {
  const group = item.group as Record<string, unknown> | undefined;
  if (group) {
    const rows = Array.isArray(item.rows_behind) ? ` (${item.rows_behind.length} rows)` : '';
    return `${Object.values(group)[0]}${rows}`;
  }
  const row = item.row as Record<string, unknown> | undefined;
  if (row) {
    return Object.entries(row)
      .filter(([key]) => key !== 'ref')
      .slice(0, 2)
      .map(([, value]) => String(value))
      .join(' · ');
  }
  if (item.element !== undefined || item.role)
    return `${item.role ?? 'element'}${item.name ? ` "${item.name}"` : ''}`;
  if (item.text !== undefined) return `"${String(item.text).replace(/\s+/g, ' ').slice(0, 40)}"`;
  if (item.value !== undefined) return String(item.value);
  if (item.field !== undefined) return `${item.field}: ${item.value}`;
  if (item.region) return 'a region';
  if (item.page !== undefined) return 'from the page';
  return String(item.panel ?? 'it');
}

function selectionLabel(item: Pointed, state?: ShellState): string {
  const title = state?.views.find((view) => view.name === item.view)?.title ?? item.view;
  return `${title}${item.title ? ` › ${item.title}` : ''}: ${describeSelection(item)}`;
}
/** What goes with the next message, as chips: the files attached; for a task, each thing pointed at and each pane in
 *  the chat. × takes it back. */
export function bindContextChips(current: () => Task | undefined, draftFiles: Picked[]) {
  async function chips() {
    const task = current(),
      list = task ? task.files : draftFiles;
    const box = byId('chips');
    const files = list.map((f, n) =>
      chip(f.name, () => {
        list.splice(n, 1);
        void chips();
      }),
    );
    if (!task?.live) {
      box.replaceChildren(...files);
      return;
    }
    const items = await desktop.selection(task.id).catch(() => [] as Pointed[]);
    if (current() !== task) return;
    const state = task.state,
      raw = (state?.pointing?.picked ?? []) as Pointed[];
    const pointed = items.map((x, i) => {
      const label = selectionLabel(x, state);
      const c = chip(
        label,
        () => desktop.event(task.id, { type: 'select', by: 'chips', items: raw.filter((_r, j) => j !== i) }),
        `Take back ${label}`,
      );
      c.classList.add('pointed');
      c.title = JSON.stringify(x);
      return c;
    });
    const panes = (state?.pointing?.attached ?? []).map((v) => {
      const c = chip(
        `${state?.views.find((x) => x.name === v)?.title ?? v}: in the chat`,
        () => desktop.event(task.id, { type: 'attach', view: v, on: false }),
        'Take it out of the chat',
      );
      c.classList.add('pane');
      c.title = 'Each message carries this pane, by reference';
      return c;
    });
    box.replaceChildren(...files, ...pointed, ...panes);
  }
  return chips;
}
