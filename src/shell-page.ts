// The shell's page: its bar, the apps' grid, Processors and Phone. Everything it shows is set as text, never as markup.
// The grid is a card for each app: its logo (its own, from its app.json; or its initials on its colour when it has none to
// show), its name and its line, whether its page is up, and the harnesses ticked for it; on a phone, a home screen of logos.
// In the desktop app's window, and where there are no tabs (installed, as on a phone's Home Screen, or a narrow window),
// an app opens here: a tab of its own in the bar, its page in a frame under it, kept as it is while another app is in
// front, and popped out to a window of its own when the person wants it beside another. An app whose page lets no frame
// show it opens in a window (or a tab) of its own instead. A link to an app comes in this page's address (#open=<app>&
// link=…, as the desktop app sends it) and opens the app's tab with the link in its address's fragment. The core is told
// where the app in front is in this window, so a live browser pane of its lands over its pane.
// In a browser, a click on an app opens its tab at once (within the click, so the browser lets it), and then sends that
// tab to the app's address once the app is up; a tab of the app's that is open already comes to the front instead.
// On a paired device, Phone turns on its notifications (the service worker). Processors shows where the core says this page
// may set it: on its own computer, or on one of the person's owner devices; the core refuses it anywhere else.
// At a phone's width the grid is a home screen, four logos in a row, and Processors, Phone and the menu of the app in
// front (load it again, in a window of its own, close it) come up as sheets from the bottom, over it; a tap outside,
// Done, Escape or a pull down puts them away. A table there is a card for each row, each cell under its column's name.
// The first time a paired phone opens vindu in its browser, the home says how to keep it on the Home Screen.
import { connect } from './socket.js';

type App = { id: string; name: string; icon: string; processors: 'granted' | 'own'; connectors?: 'granted' | 'none' | 'per-task'; folder?: boolean;
  about?: string; color?: string; running?: boolean; uses?: string[] };
type Processor = { id: string; name: string; kind?: 'harness' | 'model'; where: string[]; models: string[]; note?: string; harness?: string; model?: string; endpoint?: string; key?: 'set' | 'missing' };
type Connector = { id: string; name: string };
type Grants = Record<string, string[]>;
type Budget = { app: string; name: string; limits: { tokens?: number; cost?: number; minutes?: number }; spent: { tokens: number; cost: number; minutes: number; currency?: string }; over?: string };

const shell = connect();
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
let apps: App[] = [], page: 'apps' | 'processors' | 'phone' = 'apps', device: string | null = null, inApp = false, host = '', overTailnet = false, setsUp = false;
let appSheet = false; // the menu of the app in front, at a phone's width
/** A phone's width, or a window as narrow: the home screen, and sheets. */
const phoneSized = matchMedia('(max-width: 700px)'), installed = matchMedia('(display-mode: standalone)');
/** Whether apps open here, in this window: the desktop app's (one window), or no tabs to open them in (installed, as on a
 *  phone's Home Screen), or a screen too small for them. A browser on a computer keeps its own tabs. */
const here = () => inApp || installed.matches || phoneSized.matches;
const tabs = new Map<string, Window>(); // each app's tab of the browser's, as this page opened it
/** Each app open here: its frame, its tab in the bar, and its address; and the one in front (none: the shell's own pages). */
const opened = new Map<string, { frame: HTMLIFrameElement; tab: HTMLElement; url: string }>(), opening = new Set<string>();
let front: string | null = null;
const withLink = (url: string, link?: string) => (link ? `${url.replace(/#.*$/s, '')}#vindu-link=${encodeURIComponent(link)}` : url);

function note(text: string) { const n = $('note'); n.textContent = text; n.hidden = !text; }

/** An app here: its tab, the one open (with the link, if one came) or a new one, at its address as this page reaches it; one
 *  whose page lets no frame show it, in a window (or a tab) of its own. */
