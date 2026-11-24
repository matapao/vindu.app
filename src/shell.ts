// The shell: the page the person opens first, in their own browser. It has the apps' grid, an icon and a name each, and
// Processors: the harnesses this computer has, where each runs and what it uses for its model, and which app may use
// which. A click on an app opens it in a tab of its own (the same tab again while it is open), at its own address: each
// app is a page on an origin of its own, so no app reaches another one, nor the shell, and none can give itself a
// processor. An app of this process's own (Desktop) is served here; any other is a folder with an app.json, whose own
// server this process starts on the first click and stops when it stops. Such a server is given its port (PORT) and the
// token its page's address has (APP_TOKEN), and serves its page at /<token>/ only, as the shell's own pages are: a
// program here that knows only its port reaches nothing of it. Each is an app of Celler through Vindu (app.ts),
// with what its app.json asks it for ("processors", "connectors", "storage"); one that asks for something is also given
// the Celler-backed endpoint and its own token there, new at each start (HARNESS_URL and HARNESS_TOKEN, also given as
// CELLER_URL and CELLER_TOKEN), and takes only what the person grants it under Processors, as Desktop does. Every app
// is told where the shell is (SHELL_ORIGINS, also given as VINDU_SHELL), so it can let the shell frame its page. An
// app's server runs as the person's own programs do: what keeps a harness in
// its folder is the harness's own sandbox, and nothing here holds an app's server. The shell draws nothing inside an app:
// splitting the screen, other windows, an installed web app's own window are the browser's and the system's to do. The
// shell's page and Desktop's can each be installed as a web app (web.ts makes their manifests); a folder's app makes its own.
// In the desktop app's window, and where there are no tabs (a phone's Home Screen, a narrow window), the shell shows each
// app in a frame of its own, as a tab of its bar, which the app allows the shell to do (frame-ancestors); an app whose
// page says no frame may show it opens in a window of its own. On the person's tailnet (network.ts), a paired device
// opens the shell at its own token, and each app's address is given as that device reaches it. What each app may use
// (Processors: its processors and connectors, its day's budget) is set on this computer, or on one of the person's owner
// devices (devices.ts); any other device is refused it here, whatever its page shows.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startPageServer, type PageServer, type Sender } from './web.js';

/** An app on the grid: where its page is (or how to start it), and whether it takes processors from the shell or runs
 *  its own (as an app does until it takes them from the core). */
export type ShellApp = { id: string; name: string; icon: string; processors: 'granted' | 'own'; url?: string; start?: () => Promise<string>; folder?: string; asks?: string[]; about?: string; color?: string };
/** A processor the apps may use: a harness, where it can run and what it can use for its model; or a model processor, a
 *  model at an endpoint on its key, with the harness it is attached to (and runs on) and whether its key is set. */
export type ShellProcessor = { id: string; name: string; kind?: 'harness' | 'model'; where: string[]; models: string[]; note?: string; harness?: string; model?: string; endpoint?: string; key?: 'set' | 'missing' };
/** An app's folder, as its app.json says: its id (lower-case letters, digits and dashes, as Celler takes it), its
 *  name, its icon (its logo: SVG, PNG, JPEG or WebP, in its folder), the command that serves its page (at /<APP_TOKEN>/
 *  on PORT, the port it prefers when that is free), and what it asks Celler for; and, for the grid, a line about it
 *  (description) and its colour (#rgb or #rrggbb). */
type Manifest = { id: string; name: string; icon: string; serve: { command: string; args?: string[]; port?: number }; asks?: string[]; description?: string; color?: string };
/** A connector, as Processors lists it for the apps that ask for connectors: its grant's id (connector:<name>) and its title. */
export type ShellConnector = { id: string; name: string };
export type ShellSetup = {
  token: string;
  port?: number;
  /** The app's own apps (Desktop), with their addresses. */
  own: () => ShellApp[];
  /** Folders of other apps, each with its app.json. */
  folders: () => string[];
  /** A folder app's token, for its page's address: kept, so the address stays the same from one start to the next. */
  tokenOf: (app: string) => string;
  processors: () => ShellProcessor[];
  grants: () => Record<string, string[]>;            // each app's processors, by their ids
  grant: (app: string, processor: string, on: boolean) => void;
  log: (e: Record<string, unknown>) => void;
  /** Where each folder's app writes what its server prints. */
  logDir: () => string;
  /** A folder's app on the grid, as Celler is to hold it: what its app.json says. */
  held?: (app: { id: string; name: string; asks: string[]; folder: string }) => boolean | void;
  /** What a folder's app is given in its environment as it starts: the app endpoint and its token there, when it asks
   *  Celler for something, and where the shell is. */
  door?: (app: { id: string; name: string }) => Record<string, string> | undefined;
  /** The connectors the person set up, for the apps that ask for connectors. */
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
  remoteFolder?: (id: string, local: URL, via: NonNullable<Sender['via']>) => Promise<string>;
  stopped?: (app: string) => void;
  /** The person's own commands on this computer (main.ts's --pair and --tailnet, where no one opens the shell here: a Pi's,
   *  a server's): at the shell's own token, by this computer's name, from no page. */
  control?: (q: Record<string, unknown>) => Promise<unknown>;
};
export type Shell = Awaited<ReturnType<typeof startShell>>;

