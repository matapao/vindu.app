import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, type Browser } from 'playwright-core';
import { startVindu } from '@matapao/vindu/server';
import { playwrightDriver } from '@matapao/vindu/playwright';
import { openCellerHost } from './celler-host.js';
import { appDataDir, locale } from './os.js';
import { startNetwork, type Network } from './network.js';
import { frameLinks, linkOver } from './frame-link.js';
import { pageDoors } from './page-doors.js';
import { startShell } from './shell.js';
import { startPageServer, type PageServer } from './web.js';
import { keptToken, upgradePageCredentials } from './page-credentials.js';
import { desktopConnectors } from './desktop-connectors.js';
import { desktopFiles } from './desktop-files.js';
import { APP, STATIC, BUILT, ICON, type AppOptions, type Settings } from './desktop-settings.js';

/** Local desktop gestures authorize device and setup operations. */
export function requireLocalDesktop(event: { sender: { via?: { away?: boolean; device?: string } } }) {
  if (event.sender.via?.device || event.sender.via?.away) {
    throw new Error('this is set up on the computer vindu runs on');
  }
}

export type DesktopHost = Awaited<ReturnType<typeof openDesktopHost>>;

export async function openDesktopHost(o: AppOptions) {
  const processors = o.processors ?? [];
  const userData = o.userData ?? appDataDir('desktop'); // where Electron kept it before: the same settings, templates and tasks
  const tokens = path.join(userData, 'pages.json'), logFile = path.join(userData, 'shell.jsonl');
  await upgradePageCredentials(tokens, logFile);
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
  // one (a Pi 3's core has none) shows its pages all the same, and each check says it could not run here; it is tried
  // again the next time, so a Chromium installed later is used without a restart
  let checker: Promise<Browser> | undefined;
  const checkBrowser = () => (checker ??= (o.pageBrowser ?? (() => chromium.launch({ headless: true })))().catch((e: unknown) => {
    checker = undefined; const said = String((e as Error)?.message ?? e);
    throw new Error(/doesn't exist|not installed|playwright install/i.test(said) ? 'this computer has no browser to check pages in (Playwright\'s Chromium is not installed here)'
      : `the browser to check pages in would not start here: ${said.split('\n')[0]}`);
  }));
  const driver = { open: async (url: string, viewport: { width: number; height: number }) => playwrightDriver(await checkBrowser()).open(url, viewport) };
  const uiProvider = await startVindu({ driver, verifyMs: 1500, apps: settings.apps ?? 'off', appsNetwork: settings.appsNetwork, locale: locale(), asks: 'host',
    pageParentOrigins: (): string[] => shellOrigins().flatMap(origin => {
      const app = new URL(origin); app.port = String(desktop.port);
      return [origin, app.origin];
    }),
    reminders: true, ...(settings.holidays ? { holidays: settings.holidays } : {}), jobs: { perDay: settings.jobs?.perDay ?? 3 } });
  const celler = openCellerHost(path.join(userData, 'celler'));
  // New workspaces grant the processors registered by the consuming app; existing policy stays in force.
  const hasLegacyPolicy = fs.existsSync(path.join(userData, 'senter'));
  celler.register(APP.id, hasLegacyPolicy ? [] : processors.map(harness => harness.id));
  const granted = () => processors.filter(h => celler.grants(APP.id).includes(h.id));
  const harnessName = (h: string) => processors.find(x => x.id === h)?.name ?? h;
  // the core's network side (network.ts): its pages on the person's tailnet once they turn it on, and the devices paired
  let network: Network | undefined;
  let shellAt = o.port ?? 7300; // the shell's port, once it listens (another, when that one is taken)
  const shellPort = () => shellAt;
  /** Where the shell is, as each page that may be framed by it names it: this computer's, the tailnet's and the Wi-Fi's. */
  const shellOrigins = () => [`http://localhost:${shellPort()}`, `http://127.0.0.1:${shellPort()}`, ...(network?.names() ?? []).map(n => `https://${n}:${shellPort()}`),
    ...(network?.lan() ?? []).map(n => `https://${n}:${shellPort()}`)];
  // the desktop apps' links: the one that started this core, and those of the person's other computers paired with it
  const links = frameLinks(); if (o.frame) links.add(o.frame);
  const shellLog = (e: Record<string, unknown>) => fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`, { mode: 0o600 }, () => undefined);
  // Vindu's pages on the person's other devices: a door to each task's origin, on the Wi-Fi and the tailnet as the core's
  // pages are, through which a page there is told Vindu's addresses (page-doors.ts); here they are reached as they are
  const doors = pageDoors({ hostPort: uiProvider.pagesPort, devices: () => network?.devices.list().map(d => d.id) ?? [], names: () => network?.names() ?? [], lan: () => network?.lan() ?? [],
    changed: async () => network?.refresh(), log: e => shellLog(e) });
  /** Where Vindu's pages are framed from, and their pictures and sounds: this computer's loopback, and the doors at the
   *  core's names elsewhere (an IPv6 address a policy cannot name, and a browser would only warn of, left out). */
  const pagesAt = () => ['http://*.localhost:*', ...(network?.names() ?? []).map(n => `https://${n}:*`), ...(network?.lan() ?? []).filter(n => !n.startsWith('[')).map(n => `https://${n}:*`)].join(' ');
  // Desktop's page, and whether the person can see it now (its tab in front, in the window they are in), as it says
  const desktop: PageServer = await startPageServer({ name: APP.id, port: (o.port ?? 7300) + 1, token: keptToken(tokens, APP.id), page: path.join(STATIC, 'index.html'),
    files: { 'renderer.bundle.js': path.join(BUILT, 'renderer.bundle.js'), 'renderer.bundle.css': path.join(BUILT, 'renderer.bundle.css') }, app: { name: APP.name, icon: ICON, theme: '#f6f5f1', background: '#fcfcfb' },
    names: () => network?.names() ?? [], lan: () => network?.lan() ?? [], frameAncestors: () => shellOrigins(), devices: t => network?.devices.of(t)?.id,
    csp: () => `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${pagesAt()}; media-src ${pagesAt()}; frame-src ${pagesAt()}; connect-src 'none'; form-action 'none'; base-uri 'none'`,
    away: (via, v) => doors.through(via, v),
    routes: (req, res, rest) => attachments.dropped(req, res, rest, desktop.origin) });
  const send = (channel: string, ...a: unknown[]) => { desktop.send(channel, ...a); };
  const appShell = await startShell({ token: keptToken(tokens, 'shell'), port: o.port ?? 7300, log: shellLog,
    names: () => network?.names() ?? [], lan: () => network?.lan() ?? [], devices: t => network?.devices.of(t)?.id, owner: d => network?.devices.owner(d) ?? false, open: (req, res, rest, origin) => network?.pairPage(req, res, rest, origin) ?? false,
    links: (device, ch) => { links.add(linkOver(ch)); shellLog({ link: device }); },
    // the person's own commands here (main.ts --pair, --tailnet, --lan, --status), as Phone gives them, where no one
    // opens the shell on this computer (a Pi's): a code to pair a device with, and the core on their tailnet or their
    // Wi-Fi, or off them
    control: async q => {
      if (q.do === 'frame-origins') return { desktop: desktop.origin, pagesPort: uiProvider.pagesPort };
      if (q.do === 'code') { // where to type it: on the tailnet, once served there, and on the Wi-Fi, while on there
        const c = network!.devices.newCode({ owner: q.owner === true }), s = await network!.state();
        return { ...c, step: s.step, serving: s.serving, at: s.serving && s.address ? `${s.address}/pair` : null, lanAt: s.lan.address ? `${s.lan.address}/pair` : null };
      }
      if (q.do === 'tailnet') { const r = await network!.serve(q.on === true); const { code: _c, push: _p, ...s } = await network!.state(); return { ...r, state: s }; }
      if (q.do === 'lan') { const r = await network!.lanServe(q.on === true); const { code: _c, push: _p, ...s } = await network!.state(); return { ...r, state: s }; }
      if (q.do === 'state') { const { code: _c, push: _p, ...s } = await network!.state(); return { ...s, apps: appShell.apps().map(a => a.name) }; }
      throw new Error(`no command "${String(q.do)}": code, tailnet, lan or state`);
    },
    own: () => [{ ...APP, icon: ICON, url: desktop.url, about: 'Tasks with an agent, in views, pages and terminals you share with it', color: '#2a78d6' }],
    connectors: () => availableConnectors().connectors.map(c => ({ id: `connector:${c.name}`, name: c.title })),
    processors: () => processors.map(h => ({ ...h, kind: 'harness', where: [], models: [] })),
    grants: () => ({ [APP.id]: celler.grants(APP.id) }),
    grant: (id, processor, on) => {
      if (id !== APP.id || !processors.some(h => h.id === processor)) throw new Error(`No access to "${processor}" for that app`);
      celler.grant(id, processor, on);
      send('processors', granted());
    },
  });
  shellAt = appShell.page.port;
  network = startNetwork({ userData, ports: () => [appShell.page.port, desktop.port, ...doors.ports()],
    revoked: device => { desktop.revokeDevice(device); appShell.page.revokeDevice(device); doors.revokeDevice(device); },
    ...(o.tailscale !== undefined ? { cli: o.tailscale } : {}), ...(o.push ? { push: o.push } : {}),
    ...(o.lan !== undefined ? { lan: o.lan } : {}), ...(o.lanAddresses ? { lanAddresses: o.lanAddresses } : {}), ...(o.lanName ? { lanName: o.lanName } : {}),
    log: e => shellLog({ network: e }), changed: () => { appShell.changed(); } });
  const harnessOf = (value: unknown): string => {
    const harness = processors.find(item => item.id === value);
    if (!harness) throw new Error('Choose an available processor.');
    return harness.id;
  };
  /** A turn of Desktop's runs only on a processor ticked for it under Processors, and within its day's budget. */
  const ensureProcessor = (harness: string) => {
    if (!celler.grants(APP.id).includes(harness)) {
      throw new Error(`${harnessName(harness)} is not one of ${APP.name}'s processors: check Processors in the shell`);
    }
    const reason = celler.over(APP.id);
    if (reason) throw new Error(reason);
  };
  const budgetOf = (app: string) => {
    const over = celler.over(app);
    return { limits: celler.budget(app), spent: celler.spent(app), ...(over ? { over } : {}) };
  };
  // Processors: each app's budget, set by the person; nothing is held back until they set one
  appShell.page.handle('shell:budgets', e => (appShell.setsUp(e), appShell.apps().map(a => ({ app: a.id, name: a.name, ...budgetOf(a.id) }))));
  appShell.page.handle('shell:budget', (e, app: unknown, limits: unknown) => {
    appShell.setsUp(e);
    const a = appShell.apps().find(x => x.id === app); if (!a) throw new Error(`no app "${String(app)}"`);
    const l = (limits && typeof limits === 'object' ? limits : {}) as Record<string, unknown>;
    celler.setBudget(a.id, { tokens: Number(l.tokens), cost: Number(l.cost), minutes: Number(l.minutes) });
    shellLog({ budget: a.id, limits: celler.budget(a.id) });
    return { app: a.id, name: a.name, ...budgetOf(a.id) };
  });
  // the shell's Phone: the core on the person's tailnet, devices paired by a code, and their notifications (network.ts).
  // What sets it up answers this computer's own pages only; a device gives only its own subscription.
  appShell.page.handle('shell:phone', e => { requireLocalDesktop(e); return network!.state(); });
  appShell.page.handle('shell:phone-serve', async (e, on: unknown) => { requireLocalDesktop(e); const r = await network!.serve(on === true); return { ...r, state: await network!.state() }; });
  appShell.page.handle('shell:phone-code', (e, q: unknown) => { requireLocalDesktop(e); return network!.devices.newCode({ owner: (q as { owner?: unknown } | undefined)?.owner === true }); }); // owner: that device sets Processors too
  appShell.page.handle('shell:phone-remove', (e, id: unknown) => { requireLocalDesktop(e); network!.devices.remove(String(id)); return network!.devices.list(); });
  appShell.page.handle('shell:device', e => { const d = e.sender.via?.device; if (!d) return null; network!.devices.seen(d); const x = network!.devices.list().find(y => y.id === d); return x ? { name: x.name, push: x.push, key: network!.pushKey() } : null; });
  appShell.page.handle('shell:push', (e, sub: unknown) => { const d = e.sender.via?.device; if (!d) throw new Error('notifications are for a paired device'); return network!.subscribe(d, sub); });

  async function close() {
    await uiProvider.close();
    await checker?.then(browser => browser.close()).catch(() => undefined);
    await connectors.close();
    await appShell.close();
    await desktop.close();
    await celler.close();
  }

  return { userData, home, options: o, tasksFolder, readSettings, tilde, granted, ensureProcessor, harnessOf,
    celler, connectors, desktop, appShell, network, links, doors, uiProvider, attachments, send, close };
}
