import fs from 'node:fs';
import type http from 'node:http';
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
import { startPageServer, type PageServer, type Sender } from './web.js';
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
    pageParentOrigins: (): string[] => desktopOrigins(),
    reminders: true, ...(settings.holidays ? { holidays: settings.holidays } : {}), jobs: { perDay: settings.jobs?.perDay ?? 3 } });
  const celler = openCellerHost(path.join(userData, 'celler'));
  // A new data folder grants Desktop every processor it starts with; a folder with an older policy keeps that policy.
  const hasLegacyPolicy = fs.existsSync(path.join(userData, 'senter'));
  celler.register(APP.id, hasLegacyPolicy ? [] : processors.map(harness => harness.id));
  const granted = () => processors.filter(h => celler.grants(APP.id).includes(h.id));
  const harnessName = (h: string) => processors.find(x => x.id === h)?.name ?? h;
  // the core's network side (network.ts): its pages on the person's tailnet once they turn it on, and the devices paired
  let network: Network | undefined;
  /** Where Desktop's page is, as it names itself: this computer's, the tailnet's and the Wi-Fi's. Vindu's pages take these
   *  as the parents that may frame them. */
  const desktopOrigins = () => [`http://localhost:${desktop.port}`, `http://127.0.0.1:${desktop.port}`, ...(network?.names() ?? []).map(n => `https://${n}:${desktop.port}`),
    ...(network?.lan() ?? []).map(n => `https://${n}:${desktop.port}`)];
  // the desktop apps' links: the one that started this core, and those of the person's other computers paired with it
  const links = frameLinks(); if (o.frame) links.add(o.frame);
  // what the core did, for the person: kept in shell.jsonl, the name it has had since the core had a shell of its own
  const coreLog = (e: Record<string, unknown>) => fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`, { mode: 0o600 }, () => undefined);
  // Vindu's pages on the person's other devices: a door to each task's origin, on the Wi-Fi and the tailnet as the core's
  // pages are, through which a page there is told Vindu's addresses (page-doors.ts); here they are reached as they are
  const doors = pageDoors({ hostPort: uiProvider.pagesPort, devices: () => network?.devices.list().map(d => d.id) ?? [], names: () => network?.names() ?? [], lan: () => network?.lan() ?? [],
    changed: async () => network?.refresh(), log: e => coreLog(e) });
  /** Where Vindu's pages are framed from, and their pictures and sounds: this computer's loopback, and the doors at the
   *  core's names elsewhere (an IPv6 address a policy cannot name, and a browser would only warn of, left out). */
  const pagesAt = () => ['http://*.localhost:*', ...(network?.names() ?? []).map(n => `https://${n}:*`), ...(network?.lan() ?? []).filter(n => !n.startsWith('[')).map(n => `https://${n}:*`)].join(' ');
  let control: ((req: http.IncomingMessage, res: http.ServerResponse, rest: string) => Promise<boolean>) | undefined;
  // Desktop's page, the one the person opens (in a browser, or the desktop app's window), at the core's port: its pairing
  // page with no token, a paired computer's desktop app's link at a device's token, and the person's own commands here
  const desktop: PageServer = await startPageServer({ name: APP.id, port: o.port ?? 7300, token: keptToken(tokens, APP.id), page: path.join(STATIC, 'index.html'),
    files: { 'renderer.bundle.js': path.join(BUILT, 'renderer.bundle.js'), 'renderer.bundle.css': path.join(BUILT, 'renderer.bundle.css'), 'sw.js': path.join(STATIC, 'sw.js') },
    app: { name: APP.name, icon: ICON, theme: '#f6f5f1', background: '#fcfcfb' },
    names: () => network?.names() ?? [], lan: () => network?.lan() ?? [], devices: t => network?.devices.of(t)?.id,
    open: (req, res, rest, origin) => network?.pairPage(req, res, rest, origin) ?? false,
    links: (device, ch) => { links.add(linkOver(ch)); coreLog({ link: device }); },
    csp: () => `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${pagesAt()}; media-src ${pagesAt()}; frame-src ${pagesAt()}; connect-src 'none'; form-action 'none'; base-uri 'none'`,
    away: (via, v) => doors.through(via, v),
    routes: async (req, res, rest) => (await control?.(req, res, rest)) || attachments.dropped(req, res, rest, desktop.origin) });
  const send = (channel: string, ...a: unknown[]) => { desktop.send(channel, ...a); };
  network = startNetwork({ userData, ports: () => [desktop.port, ...doors.ports()],
    revoked: device => { desktop.revokeDevice(device); doors.revokeDevice(device); },
    ...(o.tailscale !== undefined ? { cli: o.tailscale } : {}), ...(o.push ? { push: o.push } : {}),
    ...(o.lan !== undefined ? { lan: o.lan } : {}), ...(o.lanAddresses ? { lanAddresses: o.lanAddresses } : {}), ...(o.lanName ? { lanName: o.lanName } : {}),
    log: e => coreLog({ network: e }) });
  const harnessOf = (value: unknown): string => {
    const harness = processors.find(item => item.id === value);
    if (!harness) throw new Error('Choose an available processor.');
    return harness.id;
  };
  /** A turn of Desktop's runs only on a processor ticked for it in Settings, and within its day's budget. */
  const ensureProcessor = (harness: string) => {
    if (!celler.grants(APP.id).includes(harness)) {
      throw new Error(`${harnessName(harness)} is not one of ${APP.name}'s processors: check Processors in Settings`);
    }
    const reason = celler.over(APP.id);
    if (reason) throw new Error(reason);
  };
  const budgetOf = () => {
    const over = celler.over(APP.id);
    return { limits: celler.budget(APP.id), spent: celler.spent(APP.id), ...(over ? { over } : {}) };
  };
  // Settings: Processors (the harnesses Desktop may use, the connectors each task chooses from, its day's budget) are set
  // on this computer, or on one of the person's owner devices; any other device is refused, whatever its page shows
  const may = (via: Sender['via']) => (via?.device ? !!network?.devices.owner(via.device) : !via?.away);
  const setsUp = (e: { sender: Pick<Sender, 'via'> }) => { if (!may(e.sender.via)) throw new Error('what Vindu may use is set on the computer vindu runs on, or on a device paired as its owner'); };
  desktop.handle('settings:state', e => ({ host: os.hostname().replace(/\.local$/i, ''), device: e.sender.via?.device ?? null, away: !!e.sender.via?.away, setsUp: may(e.sender.via) }));
  desktop.handle('settings:processors', e => (setsUp(e), { processors, granted: celler.grants(APP.id),
    connectors: availableConnectors().connectors.map(c => ({ name: c.name, title: c.title })) }));
  desktop.handle('settings:grant', (e, processor: unknown, on: unknown) => {
    setsUp(e);
    if (!processors.some(h => h.id === processor)) throw new Error(`No access to "${String(processor)}" for ${APP.name}`);
    celler.grant(APP.id, String(processor), on === true);
    send('processors', granted());
    return celler.grants(APP.id);
  });
  // its day: nothing is held back until the person sets a limit
  desktop.handle('settings:budget', e => (setsUp(e), budgetOf()));
  desktop.handle('settings:set-budget', (e, limits: unknown) => {
    setsUp(e);
    const l = (limits && typeof limits === 'object' ? limits : {}) as Record<string, unknown>;
    celler.setBudget(APP.id, { tokens: Number(l.tokens), cost: Number(l.cost), minutes: Number(l.minutes) });
    coreLog({ budget: APP.id, limits: celler.budget(APP.id) });
    return budgetOf();
  });
  // Phone: the core on the person's tailnet, devices paired by a code, and their notifications (network.ts). What sets it
  // up answers this computer's own pages only; a device gives only its own subscription.
  desktop.handle('settings:phone', e => { requireLocalDesktop(e); return network!.state(); });
  desktop.handle('settings:phone-serve', async (e, on: unknown) => { requireLocalDesktop(e); const r = await network!.serve(on === true); return { ...r, state: await network!.state() }; });
  desktop.handle('settings:phone-code', (e, q: unknown) => { requireLocalDesktop(e); return network!.devices.newCode({ owner: (q as { owner?: unknown } | undefined)?.owner === true }); }); // owner: that device sets Processors too
  desktop.handle('settings:phone-remove', (e, id: unknown) => { requireLocalDesktop(e); network!.devices.remove(String(id)); return network!.devices.list(); });
  desktop.handle('settings:device', e => { const d = e.sender.via?.device; if (!d) return null; network!.devices.seen(d); const x = network!.devices.list().find(y => y.id === d); return x ? { name: x.name, push: x.push, key: network!.pushKey() } : null; });
  desktop.handle('settings:push', (e, sub: unknown) => { const d = e.sender.via?.device; if (!d) throw new Error('notifications are for a paired device'); return network!.subscribe(d, sub); });
  // the person's own commands here (main.ts --pair, --tailnet, --lan, --status), as Phone gives them, where no one opens
  // Desktop on this computer (a Pi's): at Desktop's own token, never a device's, by this computer's name, and from no page
  // (a browser names the page's origin, a command none)
  const command = async (q: Record<string, unknown>) => {
    if (q.do === 'frame-origins') return { desktop: desktop.origin, pagesPort: uiProvider.pagesPort };
    if (q.do === 'code') { // where to type it: on the tailnet, once served there, and on the Wi-Fi, while on there
      const c = network!.devices.newCode({ owner: q.owner === true }), s = await network!.state();
      return { ...c, step: s.step, serving: s.serving, at: s.serving && s.address ? `${s.address}/pair` : null, lanAt: s.lan.address ? `${s.lan.address}/pair` : null };
    }
    if (q.do === 'tailnet') { const r = await network!.serve(q.on === true); const { code: _c, push: _p, ...s } = await network!.state(); return { ...r, state: s }; }
    if (q.do === 'lan') { const r = await network!.lanServe(q.on === true); const { code: _c, push: _p, ...s } = await network!.state(); return { ...r, state: s }; }
    if (q.do === 'state') { const { code: _c, push: _p, ...s } = await network!.state(); return s; }
    throw new Error(`no command "${String(q.do)}": code, tailnet, lan or state`);
  };
  control = async (req, res, rest) => {
    if (rest !== 'control' || req.method !== 'POST') return false;
    const no = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (!req.url?.startsWith(`/${desktop.token}/`) || req.headers.origin !== undefined) { res.writeHead(403, no).end('{"error":"not this way"}'); return true; }
    let body = ''; for await (const c of req) { body += String(c); if (body.length > 4096) { res.writeHead(413, no).end(); return true; } }
    let answer: unknown;
    try { answer = await command(JSON.parse(body || '{}') as Record<string, unknown>); }
    catch (e) { res.writeHead(400, no).end(JSON.stringify({ error: (e as Error).message })); return true; }
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
    celler, connectors, desktop, network, links, doors, uiProvider, attachments, send, close };
}