const STATIC = path.join(import.meta.dirname, '..', '..', 'static');
const free = () => new Promise<number>((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const taken = (port: number) => new Promise<boolean>(resolve => { const s = net.createServer(); s.once('error', () => resolve(true)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(false))); });
/** The logos the grid serves, by their kind. */
const ICONS: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const hasIcon = (file: string) => !!ICONS[path.extname(file).toLowerCase()] && fs.existsSync(file);
/** Operating-system basics needed by native programs. Credentials and harness configuration are granted separately. */
const APP_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']);
const answers = (url: string) => new Promise<boolean>(resolve => { const r = http.get(url, res => { res.resume(); resolve((res.statusCode ?? 500) < 400); }); r.on('error', () => resolve(false)); r.setTimeout(2000, () => { r.destroy(); resolve(false); }); });

/** The app in a folder, if its app.json reads. */
function manifestOf(folder: string): Manifest | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(folder, 'app.json'), 'utf8')) as Manifest;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(m.id) || !m.name || !m.serve?.command) return undefined;
    const about = typeof m.description === 'string' ? m.description.replace(/\s+/g, ' ').trim().slice(0, 160) : '', color = typeof m.color === 'string' && /^#(?:[0-9a-f]{3}){1,2}$/i.test(m.color) ? m.color : undefined;
    return { ...m, asks: Array.isArray(m.asks) ? m.asks.filter(x => typeof x === 'string') : [], description: about || undefined, color };
  } catch { return undefined; }
}

