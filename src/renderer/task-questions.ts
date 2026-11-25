import type { Ask, Field } from '@matapao/vindu/server';
import { desktop } from '../desktop-client.js';
import { button, element } from './dom.js';
import type { Pending, Task } from './task-state.js';

/** The files each of a form's file fields holds as the person answers it: the host compares these ids as it takes the answer. */
function fileSelection(ask: Ask): Record<string, string[]> {
  return Object.fromEntries(Object.entries(ask.fields).filter(([, field]) => field.format === 'file')
    .map(([key]) => [key, ask.files?.[key]?.ids ?? []]));
}

export function renderQuestion(task: Task, view: string, p: Pending) {
  const k = p.ask,
    box = p.box;
  box.replaceChildren();
  const act = (name: string, context: Record<string, unknown>) =>
    desktop.event(task.id, { type: 'action', view, name, context: { ticket: k.ticket, ...context } });
  const send = (name: 'answer' | 'decline', context: Record<string, unknown>, picked: string) => {
    p.picked = picked;
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    act(name, name === 'answer' ? { ...context, fileSelection: fileSelection(k) } : context);
  };
  if (k.kind === 'permission') box.append(element('div', 'ask-op', k.op));
  box.append(element('div', 'ask-title', k.title));
  if (k.message) box.append(element('p', '', k.message));
  for (const d of k.details ?? []) {
    if (d.label === 'tool' && d.text === k.op) continue; // said above
    if (d.label) box.append(element('div', 'ask-label', d.label));
    box.append(element('pre', '', d.text));
  }
  if (k.link) box.append(element('div', 'ask-url', k.link));
  if (k.error) box.append(element('div', 'ask-error', k.error));
  const opts = element('div', 'ask-opts');
  if (k.choices?.length)
    k.choices.forEach((c, n) => opts.append(button('btn', c, () => send('answer', { choice: c, n }, c)))); // the harness's options, its order, its words
  else if (k.link)
    opts.append(
      button('btn', 'Open the page', () => send('answer', {}, 'Opened')),
      button('btn', 'Decline', () => send('decline', {}, 'Declined')),
    );
  else if (k.confirm && !Object.keys(k.fields).length)
    opts.append(
      button('btn', 'Allow', () => send('answer', {}, 'Allowed')),
      button('btn', 'Deny', () => send('decline', {}, 'Denied')),
    );
  else {
    const form = element('form'),
      read = Object.entries(k.fields).map(
        ([key, f]) =>
          [
            key,
            field(form, key, f, k.required.includes(key), {
              got: k.files?.[key]?.names,
              pick: () => act('pick_file', { field: key }),
            }),
          ] as const,
      );
    const go = element('button', 'btn main', 'Submit');
    go.type = 'submit';
    opts.append(
      go,
      button('btn', 'Decline', () => send('decline', {}, 'Declined')),
    );
    form.append(opts);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send(
        'answer',
        Object.fromEntries(read.filter(([, get]) => get).map(([key, get]) => [`f:${key}`, get!()])),
        'Answered',
      );
    });
    box.append(form);
    return;
  }
  box.append(opts);
}
/** One field of a form, in the schema's own words; returns how to read what the person put in (a file field: none, the
 *  files picked are the ask's own, kept as attachments). */
function field(
  form: HTMLElement,
  key: string,
  f: Field,
  required: boolean,
  file: { got?: string[]; pick: () => void },
): (() => unknown) | undefined {
  const wrap = element('div', 'ask-field'),
    name = `${f.title ?? key}${required ? '' : ' (optional)'}`;
  form.append(wrap);
  const check = (type: 'checkbox' | 'radio', label: string, value: string, on: boolean, hint?: string) => {
    const l = element('label', 'ask-check'),
      i = element('input');
    i.type = type;
    i.name = key;
    i.value = value;
    i.checked = on;
    l.append(i, label);
    if (hint) l.append(element('span', 'hint', hint));
    wrap.append(l);
    return i;
  };
  if (f.type === 'boolean' && !f.enum) {
    const i = check('checkbox', name, 'true', f.default === true, f.description);
    return () => i.checked;
  }
  wrap.append(element('span', 'ask-label', name));
  if (f.description) wrap.append(element('span', 'hint', f.description));
  if (f.format === 'file') {
    wrap.append(
      element('span', 'hint', file.got?.length ? file.got.join(', ') : 'No file yet'),
      button('btn', file.got?.length ? 'Choose again…' : 'Choose a file…', file.pick),
    );
    return undefined;
  }
  if (f.enum && (f.multi || f.enum.length <= 6)) {
    const picks = f.enum.map((v, n) =>
      check(
        f.multi ? 'checkbox' : 'radio',
        f.labels?.[n] ?? v,
        v,
        Array.isArray(f.default) ? f.default.includes(v) : f.default === v,
        f.hints?.[n],
      ),
    );
    return f.multi
      ? () => picks.filter((i) => i.checked).map((i) => i.value)
      : () => picks.find((i) => i.checked)?.value ?? '';
  }
  if (f.enum) {
    const s = element('select');
    if (f.default === undefined) s.append(new Option('', ''));
    f.enum.forEach((v, n) => s.append(new Option(f.labels?.[n] ?? v, v, false, f.default === v)));
    wrap.append(s);
    return () => s.value;
  }
  if (f.format === 'date-time') {
    // a day and a time, as Vindu's own form has them: YYYY-MM-DDTHH:MM
    const row = element('span', 'ask-when'),
      day = element('input'),
      time = element('input');
    day.type = 'date';
    time.type = 'time';
    const [d, tm] = String(f.default ?? '').split('T');
    if (d) day.value = d;
    if (tm) time.value = tm.slice(0, 5);
    const min = (f as { min?: unknown }).min;
    if (typeof min === 'string') day.min = min.split('T')[0];
    row.append(day, time);
    wrap.append(row);
    return () => (day.value ? `${day.value}${time.value ? `T${time.value}` : ''}` : '');
  }
  const i = f.long ? element('textarea') : element('input');
  if (i instanceof HTMLInputElement) {
    i.type = f.format === 'date' ? 'date' : f.format === 'time' ? 'time' : 'text';
    if (f.type !== 'string') i.inputMode = 'decimal';
  }
  if (f.default !== undefined) i.value = String(f.default);
  wrap.append(i);
  return () => i.value;
}
