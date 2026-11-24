// The shell: the page the person opens first, in their own browser. It has the apps' grid, an icon and a name each, and
// Processors: the harnesses this computer has, where each runs and what it uses for its model, and which app may use
// which. The apps are this process's own (Desktop), each a page it serves on an origin of its own, so no app reaches
// another one, nor the shell, and none can give itself a processor. A click on an app opens it in a tab of its own (the
// same tab again while it is open). The shell draws nothing inside an app: splitting the screen, other windows, an
// installed web app's own window are the browser's and the system's to do. The shell's page and Desktop's can each be
// installed as a web app (web.ts makes their manifests).
// In the desktop app's window, and where there are no tabs (a phone's Home Screen, a narrow window), the shell shows each
// app in a frame of its own, as a tab of its bar, which the app allows the shell to do (frame-ancestors); an app whose
// page says no frame may show it opens in a window of its own. On the person's tailnet (network.ts), a paired device
// opens the shell at its own token, and each app's address is given as that device reaches it. What each app may use
// (Processors: its processors, its day's budget) is set on this computer, or on one of the person's owner devices
// (devices.ts); any other device is refused it here, whatever its page shows.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startPageServer, type PageServer, type Sender } from './web.js';

/** An app on the grid: one of this process's own, at its address. */
export type ShellApp = { id: string; name: string; icon: string; url: string; about?: string; color?: string };
/** A processor the apps may use: a harness, where it can run and what it can use for its model; or a model processor, a
 *  model at an endpoint on its key, with the harness it is attached to (and runs on) and whether its key is set. */
export type ShellProcessor = { id: string; name: string; kind?: 'harness' | 'model'; where: string[]; models: string[]; note?: string; harness?: string; model?: string; endpoint?: string; key?: 'set' | 'missing' };
/** A connector, as Processors lists it: its id (connector:<name>) and its title. Each task is given those the person chooses. */
export type ShellConnector = { id: string; name: string };
export type ShellSetup = {
  token: string;
  port?: number;
  /** The app's own apps (Desktop), with their addresses. */
  own: () => ShellApp[];
  processors: () => ShellProcessor[];
  grants: () => Record<string, string[]>;            // each app's processors, by their ids
  grant: (app: string, processor: string, on: boolean) => void;
  log: (e: Record<string, unknown>) => void;
  /** The connectors the person set up. */
  connectors?: () => ShellConnector[];
  /** The https names the shell is reached at besides this computer's (the tailnet's), at the same ports. */
  names?: () => string[];
  /** Its names on the person's own Wi-Fi, at the same ports, over HTTPS (the core's forwarder's). */
  lan?: () => string[];
  /** A paired device's token, as its id. */
  devices?: (token: string) => string | undefined;
  /** Whether a paired device is one of the person's owner devices, which set Processors as this computer does. */
  owner?: (device: string) => boolean;
  /** What the shell serves with no token: the pairing page. */
  open?: (req: http.IncomingMessage, res: http.ServerResponse, rest: string, origin: string) => boolean | Promise<boolean>;
  /** A desktop app's link from a paired device, at the shell's port (web.ts). */
  links?: (device: string, ch: { send(message: string): void; onMessage(f: (message: string) => void): void; onClose(f: () => void): void }) => void;
  /** The person's own commands on this computer (main.ts's --pair and --tailnet, where no one opens the shell here: a Pi's,
   *  a server's): at the shell's own token, by this computer's name, from no page. */
  control?: (q: Record<string, unknown>) => Promise<unknown>;
};
export type Shell = Awaited<ReturnType<typeof startShell>>;

const STATIC = path.join(import.meta.dirname, '..', '..', 'static');
/** The logos the grid serves, by their kind. */
const ICONS: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const hasIcon = (file: string) => !!ICONS[path.extname(file).toLowerCase()] && fs.existsSync(file);