async function openHere(a: App, link?: string) {
  note('');
  const was = opened.get(a.id);
  if (was) { if (link) was.frame.src = withLink(was.url, link); show(a.id); return; }
  // popped out: its window comes forward; in the desktop app, by a window it takes as that word (vindu-forward-<app>), since
  // a window's own focus brings back no minimized one
  const out = tabs.get(a.id); if (out && !out.closed && !link) { if (inApp) window.open('', `vindu-forward-${a.id}`); else out.focus(); return; }
  if (opening.has(a.id)) return; opening.add(a.id);
  try {
    const r = await shell.invoke('shell:open-here', a.id) as { url: string; frame: boolean };
    if (!r.frame) { const w = window.open(withLink(r.url, link), `vindu-app-${a.id}`); if (w) tabs.set(a.id, w); else note(`${a.name} opens in a window of its own, which was not let open: allow pop-ups for this page.`); return; }
    const frame = el('iframe'); frame.title = a.name; frame.allow = 'clipboard-write; fullscreen'; frame.dataset.app = a.id; frame.src = withLink(r.url, link);
    const tab = el('div', undefined, 'tab'); tab.setAttribute('role', 'tab'); tab.dataset.app = a.id; tab.title = a.name;
    const icon = el('img'); icon.alt = ''; icon.addEventListener('error', () => { icon.src = initials(a); }, { once: true }); icon.src = a.icon || initials(a);
    const out = el('button', '↗'); out.type = 'button'; out.title = `${a.name} in a window of its own`;
    const shut = el('button', '×'); shut.type = 'button'; shut.title = `Close ${a.name}`;
    tab.append(icon, el('span', a.name, 'name'), ...(device ? [] : [out]), shut);
    tab.addEventListener('click', e => { if (e.target === out) popOut(a.id); else if (e.target === shut) closeHere(a.id); else show(a.id); });
    opened.set(a.id, { frame, tab, url: r.url }); $('frames').append(frame); $('tabs').append(tab);
    show(a.id);
  } catch (e) { note(`${a.name} did not open: ${(e as Error).message}`); }
  finally { opening.delete(a.id); }
}
/** One app in front, or the shell's own pages (none): the others' frames hidden, as they are. */
function show(id: string | null) {
  front = id && opened.has(id) ? id : null; appSheet = false;
  for (const [k, o] of opened) { o.frame.hidden = k !== front; o.tab.setAttribute('aria-selected', String(k === front)); }
  $('frames').hidden = !front;
  const named = front ? apps.find(a => a.id === front)?.name ?? front : '';
  document.title = !front ? 'vindu' : named.toLowerCase() === 'vindu' ? named : `${named} · vindu`; // an app named as the shell is: its name once
  draw(); where();
}
/** Where the app in front is in this window, for the core: a live browser pane of its lands over its pane here. */
function where() {
  const o = front ? opened.get(front) : undefined, r = $('frames').getBoundingClientRect();
  shell.post('shell:frames', o ? [{ origin: new URL(o.url).origin, x: r.left, y: r.top, w: r.width, h: r.height }] : []);
}
function closeHere(id: string) {
  const o = opened.get(id); if (!o) return;
  o.frame.remove(); o.tab.remove(); opened.delete(id);
  if (front === id) show([...opened.keys()].at(-1) ?? null); else draw();
}
/** An app to a window of its own (the desktop app's), beside the rest: its tab here closes. */
function popOut(id: string) {
  const o = opened.get(id); if (!o) return;
  const w = window.open(o.url, `vindu-app-${id}`); if (!w) { note('The window was not let open: allow pop-ups for this page.'); return; }
  tabs.set(id, w); closeHere(id);
}
/** An app: here, or in a tab of the browser's own, the one open already or a new one, sent to the app's address once it is up. */
function open(a: App) {
  if (here()) { void openHere(a); return; }
  note('');
  const was = tabs.get(a.id);
  if (was && !was.closed) { was.focus(); return; }
  const tab = window.open('', `vindu-app-${a.id}`);
  if (!tab) { note(`The browser did not let this page open a tab for ${a.name}: allow pop-ups for this page, then click it again.`); return; }
  let fresh = true; try { fresh = tab.location.href === 'about:blank'; } catch { fresh = false; } // a tab of the app's already: not this page's to read
  tabs.set(a.id, tab);
  if (!fresh) { tab.focus(); return; }
  try { tab.document.title = a.name; tab.document.body.textContent = `Opening ${a.name}…`; tab.document.body.style.cssText = 'font:15px system-ui,sans-serif;padding:24px;color:#898781'; } catch { /* not ours to draw */ }
  void shell.invoke('shell:open', a.id).then((url: string) => { tab.location.href = url; }, (e: Error) => { tab.close(); note(`${a.name} did not open: ${e.message}`); });
}

