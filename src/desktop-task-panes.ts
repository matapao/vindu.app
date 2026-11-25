import type { Views } from '@matapao/vindu/server';
import { pageHost, profileDir, type PageInput } from './pages.js';
import type { DesktopHost } from './desktop-host.js';
import type { TaskActivity } from './desktop-task-activity.js';

type Box = { x: number; y: number; w: number; h: number; scale?: number };

export function taskPanes(host: DesktopHost, state: TaskActivity) {
  const { desktop, send, userData, options: o } = host;
  const { tasks, need } = state;
  const viewsOf = (id: string): Views => { const v = need(id).views; if (!v) throw new Error('this task has no terminals or pages'); return v; };
  const pages = pageHost({ profile: profileDir(userData), ...(o.browserArgs ? { args: o.browserArgs } : {}), ...(o.frame ? { frame: o.frame } : {}),
    onFrame: (task, name, f) => send('frame', task, name, f),
    onChange: (task, name) => { void pages.state(task, name).then(st => send('browser', task, name, pageState(task, name, st))); } });
  /** A page's bar: its address and title, whether it loads, can go back or forward, is shared, and whose it is. */
  const pageState = (task: string, name: string, st: Awaited<ReturnType<typeof pages.state>>) => {
    if (!st) return null; let shared = false, owner: 'model' | 'person' = 'person';
    try { const p = tasks.get(task)?.views?.browsers?.get(name); if (p) { shared = p.shared; owner = p.owner; } } catch { /* still opening */ }
    return { ...st, shared, owner };
  };
  const pty = new Map<string, () => void>(); // task/terminal → the window's subscription
  // the person ends or shares a terminal or a page; where a page's native view goes (CSS pixels of the window; null: hidden)
  desktop.handle('view:end', async (_e, task: string, name: string) => { const k = `${task}/${name}`; pty.get(k)?.(); pty.delete(k); await viewsOf(task).end(name); });
  desktop.handle('view:share', (_e, task: string, name: string, on: boolean) => viewsOf(task).share(name, on));
  // where a page's pane is, and in which of the Electron app's windows, if the page that says so is in one of them
  desktop.on('view:box', (e, task: string, name: string, box: Box | null) => { pages.place(task, name, box && { x: box.x, y: box.y, w: box.w, h: box.h, scale: box.scale ?? 1 }, e.sender.window); });
  desktop.on('browser:input', (_e, task: string, name: string, e: PageInput) => { if (task === state.front) pages.input(task, name, e); }); // only the page the person sees
  // terminals: the person's keys in, what the terminal prints out (first all it shows so far, then each byte once)
  desktop.handle('pty:new', (_e, task: string, cols?: number, rows?: number) => viewsOf(task).openTerminal({ cols, rows }));
  desktop.handle('pty:attach', (_e, task: string, term: string) => {
    const k = `${task}/${term}`; pty.get(k)?.();
    const v = viewsOf(task);
    pty.set(k, v.terminals!.attach(term, d => desktop.send('pty', task, term, d)));
    return v.terminals!.info(term);
  });
  desktop.on('pty:detach', (_e, task: string, term: string) => { const k = `${task}/${term}`; pty.get(k)?.(); pty.delete(k); });
  desktop.on('pty:input', (_e, task: string, term: string, data: string) => { try { viewsOf(task).terminals!.input(term, data); } catch { /* ended */ } });
  desktop.on('pty:resize', (_e, task: string, term: string, cols: number, rows: number) => { try { viewsOf(task).terminals!.resize(term, cols, rows); } catch { /* ended */ } });

  // pages: the person's own, from the bar; each page's own bar. A page still opening is waited for.
  const address = (u: string) => (/^[a-z][a-z\d+.-]*:/i.test(u.trim()) ? u.trim() : `${/^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.)/.test(u.trim()) ? 'http' : 'https'}://${u.trim()}`);
  desktop.handle('browser:new', async (_e, task: string, url?: string) => viewsOf(task).openPage(url ? address(url) : undefined));
  desktop.handle('browser:state', async (_e, task: string, name: string) => { await viewsOf(task).page(name).catch(() => undefined); return pageState(task, name, await pages.state(task, name)); });
  desktop.handle('browser:navigate', async (_e, task: string, name: string, url: string) => { await (await viewsOf(task).page(name)).navigate(address(url)); return pageState(task, name, await pages.state(task, name)); });
  desktop.handle('browser:go', async (_e, task: string, name: string, to: 'back' | 'forward' | 'reload') => { await (await viewsOf(task).page(name)).go(to); return pageState(task, name, await pages.state(task, name)); });
  // the person points at an element of a page: the next click there picks it (the page's own inspect mode), not the page
  desktop.handle('browser:point', (_e, task: string, name: string) => need(task).pointInPage(name));
  desktop.handle('browser:stop-pointing', (_e, task: string, name: string) => { need(task).stopPointing(name); });

  return { pages, detach(id: string) {
    for (const k of [...pty.keys()]) if (k.startsWith(`${id}/`)) { pty.get(k)!(); pty.delete(k); }
  } };
}