export async function startShell(o: ShellSetup) {
  const need = (id: string) => { const a = o.own().find(x => x.id === id); if (!a) throw new Error(`no app "${id}"`); return a; };
  /** The grid: which computer the core is on (its name), and each app with its logo (none: the page draws its initials),
   *  its line and colour, that it is up (this process serves it), and the processors ticked for it, by their names. */
  const state = () => {
    const names = new Map(o.processors().map(p => [p.id, p.name])), grants = o.grants();
    return { host: os.hostname().replace(/\.local$/i, ''), apps: o.own().map(a => ({ id: a.id, name: a.name, icon: hasIcon(a.icon) ? `icon/${a.id}` : '', ...(a.about ? { about: a.about } : {}), ...(a.color ? { color: a.color } : {}),
      running: true, uses: (grants[a.id] ?? []).flatMap(p => (names.has(p) ? [names.get(p)!] : [])) })) };
  };
  // the apps it may frame: this computer's pages, the tailnet's and the Wi-Fi's, at any of their ports (each app's own)
  const frames = () => ['http://localhost:*', 'http://127.0.0.1:*', ...(o.names?.() ?? []).map(n => `https://${n}:*`), ...(o.lan?.() ?? []).map(n => `https://${n}:*`)].join(' ');
  const page: PageServer = await startPageServer({
    name: 'shell', port: o.port ?? 7300, token: o.token, page: path.join(STATIC, 'shell.html'),
    files: { 'shell-page.bundle.js': path.join(import.meta.dirname, 'shell-page.bundle.js'), 'sw.js': path.join(STATIC, 'sw.js') },
    app: { name: 'vindu', icon: path.join(STATIC, 'icons', 'vindu.svg'), theme: '#f6f5f1', background: '#f1f0ec' }, // its bar's colour and its home's, light
    csp: () => `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; connect-src 'none'; frame-src ${frames()}; form-action 'none'; base-uri 'none'`,
    ...(o.names ? { names: o.names } : {}), ...(o.lan ? { lan: o.lan } : {}), ...(o.devices ? { devices: o.devices } : {}), ...(o.open ? { open: o.open } : {}), ...(o.links ? { links: o.links } : {}),
    routes: async (req, res, rest) => {
      if (rest === 'control' && req.method === 'POST' && o.control) {
        // the shell's own token, never a device's; and no page's call: a browser names the page's origin, a command none
        const no = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
        if (!req.url?.startsWith(`/${o.token}/`) || req.headers.origin !== undefined) { res.writeHead(403, no).end('{"error":"not this way"}'); return true; }
        let body = ''; for await (const c of req) { body += String(c); if (body.length > 4096) { res.writeHead(413, no).end(); return true; } }
        let answer: unknown;
        try { answer = await o.control(JSON.parse(body || '{}') as Record<string, unknown>); }
        catch (e) { res.writeHead(400, no).end(JSON.stringify({ error: (e as Error).message })); return true; }
        res.writeHead(200, no).end(JSON.stringify(answer ?? null));
        return true;
      }
      const m = /^icon\/([\w-]+)$/.exec(rest); if (!m || req.method !== 'GET') return false;
      const a = o.own().find(x => x.id === m[1]); const type = a && ICONS[path.extname(a.icon).toLowerCase()];
      if (!a || !type || !hasIcon(a.icon)) { res.writeHead(404).end(); return true; }
      res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); fs.createReadStream(a.icon).pipe(res); return true;
    },
  });
  /** Processors are set on this computer, or on an owner device: any other device is refused. */
  const may = (via: Sender['via']) => (via?.device ? !!o.owner?.(via.device) : !via?.away);
  const setsUp = (e: { sender: Pick<Sender, 'via'> }) => { if (!may(e.sender.via)) throw new Error('what each app may use is set on the computer vindu runs on, or on a device paired as its owner'); };
  page.handle('shell:state', e => ({ ...state(), device: e.sender.via?.device ?? null, away: !!e.sender.via?.away, inApp: !!e.sender.window, setsUp: may(e.sender.via) })); // inApp: in the desktop app's window
  /** An app's address as the page that asks reaches it: on a device, at the name it came by (the tailnet's, over https,
   *  or the Wi-Fi's, over HTTPS), and the core's own pages at the device's token, which removing the device closes. */
  const openFor = (via: Sender['via'], a: ShellApp) => {
    o.log({ app: a.id, opened: true, ...(via?.device ? { device: via.device } : {}) });
    if (!via?.device && !via?.away) return a.url;
    if (!via?.device || !via.token) throw new Error('Pair this device to open an app');
    return `${via.secure ? 'https' : 'http'}://${via.host.replace(/:\d+$/, '')}:${new URL(a.url).port}/${via.token}/`;
  };
  /** Whether a page lets a page of this origin frame it, by its own answer: X-Frame-Options and frame-ancestors. Once
   *  for each address while it runs. */
  const framing = new Map<string, Promise<boolean>>();
  const framable = (url: string, from: string) => {
    const k = `${url} ${from}`; let f = framing.get(k);
    if (!f) framing.set(k, f = (async () => {
      const r = await fetch(url.replace('//localhost:', '//127.0.0.1:'), { signal: AbortSignal.timeout(10_000) }).catch(() => undefined); if (!r) return false;
      void r.body?.cancel().catch(() => undefined);
      if (/deny|sameorigin/i.test(r.headers.get('x-frame-options') ?? '')) return false;
      const ancestors = /frame-ancestors\s+([^;]*)/i.exec(r.headers.get('content-security-policy') ?? '')?.[1]?.trim().split(/\s+/);
      return !ancestors || ancestors.includes('*') || ancestors.includes(from);
    })());
    return f;
  };
  /** Where an app's page is, as the page that asks reaches it. */
  page.handle('shell:open', (e, id: unknown) => openFor(e.sender.via, need(String(id))));
  /** An app to open in the shell's own window: its address, as shell:open gives it, and whether its page lets the shell
   *  frame it, as the page's own answer says (X-Frame-Options, frame-ancestors). */
  page.handle('shell:open-here', async (e, id: unknown) => {
    const a = need(String(id));
    const from = `${e.sender.via?.secure ? 'https' : 'http'}://${e.sender.via?.host ?? `localhost:${page.port}`}`;
    return { url: openFor(e.sender.via, a), frame: await framable(a.url, from) };
  });
  page.handle('shell:processors', e => (setsUp(e), { processors: o.processors(), connectors: o.connectors?.() ?? [],
    apps: o.own().map(a => ({ id: a.id, name: a.name })), grants: o.grants() }));
  page.handle('shell:grant', (e, app: unknown, what: unknown, on: unknown) => {
    setsUp(e); const a = need(String(app)), w = String(what);
    if (w.startsWith('connector:')) throw new Error(`${a.name} gives each task the connectors the person chooses`);
    o.grant(a.id, w, on === true); page.send('shell:state', state()); return o.grants();
  });
  return {
    page, url: page.url,
    /** What the grid shows changed (the names the core is reached at, say). */
    changed: () => page.send('shell:state', state()),
    apps: () => o.own(),
    /** Processors are set on this computer, or on one of the person's owner devices: throws for any other page. */
    setsUp,
    close: () => page.close(),
  };
}