/** An app's colour: its own (app.json's color), or one its id gives it, the same each time. */
function tintOf(a: App): string {
  if (a.color && /^#(?:[0-9a-f]{3}){1,2}$/i.test(a.color)) return a.color;
  let h = 0; for (const c of a.id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 58% 48%)`;
}
/** A logo for an app that has none to show: its initials on its colour, as a drawing. */
function initials(a: App): string {
  const letters = a.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => [...w][0]!.toUpperCase()).join('') || '?';
  const text = letters.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${tintOf(a)}"/><text x="32" y="41.5" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="25" font-weight="600" fill="#fff" text-anchor="middle">${text}</text></svg>`)}`;
}
/** An app's card on the grid: its logo, its name, its line, whether its page is up, and what it may use. */
function tile(a: App): HTMLElement {
  const b = el('button', undefined, 'app'); b.type = 'button'; b.dataset.app = a.id; b.dataset.running = String(!!a.running); b.title = `Open ${a.name}`;
  b.style.setProperty('--tint', tintOf(a));
  const logo = el('div', undefined, 'logo'), icon = el('img'); icon.alt = ''; icon.addEventListener('error', () => { icon.src = initials(a); }, { once: true }); icon.src = a.icon || initials(a);
  logo.append(icon);
  const meta = el('div', undefined, 'meta'), up = el('div', a.running ? 'Running' : 'Starts on open', 'chip up');
  up.title = a.running ? `${a.name}'s page is up` : `${a.name}'s server starts when you open it`;
  const uses = a.processors === 'own' ? el('div', 'Its own harnesses', 'chip') : a.uses?.length ? el('div', a.uses.join(' · '), 'chip') : el('div', 'No harness', 'chip none');
  uses.title = a.processors === 'own' ? `${a.name} starts its harnesses itself` : a.uses?.length ? `What ${a.name} may use: ticked under Processors` : `Tick a harness for ${a.name} under Processors${device ? ', on the computer vindu runs on' : ''}`;
  meta.append(up, uses);
  b.append(logo, el('span', a.name), ...(a.about ? [el('small', a.about)] : []), meta);
  b.addEventListener('click', () => open(a));
  return b;
}

function draw() {
  const sheet = phoneSized.matches && !front && page !== 'apps'; // Processors or Phone over the home, at a phone's width
  $('title').textContent = page === 'processors' ? 'Processors' : page === 'phone' ? 'Phone' : 'Apps';
  $('home').setAttribute('aria-pressed', String(!front && (page === 'apps' || sheet)));
  $('procs').setAttribute('aria-pressed', String(!front && page === 'processors'));
  $('phones').setAttribute('aria-pressed', String(!front && page === 'phone'));
  $('procs').hidden = $('procs-here').hidden = !setsUp; // what each app may use is set on the computer, or on an owner device
  $('apps').hidden = !!front || (page !== 'apps' && !sheet); // an app in front: the shell's own pages wait behind it
  $('none').hidden = apps.length > 0;
  $('host').textContent = host ? `On ${host}${overTailnet ? ', over your tailnet' : ''}` : '';
  $('processors').hidden = !!front || page !== 'processors';
  $('phone').hidden = !!front || page !== 'phone';
  $('app-menu').hidden = !front;
  drawAppSheet();
  $('scrim').hidden = !sheet && $('app-sheet').hidden;
  document.body.toggleAttribute('data-open', opened.size > 0); // at a phone's width, the bar shows the apps open here
  welcome();
  const find = $<HTMLInputElement>('find'), q = find.value.trim().toLowerCase(); find.hidden = apps.length <= 8; // a find box once there are many
  $('grid').replaceChildren(...apps.filter(a => !q || `${a.name} ${a.about ?? ''}`.toLowerCase().includes(q)).map(tile));
}
/** The menu of the app in front, at a phone's width: its logo, its name and how it is, and what to do with it. */
function drawAppSheet() {
  const a = front ? apps.find(x => x.id === front) : undefined;
  $('app-sheet').hidden = !appSheet || !a || !phoneSized.matches;
  if (!a || $('app-sheet').hidden) return;
  const icon = $<HTMLImageElement>('app-sheet-icon'); icon.onerror = () => { icon.onerror = null; icon.src = initials(a); }; icon.src = a.icon || initials(a);
  $('app-sheet-name').textContent = a.name;
  $('app-sheet-line').textContent = `${a.running ? 'Running' : 'Not running'} · ${a.processors === 'own' ? 'its own harnesses' : a.uses?.length ? a.uses.join(', ') : 'no harness ticked'}`;
  $('app-out').hidden = !!device; // as the bar's tab: a device's browser keeps no window of the app's own for it
  $('app-close-name').textContent = `Close ${a.name}`;
}
/** A sheet away: the app's menu, or Processors or Phone, back to the home. */
function closeSheet() {
  if (appSheet) appSheet = false; else if (page !== 'apps') page = 'apps';
  draw();
}
/** A paired phone's first look, in its browser: how to keep vindu on its Home Screen, until the person says Done. */
function welcome() {
  let done = false; try { done = localStorage.getItem('vindu-welcome') === 'done'; } catch { /* nothing kept here: it shows */ }
  const on = !!device && !installed.matches && !done && (phoneSized.matches || matchMedia('(pointer: coarse)').matches);
  $('welcome').hidden = !on; if (!on) return;
  const ua = navigator.userAgent, ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  $('welcome-how').textContent = ios ? 'In Safari, tap Share, then Add to Home Screen. vindu then opens like an app, from its own icon.'
    : /Android/.test(ua) ? 'In your browser\'s menu, tap Add to Home screen, or Install app. vindu then opens like an app, from its own icon.'
    : 'Your browser\'s menu can add this page to your Home Screen, or install it as an app. vindu then opens like one, from its own icon.';
}

async function processors() {
  const p = await shell.invoke('shell:processors') as { processors: Processor[]; connectors: Connector[]; apps: App[]; grants: Grants };
  const harnessOf = (x: Processor) => p.processors.find(h => h.id === x.harness)?.name ?? x.harness ?? '';
  $('list').replaceChildren(...p.processors.map(x => {
    const card = el('div', undefined, x.kind === 'model' ? 'proc model' : 'proc'); card.dataset.processor = x.id;
    if (x.kind === 'model') { // a model at an endpoint, on its key, run by the harness it is attached to
      card.append(el('b', x.name), el('div', `On ${harnessOf(x)}: the model ${x.model} at ${x.endpoint}`), el('div', `Runs in: ${x.where.join(', ') || 'nowhere yet'}`),
        el('div', x.key === 'set' ? 'Its key: kept in the core; the harness never has it' : 'Its key: not set. Its settings say where it is (keyEnv, keyFile)', x.key === 'set' ? undefined : 'note'));
    } else card.append(el('b', x.name), el('div', `Runs in: ${x.where.join(', ') || 'nowhere yet'}`), el('div', `Its model: ${x.models.join(', ')}`));
    if (x.note) card.append(el('div', x.note, 'note'));
    return card;
  }));
  // the connectors the person set up, as columns of their own, for the apps that ask for connectors
  const column = (x: Processor) => (x.kind === 'model' ? `${x.name} (on ${harnessOf(x)})` : x.name); // a cell's label at a phone's width, where each row is a card
  const head = el('tr'); head.append(el('th', 'App'), ...p.processors.map(x => { const h = el('th', column(x)); if (x.kind === 'model') h.title = `The model ${x.model} at ${x.endpoint}, on ${harnessOf(x)}: its key stays in the core`; return h; }), ...p.connectors.map(c => { const h = el('th', c.name, 'conn'); h.title = `The connector ${c.name}: its key stays in the core`; return h; }));
  $('held').textContent = 'Apps connect their own processors. Choose which ones each app can use.';
  $('head').replaceChildren(head);
  const tick = (a: App, id: string, label: string, column: string, grants: Grants) => {
    const cell = el('td', undefined, 'on'), box = el('input'); box.type = 'checkbox'; box.dataset.grant = id; if (!id.startsWith('connector:')) box.dataset.processor = id;
    box.checked = (grants[a.id] ?? []).includes(id); box.title = `${a.name} may use ${label}`; cell.dataset.label = column;
    box.addEventListener('change', () => { void shell.invoke('shell:grant', a.id, id, box.checked).then((g: Grants) => $('grants').replaceChildren(...rows(g)), (e: Error) => { box.checked = !box.checked; note(e.message); }); });
    cell.addEventListener('click', e => { if (e.target === cell && phoneSized.matches) box.click(); }); // a card's whole line, at a phone's width
    cell.append(box); return cell;
  };
  const labelled = <T extends HTMLElement>(label: string, cell: T): T => { cell.dataset.label = label; return cell; };
  const rows = (grants: Grants): HTMLElement[] => p.apps.map(a => {
    const row = el('tr'); row.dataset.app = a.id; row.append(el('td', a.name));
    if (a.processors === 'own') {
      const cell = labelled('Harnesses', el('td', 'Uses its own', 'own')); cell.colSpan = p.processors.length; cell.title = `${a.name} manages its own processors`;
      row.append(cell);
    } else for (const x of p.processors) {
      if (x.kind === 'model' && !a.folder) { const c = labelled(column(x), el('td', 'In its bar', 'own')); c.title = `${a.name} offers each model processor with its harness, in its bar, for you to pick for each task`; row.append(c); }
      else row.append(tick(a, x.id, x.kind === 'model' ? `the model processor ${x.name}` : x.name, column(x), grants));
    }
    if (p.connectors.length) {
      if (a.connectors === 'granted') for (const c of p.connectors) row.append(tick(a, c.id, c.name, c.name, grants));
      else { const cell = labelled('Connectors', el('td', a.connectors === 'per-task' ? 'Chosen for each task' : 'Asks for none', 'own')); cell.colSpan = p.connectors.length; row.append(cell); }
    }
    return row;
  });
  $('grants').replaceChildren(...rows(p.grants));
  await budgets();
}

/** Each app's day: what it spent today, and what it may, as the person sets it (empty: no limit). */
async function budgets() {
  const spentText = (b: Budget) => [`${Math.round(b.spent.tokens).toLocaleString()} tokens`, b.spent.cost ? `${b.spent.cost.toFixed(2)}${b.spent.currency ? ` ${b.spent.currency}` : ''}` : 'no cost reported', `${Math.round(b.spent.minutes)} min`].join(' · ');
  const row = (b: Budget): HTMLElement => {
    const tr = el('tr'); tr.dataset.app = b.app;
    const today = el('td', spentText(b), b.over ? 'over' : undefined); today.dataset.spent = ''; today.dataset.label = 'Today'; if (b.over) today.title = `Over today's budget: ${b.over}`;
    tr.append(el('td', b.name), today);
    for (const k of ['tokens', 'cost', 'minutes'] as const) {
      const cell = el('td'), box = el('input'); box.type = 'number'; box.min = '0'; box.step = k === 'cost' ? '0.01' : '1'; box.placeholder = 'no limit'; box.dataset.limit = k;
      cell.dataset.label = k === 'cost' ? 'Cost a day' : k === 'minutes' ? 'Minutes a day' : 'Tokens a day'; box.inputMode = k === 'cost' ? 'decimal' : 'numeric';
      box.value = b.limits[k] !== undefined ? String(b.limits[k]) : ''; box.title = `What ${b.name} may spend in a day: ${k === 'cost' ? 'its cost' : k === 'minutes' ? 'minutes of turns' : 'tokens'}`;
      box.addEventListener('change', () => {
        const limits = { ...b.limits, [k]: box.value === '' ? undefined : Number(box.value) };
        void shell.invoke('shell:budget', b.app, limits).then((nb: Budget) => tr.replaceWith(row(nb)), (e: Error) => note(e.message));
      });
      cell.append(box); tr.append(cell);
    }
    return tr;
  };
  $('budgets').replaceChildren(...(await shell.invoke('shell:budgets') as Budget[]).map(row));
}