export async function startShell(o: ShellSetup) {
  let closed = false;
  const running = new Map<string, { child?: ChildProcess; url: Promise<string> }>(), ports = new Map<string, number>(); // each app's port, kept for a start again
  /** A folder's app, started once: its server, on the port it prefers when that is free, given as PORT, and its token. */
  const serve = (folder: string, m: Manifest) => {
    const was = running.get(m.id); if (was && (!was.child || (was.child.exitCode === null && was.child.signalCode === null))) return was.url;
    fs.mkdirSync(o.logDir(), { recursive: true, mode: 0o700 }); const logFile = path.join(o.logDir(), `${m.id}.log`), log = fs.openSync(logFile, 'a', 0o600);
    const r: { child?: ChildProcess; url: Promise<string> } = { url: Promise.resolve('') };
    r.url = (async () => {
      try {
        const was = ports.get(m.id), token = o.tokenOf(m.id);
        const port = m.serve.port && !(await taken(m.serve.port)) ? m.serve.port : was && !(await taken(was)) ? was : await free(); ports.set(m.id, port);
        // the app endpoint only for what asks it for something; where the shell is, for every app
        if (closed) throw new Error('Vindu is closing');
        const given = o.door?.({ id: m.id, name: m.name }) ?? {};
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => APP_ENV.has(name.toUpperCase())));
        const child = r.child = spawn(m.serve.command, m.serve.args ?? [], { cwd: folder, env: { ...env, PORT: String(port), APP_TOKEN: token, ...given } as Record<string, string>, stdio: ['ignore', log, log] });
        o.log({ app: m.id, started: m.serve.command, port, celler: 'CELLER_URL' in given });
        let startupError: Error | undefined;
        const stopped = (reason: unknown) => {
          if (running.get(m.id) === r) { running.delete(m.id); o.stopped?.(m.id); }
          o.log({ app: m.id, stopped: reason }); if (!closed) page.send('shell:state', state());
        };
        child.once('error', error => { startupError = error; if (child.pid === undefined) stopped(error.message); });
        child.once('exit', (code, signal) => stopped(code ?? signal));
        for (let i = 0; i < 300; i++) { // 30 s
          if (startupError) throw startupError;
          if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${m.name} stopped as it started: its log is ${logFile}`);
          const ready = await answers(`http://127.0.0.1:${port}/${token}/`);
          if (closed) throw new Error('Vindu is closing');
          if (ready) {
            const url = `http://localhost:${port}/${token}/`;
            page.send('shell:state', state());
            return url;
          }
          await new Promise(res => setTimeout(res, 100));
        }
        child.kill(); throw new Error(`${m.name} did not answer in 30 seconds: its log is ${logFile}`);
      } finally { fs.closeSync(log); } // the server has its own copy
    })();
    r.url.catch(() => { if (running.get(m.id) === r) running.delete(m.id); });
    running.set(m.id, r);
    return r.url;
  };
  const apps = (): ShellApp[] => {
    const builtIn = o.own();
    const seen = new Set(builtIn.map(app => app.id));
    const installed = o.folders().flatMap(location => {
      const m = manifestOf(location);
      if (!m || seen.has(m.id)) return [];
      let folder: string;
      try { folder = fs.realpathSync(location); } catch { return []; }
      const asks = m.asks ?? [];
      if (o.held?.({ id: m.id, name: m.name, asks, folder }) === false) return [];
      seen.add(m.id);
      return [{ id: m.id, name: m.name, icon: m.icon ? path.resolve(folder, m.icon) : '',
        processors: asks.includes('processors') ? 'granted' as const : 'own' as const, folder, asks,
        ...(m.description ? { about: m.description } : {}), ...(m.color ? { color: m.color } : {}), start: () => serve(folder, m) }];
    });
    return [...builtIn, ...installed];
  };
  const need = (id: string) => { const a = apps().find(x => x.id === id); if (!a) throw new Error(`no app "${id}"`); return a; };
  /** Whether an app's page is up: the core's own always, a folder's while its server runs. */
  const up = (a: ShellApp) => { if (!a.folder) return true; const c = running.get(a.id)?.child; return !!c && c.exitCode === null && c.signalCode === null; };
  /** The grid: which computer the core is on (its name), and each app with its logo (none: the page draws its initials),
   *  its line and colour, whether it is up, and the processors ticked for it, by their names. */
  const state = () => {
    const listed = apps(), names = new Map(o.processors().map(p => [p.id, p.name])), grants = o.grants();
    return { host: os.hostname().replace(/\.local$/i, ''), apps: listed.map(a => ({ id: a.id, name: a.name, icon: hasIcon(a.icon) ? `icon/${a.id}` : '', processors: a.processors, ...(a.about ? { about: a.about } : {}), ...(a.color ? { color: a.color } : {}),
      running: up(a), uses: a.processors === 'granted' ? (grants[a.id] ?? []).flatMap(p => (names.has(p) ? [names.get(p)!] : [])) : [] })) };
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
      const a = apps().find(x => x.id === m[1]); const type = a && ICONS[path.extname(a.icon).toLowerCase()];
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
  const openFor = async (via: Sender['via'], a: ShellApp, url: string) => {
    o.log({ app: a.id, opened: true, ...(via?.device ? { device: via.device } : {}) });
    if (!via?.device && !via?.away) return url;
    if (!via?.device || !via.token) throw new Error('Pair this device to open an app');
    const u = new URL(url);
    if (a.folder) {
      if (!o.remoteFolder) throw new Error('This app is available on the host computer');
      return o.remoteFolder(a.id, u, via);
    }
    return `${via.secure ? 'https' : 'http'}://${via.host.replace(/:\d+$/, '')}:${u.port}/${via.token}/`;
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
  /** Where an app's page is (started first, if it is a folder's and not running), as the page that asks reaches it. */
  page.handle('shell:open', async (e, id: unknown) => { const a = need(String(id)); return openFor(e.sender.via, a, a.url ?? await a.start!()); });
  /** An app to open in the shell's own window: its address, as shell:open gives it, and whether its page lets the shell
   *  frame it, as the page's own answer says (X-Frame-Options, frame-ancestors). */
  page.handle('shell:open-here', async (e, id: unknown) => {
    const a = need(String(id)); const local = a.url ?? await a.start!();
    const from = `${e.sender.via?.secure ? 'https' : 'http'}://${e.sender.via?.host ?? `localhost:${page.port}`}`;
    return { url: await openFor(e.sender.via, a, local), frame: await framable(local, from) };
  });
  page.handle('shell:processors', e => (setsUp(e), { processors: o.processors(), connectors: o.connectors?.() ?? [],
    apps: apps().map(a => ({ id: a.id, name: a.name, processors: a.processors, connectors: a.folder ? a.asks?.includes('connectors') ? 'granted' : 'none' : 'per-task', folder: !!a.folder })),
    grants: o.grants() }));
  page.handle('shell:grant', async (e, app: unknown, what: unknown, on: unknown) => {
    setsUp(e); const a = need(String(app)), w = String(what);
    if (w.startsWith('connector:')) { if (!a.folder || !a.asks?.includes('connectors')) throw new Error(`${a.name} asks for no connectors${a.folder ? '' : ': it gives each task those the person chooses'}`); }
    else if (a.processors !== 'granted') throw new Error(`${a.name} runs its own harnesses: it takes none from here yet`);
    o.grant(a.id, w, on === true); page.send('shell:state', state()); return o.grants();
  });
  return {
    page, url: page.url,
    /** The grid changed (an app came or went). */
    changed: () => page.send('shell:state', state()),
    apps,
    /** Processors are set on this computer, or on one of the person's owner devices: throws for any other page. */
    setsUp,
    /** Where a folder's app's page is, once the shell started it. */
    address: (id: string): Promise<string> | undefined => running.get(id)?.url,
    /** A folder's app's server, as it runs (a test's look at how it was started). */
    child: (id: string) => running.get(id)?.child,
    async close() {
      closed = true;
      for (const r of running.values()) r.child?.kill('SIGTERM');
      running.clear(); await page.close();
    },
  };
}
