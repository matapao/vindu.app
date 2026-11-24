// The browser views' pages: each in a Chromium the app drives, never in the person's own browser. The model reaches a
// page through the DevTools protocol, as before (Vindu's browser views). Where the desktop app started this core (its
// link, frame-link.ts), a page lives in the app: a page of its own, laid over its pane in the app's window that shows the
// task, where the person sees it and acts in it as in any browser. Otherwise it lives in a Chromium of this process's
// (Playwright's, with no window), and the person sees it in its pane as pictures of it (the page's screencast, while the
// pane shows) and acts in it from there: clicks, the wheel and keys go to the page as input, and the page is laid out at
// its pane's size. A page of the app's is pictured that way too, for a pane in a browser's tab. The person's pages keep
// their sign-ins (a profile of the app's, in its folder; in the desktop app, a session of its own); the model's start
// empty each task and never see the person's. No page gets the camera, the microphone, location or notifications, or
// downloads anything; a page never opens a window of its own: what it would open there opens in the same pane, through
// the same gate as any other move it makes.
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession } from 'playwright-core';
import type { Cdp } from '@matapao/vindu/server';
import type { FrameLink, FrameRect } from './frame-link.js';

/** What the person does in a pane, in the page's CSS pixels. modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export type PageInput =
  | { type: 'mouse'; event: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button?: 'none' | 'left' | 'middle' | 'right'; buttons?: number; clickCount?: number; modifiers?: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: 'key'; event: 'keyDown' | 'rawKeyDown' | 'keyUp'; key: string; code: string; text?: string; keyCode?: number; modifiers?: number; location?: number; autoRepeat?: boolean }
  | { type: 'text'; text: string };
/** A picture of a page: a JPEG, and the size in CSS pixels it shows. */
export type Frame = { data: string; width: number; height: number };
export type PageState = { url: string; title: string; loading: boolean; back: boolean; forward: boolean };
/** A page, wherever it lives: its DevTools protocol (Vindu's, and this host's own, for pictures, input and its history),
 *  its address and title, an expression run in it (a test's), its end; in Playwright's Chromium, its first load; and in
 *  the desktop app, its place over a pane in one of the app's windows. */
type Made = { cdp: Cdp; own: Cdp; url(): string; title(): Promise<string>; evaluate(js: string): Promise<unknown>; close(): Promise<void>; ready?(): Promise<void>;
  native?(window: string | null, at?: FrameRect): void; shows?(window: string): boolean };
type Open = { made: Made; box: { w: number; h: number; scale: number } | null; at: FrameRect | null; window?: string; live: boolean; casting: boolean; loading: boolean;
  still?: ReturnType<typeof setTimeout> };

export type PageHostOptions = {
  /** Where the person's pages keep their sign-ins. */
  profile: string;
  /** What the Chromium starts with besides its own (a test's host rules). */
  args?: string[];
  /** The desktop app's link, when it started this core: the pages live in the app. */
  frame?: FrameLink;
  /** A picture of a page while its pane shows it. */
  onFrame: (task: string, name: string, f: Frame) => void;
  /** A page moved, loaded or changed its title. */
  onChange: (task: string, name: string) => void;
  /** Where Desktop's page is in a window of the desktop app's, when the shell shows it in a frame of that window: its
   *  place there (a pane's place is in Desktop's page), null when the shell shows another app in front, or nothing for a
   *  window Desktop has to itself. */
  offset?: (window: string) => { x: number; y: number } | null | undefined;
};

const session = (s: CDPSession): Cdp => ({ send: (m, params) => s.send(m as never, params as never), on: (ev, fn) => { s.on(ev as never, fn as never); return () => { s.off(ev as never, fn as never); }; } });
/** A task's pages of the model's, in the desktop app: a session of the task's own, as a context of its own is here. */
const modelPartition = (task: string) => `vindu-model-${task.replace(/[^\w-]/g, '_')}`;