type PhoneState = { step: 'install' | 'signin' | 'https' | 'ready'; host: string | null; serving: boolean; address: string | null; code: { code: string; until: number; owner?: boolean } | null;
  devices: { id: string; name: string; paired: string; seen?: string; push: boolean; owner?: boolean }[]; lan?: { on: boolean; address: string | null } };
const TAILNET: Record<PhoneState['step'], string> = {
  install: 'Tailscale is not on this computer. Install it (tailscale.com/download), on this computer and on your phone, and sign in on both with the same account.',
  signin: 'Tailscale is here, but not signed in or not running. Open it and sign in, here and on your phone, with the same account.',
  https: 'Tailscale is running. Turn on HTTPS certificates for your tailnet (in its admin console, DNS), so your phone gets an https address: a phone needs one to install vindu and to get notifications.',
  ready: '',
};
/** Phone, on this computer: Tailscale's step, serving the core there, a code to pair a device with, and the devices paired. */
async function phone() {
  if (device) { await away(); return; }
  $('away').hidden = true; $('setup').hidden = false;
  const can = 'Notification' in window, on = can && Notification.permission === 'granted';
  $('here-state').textContent = !can ? 'This browser shows no notifications.' : on ? 'Notifications on this computer are on: what needs you, from any app, shows here when vindu is not in front.' : 'Notifications on this computer are off.';
  const allow = $<HTMLButtonElement>('here-push'); allow.hidden = !can || on || Notification.permission === 'denied';
  allow.onclick = () => { void Notification.requestPermission().then(() => phone()); };
  const s = await shell.invoke('shell:phone') as PhoneState;
  drawPhone(s);
}
function drawPhone(s: PhoneState) {
  $('tailnet').textContent = s.step !== 'ready' ? TAILNET[s.step] : s.serving ? `vindu is on your tailnet at ${s.address}: the shell, and each app at a port of its own. Only devices you pair open anything there.` : `Tailscale is ready on ${s.host}. vindu is not on your tailnet yet.`;
  const serve = $<HTMLButtonElement>('serve'); serve.hidden = s.step !== 'ready'; serve.textContent = s.serving ? 'Take vindu off my tailnet' : 'Put vindu on my tailnet';
  serve.onclick = async () => {
    serve.disabled = true;
    try { const r = await shell.invoke('shell:phone-serve', !s.serving) as { ok: boolean; said?: string; link?: string; state: PhoneState }; drawPhone(r.state); if (!r.ok) note(`Tailscale said: ${r.said ?? 'no'}${r.link ? ` (open ${r.link} to allow it)` : ''}`); }
    catch (e) { note((e as Error).message); } finally { serve.disabled = false; }
  };
  // where a phone opens the pairing page: on the tailnet, once served there, and on this Wi-Fi, while vindu is on it
  const at = [s.serving && s.address ? [`${s.address}/pair`, 'your tailnet'] : [], s.lan?.on && s.lan.address ? [`${s.lan.address}/pair`, 'this Wi-Fi'] : []].filter(x => x.length);
  $('pairing').hidden = !at.length; $('pair-at').textContent = at.length > 1 ? at.map(([u, w]) => `${u} (on ${w})`).join(', or ') : at[0]?.[0] ?? '';
  const code = (c: PhoneState['code']) => { $('code').textContent = c ? c.code : '——————'; $('code-until').textContent = c ? `until ${new Date(c.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${c.owner ? ', for an owner device' : ''}` : ''; };
  code(s.code);
  $('new-code').onclick = () => { void shell.invoke('shell:phone-code', { owner: $<HTMLInputElement>('owner-code').checked }).then((c: PhoneState['code']) => code(c)); };
  $('paired').hidden = !s.devices.length;
  $('devices').replaceChildren(...s.devices.map(d => {
    const li = el('li'); const remove = el('button', 'Remove'); remove.type = 'button';
    remove.addEventListener('click', () => { void shell.invoke('shell:phone-remove', d.id).then(() => phone()); });
    li.append(el('b', d.name), el('span', `${d.owner ? 'owner: sets Processors · ' : ''}${d.push ? 'notifications on · ' : ''}${d.seen ? `last here ${new Date(d.seen).toLocaleString()}` : `paired ${new Date(d.paired).toLocaleString()}`}`, 'when'), remove);
    return li;
  }));
}
/** Phone, on a paired device: its name, and its notifications (Web Push, through the service worker). */
async function away() {
  $('setup').hidden = true; $('away').hidden = false;
  const d = await shell.invoke('shell:device') as { name: string; push: boolean; key: string } | null; if (!d) return;
  $('device-name').textContent = d.name;
  const can = 'serviceWorker' in navigator && 'PushManager' in window && isSecureContext;
  $('push-state').textContent = !isSecureContext ? 'Open Vindu at its HTTPS address to enable notifications.'
    : !can ? 'This browser can\'t get notifications from vindu here: on an iPhone, add this page to the Home Screen and open it from there.'
    : d.push ? 'Notifications are on: what needs you, from any app, comes here.' : 'Notifications are off.';
  const b = $<HTMLButtonElement>('push'); b.hidden = !can; b.textContent = d.push ? 'Turn off notifications' : 'Turn on notifications';
  b.onclick = async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready;
      if (d.push) { await (await reg.pushManager.getSubscription())?.unsubscribe(); await shell.invoke('shell:push', null); }
      else {
        if (await Notification.requestPermission() !== 'granted') { note('Notifications are not allowed for vindu on this device: allow them in its settings.'); return; }
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(d.key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) });
        await shell.invoke('shell:push', sub.toJSON());
      }
      await away();
    } catch (e) { note(`Notifications did not turn ${d.push ? 'off' : 'on'}: ${(e as Error).message}`); }
  };
}

