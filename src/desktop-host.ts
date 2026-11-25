import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { chromium, type Browser } from 'playwright-core';
import { startVindu } from '@matapao/vindu/server';
import { playwrightDriver } from '@matapao/vindu/playwright';
import { openCellerHost } from './celler-host.js';
import { appDataDir, locale } from './os.js';
import { startPageServer, type PageServer } from './web.js';
import { keptToken } from './page-credentials.js';
import { desktopConnectors } from './desktop-connectors.js';
import { desktopFiles } from './desktop-files.js';
import { APP, STATIC, BUILT, ICON, type AppOptions, type Settings } from './desktop-settings.js';

export type DesktopHost = Awaited<ReturnType<typeof openDesktopHost>>;

export async function openDesktopHost(o: AppOptions) {
  const processors = o.processors ?? [];
  const userData = o.userData ?? appDataDir('desktop');
  const tokens = path.join(userData, 'pages.json'), logFile = path.join(userData, 'desktop.jsonl');
  const readSettings = (): Settings => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')); } catch { return {}; } };
  const settings = readSettings();
  const home = o.home ?? os.homedir();
  const tasksFolder = () => { const f = readSettings().tasksFolder ?? '~/Vindu'; return f === '~' || f.startsWith('~/') ? path.join(home, f.slice(1)) : f; };
  const tilde = (p: string) => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p); // a path as the window shows it
  const connectors = desktopConnectors(userData, readSettings, o, tokens);
  const { availableConnectors } = connectors;
  const attachments = desktopFiles(userData);
  // asks: 'host': this app draws what the harness asks in the task's thread, not as panes among its views
  // Vindu checks a page it serves in a Chromium of its own (Playwright's), started for the first check. A computer without
  // one shows its pages all the same, and each check says it could not run here; it is tried again the next time, so a
  // Chromium installed later is used without a restart
  let checker: Promise<Browser> | undefined;
  const checkBrowser = () => (checker ??= (o.pageBrowser ?? (() => chromium.launch({ headless: true })))().catch((e: unknown) => {
    checker = undefined; const said = String((e as Error)?.message ?? e);
    throw new Error(/doesn't exist|not installed|playwright install/i.test(said) ? 'this computer has no browser to check pages in (Playwright\'s Chromium is not installed here)'
      : `the browser to check pages in would not start here: ${said.split('\n')[0]}`);
  }));
  const driver = { open: async (url: string, viewport: { width: number; height: number }) => playwrightDriver(await checkBrowser()).open(url, viewport) };
  // mcpTokenIn: a task's UI server carries its token in a header, never in its address, which a harness may give on a
  // command line anyone on the computer can read
  const uiProvider = await startVindu({ driver, verifyMs: 1500, apps: settings.apps ?? 'off', appsNetwork: settings.appsNetwork, locale: locale(), asks: 'host', mcpTokenIn: 'header',
    pageParentOrigins: (): string[] => desktopOrigins(),
    reminders: true, ...(settings.holidays ? { holidays: settings.holidays } : {}), jobs: { perDay: settings.jobs?.perDay ?? 3 } });
  const celler = openCellerHost(path.join(userData, 'celler'));
  // A new data folder grants Desktop every processor it starts with; a folder with a policy keeps it.
  celler.register(processors.map(harness => harness.id));
  const granted = () => processors.filter(h => celler.grants().includes(h.id));
  const harnessName = (h: string) => processors.find(x => x.id === h)?.name ?? h;
  /** Where Desktop's page is, as it names itself on this computer. Vindu's pages take these as the parents that may frame them. */
  const desktopOrigins = () => [`http://localhost:${desktop.port}`, `http://127.0.0.1:${desktop.port}`];
  // what the app did, for the person: kept in desktop.jsonl, in its folder
  const appLog = (e: Record<string, unknown>) => fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`, { mode: 0o600 }, () => undefined);
  /** Where Vindu's pages are framed from, and their pictures and sounds: this computer's loopback. */
  const pagesAt = 'http://*.localhost:*';
  let control: ((req: http.IncomingMessage, res: http.ServerResponse, rest: string) => Promise<boolean>) | undefined;
  // Desktop's page, the one the person opens (in a browser, or the Electron window), at the app's port, and the
  // Electron app's own question to the app here
  const desktop: PageServer = await startPageServer({ name: APP.id, port: o.port ?? 7300, token: keptToken(tokens, APP.id), page: path.join(STATIC, 'index.html'),
    files: { 'renderer.bundle.js': path.join(BUILT, 'renderer.bundle.js'), 'renderer.bundle.css': path.join(BUILT, 'renderer.bundle.css') },
    app: { name: APP.name, icon: ICON, theme: '#f6f5f1', background: '#fcfcfb' },
    csp: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${pagesAt}; media-src ${pagesAt}; frame-src ${pagesAt}; connect-src 'none'; form-action 'none'; base-uri 'none'`,
    routes: async (req, res, rest) => (await control?.(req, res, rest)) || attachments.dropped(req, res, rest, desktop.origin) });
  const send = (channel: string, ...a: unknown[]) => { desktop.send(channel, ...a); };
  const harnessOf = (value: unknown): string => {
    const harness = processors.find(item => item.id === value);
    if (!harness) throw new Error('Choose an available processor.');
    return harness.id;
  };
  /** A turn of Desktop's runs only on a processor ticked for it in Settings, and within its day's budget. */
  const ensureProcessor = (harness: string) => {
    if (!celler.grants().includes(harness)) {
      throw new Error(`${harnessName(harness)} is not one of ${APP.name}'s processors: check Processors in Settings`);
    }
    const reason = celler.over();
    if (reason) throw new Error(reason);
  };
  const budgetOf = () => {
    const over = celler.over();
    return { limits: celler.budget(), spent: celler.spent(), ...(over ? { over } : {}) };
  };
  // Settings: Processors (the harnesses Desktop may use, the connectors each task chooses from, its day's budget)
  desktop.handle('settings:state', () => ({ host: os.hostname().replace(/\.local$/i, '') }));
  desktop.handle('settings:processors', () => ({ processors, granted: celler.grants(),
    connectors: availableConnectors().connectors.map(c => ({ name: c.name, title: c.title })) }));
  // what each processor still needs, and those not on this computer, as the app's own check says (it calls no model)
  desktop.handle('settings:processor-checks', async () => await o.checkProcessors?.() ?? []);
  desktop.handle('settings:grant', (_e, processor: unknown, on: unknown) => {
    if (!processors.some(h => h.id === processor)) throw new Error(`No access to "${String(processor)}" for ${APP.name}`);
    celler.grant(String(processor), on === true);
    send('processors', granted());
    return celler.grants();
  });
  // its day: nothing is held back until the person sets a limit
  desktop.handle('settings:budget', () => budgetOf());
  desktop.handle('settings:set-budget', (_e, limits: unknown) => {
    const l = (limits && typeof limits === 'object' ? limits : {}) as Record<string, unknown>;
    celler.setBudget({ tokens: Number(l.tokens), cost: Number(l.cost), minutes: Number(l.minutes) });
    appLog({ budget: celler.budget() });
    return budgetOf();
  });
  // the Electron app's question, as it starts this server: where Desktop is and the port of Vindu's pages, so that a
  // task's page may load in Desktop's frames there. At Desktop's own token, by this computer's name, and from no page (a
  // browser names the page's origin, the Electron app none)
  control = async (req, res, rest) => {
    if (rest !== 'control' || req.method !== 'POST') return false;
    const no = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (!req.url?.startsWith(`/${desktop.token}/`) || req.headers.origin !== undefined) { res.writeHead(403, no).end('{"error":"not this way"}'); return true; }
    let body = ''; for await (const c of req) { body += String(c); if (body.length > 4096) { res.writeHead(413, no).end(); return true; } }
    let answer: unknown;
    try {
      const q = JSON.parse(body || '{}') as Record<string, unknown>;
      if (q.do !== 'frame-origins') throw new Error(`no command "${String(q.do)}": frame-origins`);
      answer = { desktop: desktop.origin, pagesPort: uiProvider.pagesPort };
    } catch (e) { res.writeHead(400, no).end(JSON.stringify({ error: (e as Error).message })); return true; }
    res.writeHead(200, no).end(JSON.stringify(answer ?? null));
    return true;
  };

  async function close() {
    await uiProvider.close();
    await checker?.then(browser => browser.close()).catch(() => undefined);
    await connectors.close();
    await desktop.close();
    await celler.close();
  }

  return { userData, home, options: o, tasksFolder, readSettings, tilde, granted, ensureProcessor, harnessOf,
    celler, connectors, desktop, uiProvider, attachments, send, close };
}