export function pageHost(o: PageHostOptions) {
  let browser: Promise<Browser> | undefined, person: Promise<BrowserContext> | undefined;
  const models = new Map<string, Promise<BrowserContext>>(); // each task's own, empty at its start
  const open = new Map<string, Open>(); const key = (task: string, name: string) => `${task}/${name}`;
  let front: string | undefined;
  const settings = { viewport: null, acceptDownloads: false, permissions: [] as string[], serviceWorkers: 'block' as const };
  const contextFor = (task: string, owner: 'model' | 'person'): Promise<BrowserContext> => {
    if (owner === 'person') return (person ??= chromium.launchPersistentContext(o.profile, { headless: true, args: o.args ?? [], ...settings }));
    let c = models.get(task);
    if (!c) { browser ??= chromium.launch({ headless: true, args: o.args ?? [] }); c = browser.then(b => b.newContext(settings)); models.set(task, c); }
    return c;
  };
  /** A page in Playwright's Chromium, with no window. */
  const inChromium = async (task: string, owner: 'model' | 'person'): Promise<Made> => {
    const ctx = await contextFor(task, owner);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page), own = await ctx.newCDPSession(page);
    // what the page would open in a window of its own opens here instead, through the same gate as its other moves
    page.on('popup', pop => { const url = pop.url(); void pop.close().catch(() => undefined); if (/^https?:/i.test(url)) void page.goto(url).catch(() => undefined); });
    page.on('dialog', d => { void d.dismiss().catch(() => undefined); }); // a page's alert or confirm: nobody here to answer it
    return { cdp: session(cdp), own: session(own), url: () => page.url(), title: () => page.title(), evaluate: js => page.evaluate(js), close: () => page.close(),
      ready: async () => { await page.goto('about:blank').catch(() => undefined); } };
  };
  /** A page in the desktop app: the app opens what it would open in a window of its own in the same page. */
  const inFrame = async (frame: FrameLink, task: string, owner: 'model' | 'person'): Promise<Made> => {
    const v = await frame.open(owner === 'model' ? modelPartition(task) : 'persist:vindu-person');
    return { cdp: v.cdp, own: v.cdp, url: () => v.url(), title: () => v.title(), close: () => v.close(), native: (window, at) => v.place(window, at), shows: window => v.shows(window),
      evaluate: async js => {
        const r = await v.cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'the expression failed');
        return r.result?.value;
      } };
  };
  /** Where the page shows. Its pane in a window of the desktop app's, with its task in front: the page itself, laid over
   *  the pane. Otherwise pictures of the page while its pane shows it and its task is in front, at the pane's size; none
   *  otherwise. A page that does not change sends none of its own, so each time its pane comes or changes size it is
   *  pictured once as it is. */
  const apply = async (task: string, name: string) => {
    const p = open.get(key(task, name)); if (!p) return;
    const off = p.window && o.offset ? o.offset(p.window) : undefined; // Desktop in a frame of the shell's window: its place there; null, behind another app
    const on = task === front && !!p.box && off !== null, own = p.made.own;
    if (p.made.native) {
      const here = on && p.window && (p.made.shows?.(p.window) ?? o.frame?.has(p.window)) ? p.window : undefined; // live in its own app's window; pictured anywhere else
      p.live = !!here;
      p.made.native(here ?? null, here ? (off ? { ...p.at!, x: p.at!.x + off.x, y: p.at!.y + off.y } : p.at!) : undefined);
      if (here) {
        if (p.casting) { p.casting = false; clearTimeout(p.still); await own.send('Page.stopScreencast').catch(() => undefined); await own.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined); }
        return;
      }
    }
    if (on) {
      const b = p.box!;
      await own.send('Emulation.setDeviceMetricsOverride', { width: b.w, height: b.h, deviceScaleFactor: b.scale, mobile: false }).catch(() => undefined);
      if (!p.casting) { p.casting = true; await own.send('Page.startScreencast', { format: 'jpeg', quality: 75, everyNthFrame: 1 }).catch(() => undefined); }
      clearTimeout(p.still);
      p.still = setTimeout(() => { // once the pane has settled
        void own.send('Page.captureScreenshot', { format: 'jpeg', quality: 75 }).then(r => { if (p.casting && p.box) o.onFrame(task, name, { data: r.data, width: p.box.w, height: p.box.h }); }, () => undefined);
      }, 120);
    } else if (p.casting) { p.casting = false; clearTimeout(p.still); await own.send('Page.stopScreencast').catch(() => undefined); }
  };
  return {
    /** A page for a task's view, as Vindu's browser views take it: the model's or the person's. */
    async open(task: string, name: string, owner: 'model' | 'person'): Promise<Cdp> {
      const made = o.frame?.connected() ? await inFrame(o.frame, task, owner) : await inChromium(task, owner);
      const p: Open = { made, box: null, at: null, live: false, casting: false, loading: false };
      open.set(key(task, name), p);
      const own = made.own;
      own.on('Page.screencastFrame', f => {
        void own.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
        if (p.casting) o.onFrame(task, name, { data: f.data, width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
      });
      const changed = () => o.onChange(task, name);
      own.on('Page.frameStartedLoading', () => { p.loading = true; changed(); });
      own.on('Page.frameStoppedLoading', () => { p.loading = false; changed(); });
      own.on('Page.frameNavigated', e => { if (!e.frame.parentId) changed(); });
      own.on('Page.navigatedWithinDocument', changed);
      own.on('Page.domContentEventFired', changed);
      // a page's alert or confirm, in the app: nobody here to answer it, as in the Chromium here
      if (made.native) own.on('Page.javascriptDialogOpening', () => { void own.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined); });
      await own.send('Page.enable').catch(() => undefined);
      await made.ready?.();
      return made.cdp;
    },
    async close(task: string, name: string) {
      const p = open.get(key(task, name)); if (!p) return;
      open.delete(key(task, name)); clearTimeout(p.still);
      await p.made.close().catch(() => undefined);
    },
    /** A task that closed: its own pages and their context go with it. */
    /** Every page laid again where it is: the shell moved Desktop in its window, or put another app in front. */
    refresh() { for (const k of open.keys()) { const [task, ...rest] = k.split('/'); void apply(task, rest.join('/')); } },
    async closeTask(task: string) {
      for (const k of [...open.keys()]) if (k.startsWith(`${task}/`)) await this.close(task, k.slice(task.length + 1));
      const c = models.get(task); models.delete(task); await c?.then(x => x.close()).catch(() => undefined);
      if (o.frame?.connected()) await o.frame.clear(modelPartition(task)).catch(() => undefined); // its session in the app, emptied
    },
    /** Where a page's pane is (CSS pixels in its window's page, and the screen's scale), or null while it is hidden; and,
     *  for a pane in a window of the desktop app's, that window's key. */
    place(task: string, name: string, box: { x?: number; y?: number; w: number; h: number; scale: number } | null, window?: string) {
      const p = open.get(key(task, name)); if (!p) return;
      const shown = !!box && box.w > 0 && box.h > 0;
      p.box = shown ? { w: Math.round(box!.w), h: Math.round(box!.h), scale: Math.min(3, Math.max(1, box!.scale || 1)) } : null;
      p.at = shown ? { x: box!.x ?? 0, y: box!.y ?? 0, w: box!.w, h: box!.h } : null;
      p.window = window;
      void apply(task, name);
    },
    /** The task the window shows: only its pages are shown. */
    front(task: string | undefined) { front = task; for (const k of open.keys()) { const i = k.indexOf('/'); void apply(k.slice(0, i), k.slice(i + 1)); } },
    /** What the person does in a pane, to the page (a pictured one's: a page in the app gets it there, as it comes). */
    input(task: string, name: string, e: PageInput) {
      const p = open.get(key(task, name)); if (!p) return;
      const s = p.made.own;
      if (e.type === 'mouse') void s.send('Input.dispatchMouseEvent', { type: e.event, x: e.x, y: e.y, button: e.button ?? 'none', buttons: e.buttons ?? 0, clickCount: e.clickCount ?? 0, modifiers: e.modifiers ?? 0 }).catch(() => undefined);
      else if (e.type === 'wheel') void s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: e.x, y: e.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: e.modifiers ?? 0 }).catch(() => undefined);
      else if (e.type === 'key') void s.send('Input.dispatchKeyEvent', { type: e.event, key: e.key, code: e.code, modifiers: e.modifiers ?? 0, windowsVirtualKeyCode: e.keyCode ?? 0, nativeVirtualKeyCode: e.keyCode ?? 0, autoRepeat: !!e.autoRepeat, location: e.location ?? 0, ...(e.text !== undefined ? { text: e.text, unmodifiedText: e.text } : {}) }).catch(() => undefined);
      else void s.send('Input.insertText', { text: e.text }).catch(() => undefined);
    },
    /** A page's address, title, whether it is loading, and whether it can go back or forward. */
    async state(task: string, name: string): Promise<PageState | null> {
      const p = open.get(key(task, name)); if (!p) return null;
      const h = await p.made.own.send('Page.getNavigationHistory').catch(() => null);
      return { url: p.made.url(), title: await p.made.title().catch(() => ''), loading: p.loading,
        back: !!h && h.currentIndex > 0, forward: !!h && h.currentIndex < h.entries.length - 1 };
    },
    has: (task: string, name: string) => open.has(key(task, name)),
    /** For a test: what an expression gives in a page, as the page itself would run it. */
    evaluate: (task: string, name: string, js: string) => { const p = open.get(key(task, name)); if (!p) throw new Error(`no page ${name}`); return p.made.evaluate(js); },
    /** A task's pages: each pane's size, whether it is pictured, or live in a window of the desktop app's, and its address. */
    pages: (task: string) => [...open.entries()].filter(([k]) => k.startsWith(`${task}/`)).map(([k, p]) => ({ name: k.slice(task.length + 1), box: p.box, casting: p.casting, live: p.live, url: p.made.url() })),
    async stop() {
      for (const p of open.values()) if (p.made.native) await p.made.close().catch(() => undefined); // the app's: its pages go now
      open.clear();
      for (const c of models.values()) await c.then(x => x.close()).catch(() => undefined); models.clear();
      await person?.then(x => x.close()).catch(() => undefined); person = undefined;
      await browser?.then(b => b.close()).catch(() => undefined); browser = undefined;
    },
  };
}
export type PageHost = ReturnType<typeof pageHost>;
export const profileDir = (userData: string) => path.join(userData, 'browser');