$('home').addEventListener('click', () => { page = 'apps'; show(null); });
$('find').addEventListener('input', () => draw());
const toProcessors = () => { page = 'processors'; show(null); void processors(); };
const toPhone = () => { page = 'phone'; show(null); void phone().catch((e: Error) => note(e.message)); };
$('procs').addEventListener('click', toProcessors); $('procs-here').addEventListener('click', toProcessors);
$('phones').addEventListener('click', toPhone); $('phones-here').addEventListener('click', toPhone);
// the menu of the app in front, at a phone's width: what the bar's tab has on a computer, and loading it again
$('app-menu').addEventListener('click', () => { appSheet = true; draw(); });
$('app-home').addEventListener('click', () => { page = 'apps'; show(null); });
$('app-reload').addEventListener('click', () => { const o = front ? opened.get(front) : undefined; if (o) o.frame.src = o.url; closeSheet(); });
$('app-out').addEventListener('click', () => { if (front) popOut(front); });
$('app-close').addEventListener('click', () => { if (front) closeHere(front); });
$('welcome-done').addEventListener('click', () => { try { localStorage.setItem('vindu-welcome', 'done'); } catch { /* it shows again next time */ } draw(); });
// a sheet goes away by Done, a tap beside it, Escape, or a pull down on its head
$('scrim').addEventListener('click', closeSheet);
for (const b of document.querySelectorAll('.sheet-close')) b.addEventListener('click', closeSheet);
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('scrim').hidden) { e.preventDefault(); closeSheet(); } });
for (const s of document.querySelectorAll<HTMLElement>('.sheet')) {
  const head = s.querySelector<HTMLElement>('.sheet-head')!; let from = 0, at = 0, by = 0, finger: number | null = null;
  head.addEventListener('pointerdown', e => { if (!phoneSized.matches || (e.target as HTMLElement).closest('button')) return; finger = e.pointerId; from = e.clientY; at = e.timeStamp; by = 0; head.setPointerCapture(finger); s.classList.remove('settling'); });
  head.addEventListener('pointermove', e => { if (e.pointerId !== finger) return; by = Math.max(0, e.clientY - from); s.style.transform = by ? `translateY(${by}px)` : ''; });
  const letGo = (e: PointerEvent) => {
    if (e.pointerId !== finger) return; finger = null;
    const away = by > s.offsetHeight / 5 || (by > 24 && by / Math.max(1, e.timeStamp - at) > 0.6); // far enough, or quick
    if (away) { s.style.transform = ''; closeSheet(); return; }
    s.classList.add('settling'); s.style.transform = ''; setTimeout(() => s.classList.remove('settling'), 220); // back up, eased
  };
  head.addEventListener('pointerup', letGo); head.addEventListener('pointercancel', letGo);
}
$('note').addEventListener('click', () => { if (phoneSized.matches) note(''); }); // at a phone's width a note floats over the bottom: a tap puts it away
phoneSized.addEventListener('change', () => draw()); installed.addEventListener('change', () => draw());
new ResizeObserver(() => { if (front) where(); }).observe($('frames'));
/** A link to an app, in this page's address (#open=<app>&link=…): its tab, with the link; the address then as it was. */
function linked() {
  const q = new URLSearchParams(location.hash.slice(1)), id = q.get('open'); if (!id || !apps.length) return; // the grid not here yet: taken once it is
  history.replaceState(null, '', location.pathname + location.search);
  const a = apps.find(x => x.id === id); if (a) void openHere(a, q.get('link') ?? undefined); // an app not on the grid: nothing
}
addEventListener('hashchange', linked);
shell.on('shell:state', (s: { apps: App[]; host?: string }) => { apps = s.apps; host = s.host ?? host; draw(); linked(); });
// what needs the person, from any app: the system's notification once they allowed it, a tap bringing the app; else a note
shell.on('shell:notice', (n: { app: string; name: string; title: string; body: string }) => {
  const a = apps.find(x => x.id === n.app);
  if ('Notification' in window && Notification.permission === 'granted' && !document.hasFocus()) {
    const shown = new Notification(`${n.name}: ${n.title}`, { body: n.body, tag: n.app });
    shown.onclick = () => { window.focus(); if (a) open(a); shown.close(); };
  } else note(`${n.name}: ${n.title}${n.body ? ` — ${n.body}` : ''}`);
});
void shell.invoke('shell:state').then((s: { apps: App[]; device: string | null; inApp: boolean; host?: string; away?: boolean; setsUp?: boolean }) => {
  apps = s.apps; device = s.device; inApp = s.inApp; host = s.host ?? ''; overTailnet = !!s.away; setsUp = !!s.setsUp; draw(); linked();
  // on a paired device, the shell's own files are kept for when the network is slow (the service worker)
  if (device && 'serviceWorker' in navigator && isSecureContext) void navigator.serviceWorker.register('sw.js').catch(() => undefined);
});
