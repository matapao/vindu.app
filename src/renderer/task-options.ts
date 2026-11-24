import type { Switch } from '../task.js';
import { desktop } from '../desktop-client.js';
import type { Connector } from './desktop-api.js';
import { button, byId, element, errorMessage, lastPart } from './dom.js';
import type { Task } from './task-state.js';
import type { TaskThread } from './task-thread.js';

export function createTaskOptions(current: () => Task | undefined, ready: () => void, thread: TaskThread) {
  const processorNames = new Map<string, string>();
  const processorName = (id: string) => processorNames.get(id) ?? id;
  let folder: string | null = null,
    root = ''; // a folder picked for the next new task (null: a new one under the tasks folder, root)
  let servers: string[] = [];
  const off = new Set<string>(); // the MCP servers, and those left out of the next turn
  let connectors: Connector[] = [];
  const offConnectors = new Set<string>(); // what the next task reaches, and what the person left out
  /** The harness's own switches, as it names them, behind one quiet line that says the main ones. */
  function settings(t: Task | undefined) {
    const sw = byId('switches'),
      panel = byId('settings');
    panel.replaceChildren();
    sw.hidden = !t?.switches.length;
    if (!t?.switches.length) return;
    const value = (s: Switch) =>
      s.type === 'boolean'
        ? s.value === true
          ? s.name
          : ''
        : (s.options?.find((o) => o.value === s.value)?.name ?? String(s.value));
    (sw.firstElementChild as HTMLElement).textContent = [
      ...t.switches.filter((s) => s.type === 'select').slice(0, 3),
      ...t.switches.filter((s) => s.type === 'boolean'),
    ]
      .map(value)
      .filter(Boolean)
      .join(' · ');
    sw.title = t.switches
      .map((s) => `${s.name}: ${s.type === 'boolean' ? (s.value === true ? 'on' : 'off') : value(s)}`)
      .join('\n');
    for (const s of t.switches) {
      const label = element('label', '', s.name);
      label.title = s.description ?? '';
      if (s.type === 'boolean') {
        const i = element('input');
        i.type = 'checkbox';
        i.checked = s.value === true;
        i.addEventListener('change', () => void change(t, s.id, i.checked));
        panel.append(label, i);
        continue;
      }
      const pick = element('span', 'pick'),
        sel = element('select');
      for (const o of s.options ?? []) {
        const op = new Option(
          o.group ? `${o.group}: ${o.name}` : o.name,
          o.value,
          false,
          o.value === s.value,
        );
        op.title = o.description ?? '';
        sel.append(op);
      }
      sel.addEventListener('change', () => void change(t, s.id, sel.value));
      pick.append(sel);
      panel.append(label, pick);
    }
  }
  async function change(t: Task, id: string, value: string | boolean) {
    // the person's change, to a value the harness offers; what it reports is what shows
    try {
      t.switches = await desktop.set(t.id, id, value);
    } catch (err) {
      thread.appendNote(t, errorMessage(err), true);
    }
    if (current() === t) {
      const keep = !byId('settings').hidden;
      settings(t);
      byId('settings').hidden = !keep;
    }
  }
  function serversRow() {
    byId('servers').replaceChildren(
      ...servers.map((name) => {
        const b = button('tool', '', () => {
          if (off.has(name)) off.delete(name);
          else off.add(name);
          serversRow();
        });
        b.append(element('span', '', name));
        b.setAttribute('aria-pressed', String(!off.has(name)));
        b.title = `${name}: ${off.has(name) ? 'left out of the next turn' : 'in the next turn'}`;
        return b;
      }),
    );
  }
  const chosen = () => servers.filter((s) => !off.has(s));
  /** The connectors a new task reaches: each in the app's connectors folder, chosen here before the task starts. */
  function connectorsRow() {
    const box = byId('connectors');
    box.hidden = !connectors.length;
    box.replaceChildren(
      ...connectors.map((c) => {
        const b = button(`tool${c.key === 'missing' ? ' missing' : ''}`, '', () => {
          if (offConnectors.has(c.name)) offConnectors.delete(c.name);
          else offConnectors.add(c.name);
          connectorsRow();
        });
        b.dataset.connector = c.name;
        b.append(element('span', '', c.title));
        b.setAttribute('aria-pressed', String(!offConnectors.has(c.name)));
        b.title = `${c.title}: ${c.kind === 'http' ? 'an HTTP API, served to the harness by the app' : 'an MCP server'}${c.guide ? ', with its guide' : ''}${c.key === 'missing' ? '. It has no key yet: the Connector Keys page (the key button in Activity)' : ''}; ${offConnectors.has(c.name) ? 'left out of the next task' : 'in the next task'}`;
        return b;
      }),
    );
  }
  /** The harnesses this app may use: those the shell's Processors give it, the person's pick kept while it is one. */
  function harnessRow(list: { id: string; name: string }[]) {
    const s = byId<HTMLSelectElement>('harness'),
      was = s.value;
    for (const p of list) processorNames.set(p.id, p.name);
    s.replaceChildren(...list.map((p) => new Option(p.name, p.id)));
    if (!list.length) {
      const none = new Option('No processor available', '');
      none.disabled = true;
      s.append(none);
    }
    s.value = list.some((p) => p.id === was) ? was : (list[0]?.id ?? '');
    s.title = list.length ? 'The harness that does the task' : 'Connect a processor to send messages';
    ready();
  }
  /** Where the next task works: the folder the person picks, as it is (the harness's own sandbox keeps it there), or a new one
   *  under the tasks folder. */
  function place() {
    (byId('place').lastElementChild as HTMLElement).textContent = folder ? lastPart(folder) : 'New folder';
    byId('place').title = folder
      ? `Task folder: ${folder}`
      : `Works in a new folder in ${root || 'the tasks folder'}; click to pick one`;
    byId('unplace').hidden = !folder;
    ready();
  }

  function takeFolder() {
    const picked = folder;
    folder = null;
    place();
    return picked;
  }

  function connections() {
    const servers = chosen();
    if (!connectors.length) return { servers };
    return {
      servers,
      connectors: connectors.map((item) => item.name).filter((name) => !offConnectors.has(name)),
    };
  }

  function bind() {
    byId('place').addEventListener('click', async () => {
      const f = await desktop.pickFolder();
      if (f) {
        folder = f;
        place();
      }
    });
    byId('unplace').addEventListener('click', () => {
      folder = null;
      place();
    });
    byId('template').addEventListener('change', () => ready());
    desktop.onProcessors(harnessRow);
    void desktop.processors().then(harnessRow, () => undefined);
    byId('harness').addEventListener('change', ready);
    byId('switches').addEventListener('click', () => {
      byId('settings').hidden = !byId('settings').hidden;
    });
    void desktop.servers().then((list) => {
      servers = list;
      serversRow();
    });
    void desktop.connectors().then(
      ({ list, failed }) => {
        connectors = list;
        connectorsRow();
        for (const [n, w] of Object.entries(failed))
          thread.appendAppNotice(`the connector in ${n} could not be read: ${w}`);
      },
      () => undefined,
    );
    void desktop.folder().then((f) => {
      root = f.root;
      place();
    });
    place();
  }
  return {
    bind,
    takeFolder,
    hasFolder: () => !!folder,
    selectedServers: chosen,
    connections,
    settings,
    processorName,
  };
}
