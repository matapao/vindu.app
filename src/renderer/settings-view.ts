// Desktop's Settings, in Activity's column in place of the tasks: Processors (the harnesses Vindu may use, the connectors
// each task chooses from, and its day's budget) and Phone (the core on the person's tailnet, devices paired by a code,
// and notifications). Processors shows where the core says this page may set it: on its own computer, or on one of the
// person's owner devices; the core refuses it anywhere else. On a paired device, Phone turns on its notifications (the
// service worker, registered as Desktop loads there). Everything it shows is set as text, never as markup.
import { desktop } from '../desktop-client.js';
import type { Budget, PairingCode, PhoneState } from './desktop-api.js';
import { button, byId, element, errorMessage } from './dom.js';

const TAILNET: Record<PhoneState['step'], string> = {
  install: 'Tailscale is not on this computer. Install it (tailscale.com/download), on this computer and on your phone, and sign in on both with the same account.',
  signin: 'Tailscale is here, but not signed in or not running. Open it and sign in, here and on your phone, with the same account.',
  https: 'Tailscale is running. Turn on HTTPS certificates for your tailnet (in its admin console, DNS), so your phone gets an https address: a phone needs one to install vindu and to get notifications.',
  ready: '',
};
let device: string | null = null;
const note = (text: string) => { const n = byId('setup-note'); n.textContent = text; n.hidden = !text; };
const limitBoxes = () => [...document.querySelectorAll<HTMLInputElement>('#setup-limits input[data-limit]')];

/** The Settings button in Activity's head, its Done, and the day's limits as the person types them. */
export function bindSettings() {
  const panel = byId('setup'), toggle = byId('setup-open');
  const show = (on: boolean) => { panel.hidden = !on; toggle.setAttribute('aria-pressed', String(on)); if (on) { note(''); void draw().catch((e: unknown) => note(errorMessage(e))); } };
  toggle.addEventListener('click', () => show(panel.hidden === true));
  byId('setup-done').addEventListener('click', () => show(false));
  for (const box of limitBoxes()) box.addEventListener('change', () => {
    const limits = Object.fromEntries(limitBoxes().map(b => [b.dataset.limit, b.value === '' ? 0 : Number(b.value)])) as Budget['limits'];
    void desktop.settingsSetBudget(limits).then(drawBudget, (e: unknown) => note(errorMessage(e)));
  });
  // on a paired device, Desktop's own files are kept for when the network is slow (the service worker)
  void desktop.settingsState().then(s => {
    device = s.device;
    if (device && 'serviceWorker' in navigator && isSecureContext) void navigator.serviceWorker.register('sw.js').catch(() => undefined);
  }, () => undefined);
}

async function draw() {
  const s = await desktop.settingsState(); device = s.device;
  byId('setup-host').textContent = `On ${s.host}${s.away ? ', from another device' : ''}`;
  byId('setup-processors').hidden = !s.setsUp; // set on this computer, or on an owner device
  await Promise.all([s.setsUp ? processors() : undefined, phone()]);
}

/** The harnesses, each ticked when Vindu may use it; the connectors, which each task chooses from; and the day. */
async function processors() {
  const p = await desktop.settingsProcessors();
  byId('setup-harnesses').replaceChildren(...(p.processors.length ? p.processors.map(x => {
    const box = element('input'); box.type = 'checkbox'; box.dataset.processor = x.id; box.checked = p.granted.includes(x.id);
    box.addEventListener('change', () => { void desktop.settingsGrant(x.id, box.checked).then(g => { box.checked = g.includes(x.id); }, (e: unknown) => { box.checked = !box.checked; note(errorMessage(e)); }); });
    const label = element('label'); label.title = `Vindu may use ${x.name}`; label.append(box, element('span', '', x.name)); return label;
  }) : [element('p', 'muted', 'No harness is registered on this computer.')]));
  byId('setup-connectors').textContent = p.connectors.length ? `Connectors: ${p.connectors.map(c => c.title).join(', ')}. Each task is given those you choose as you start it.`
    : 'No connectors are set up. Each task is given those you choose as you start it.';
  drawBudget(await desktop.settingsBudget());
}
function drawBudget(b: Budget) {
  const spent = byId('setup-spent');
  spent.textContent = `Today: ${[`${Math.round(b.spent.tokens).toLocaleString()} tokens`, b.spent.cost ? `${b.spent.cost.toFixed(2)}${b.spent.currency ? ` ${b.spent.currency}` : ''}` : 'no cost reported', `${Math.round(b.spent.minutes)} min`].join(' · ')}`;
  spent.classList.toggle('over', !!b.over); spent.title = b.over ? `Over today's budget: ${b.over}` : '';
  for (const box of limitBoxes()) { const v = b.limits[box.dataset.limit as keyof Budget['limits']]; box.value = v ? String(v) : ''; }
}

/** Phone, on this computer: its notifications here, Tailscale's step, serving the core there, a code, the devices paired. */
async function phone() {
  if (device) { await away(); return; }
  byId('setup-away').hidden = true; byId('setup-here').hidden = false;
  const can = 'Notification' in window, on = can && Notification.permission === 'granted';
  byId('setup-here-state').textContent = !can ? 'This browser shows no notifications.' : on ? 'Notifications on this computer are on: what needs you shows here.' : 'Notifications on this computer are off.';
  const allow = byId<HTMLButtonElement>('setup-here-push'); allow.hidden = !can || on || Notification.permission === 'denied';
  allow.onclick = () => { void Notification.requestPermission().then(() => phone()); };
  drawPhone(await desktop.settingsPhone());
}
function drawPhone(s: PhoneState) {
  byId('setup-tailnet').textContent = s.step !== 'ready' ? TAILNET[s.step] : s.serving ? `vindu is on your tailnet at ${s.address}. Only devices you pair open anything there.` : `Tailscale is ready on ${s.host}. vindu is not on your tailnet yet.`;
  const serve = byId<HTMLButtonElement>('setup-serve'); serve.hidden = s.step !== 'ready'; serve.textContent = s.serving ? 'Take vindu off my tailnet' : 'Put vindu on my tailnet';
  serve.onclick = async () => {
    serve.disabled = true;
    try { const r = await desktop.settingsPhoneServe(!s.serving); drawPhone(r.state); if (!r.ok) note(`Tailscale said: ${r.said ?? 'no'}${r.link ? ` (open ${r.link} to allow it)` : ''}`); }
    catch (e) { note(errorMessage(e)); } finally { serve.disabled = false; }
  };
  // where a phone opens the pairing page: on the tailnet, once served there, and on this Wi-Fi, while vindu is on it
  const at = [s.serving && s.address ? [`${s.address}/pair`, 'your tailnet'] : [], s.lan?.on && s.lan.address ? [`${s.lan.address}/pair`, 'this Wi-Fi'] : []].filter(x => x.length);
  byId('setup-pairing').hidden = !at.length; byId('setup-pair-at').textContent = at.length > 1 ? at.map(([u, w]) => `${u} (on ${w})`).join(', or ') : at[0]?.[0] ?? '';
  const code = (c: PairingCode | null) => { byId('setup-code').textContent = c ? c.code : '——————'; byId('setup-code-until').textContent = c ? `until ${new Date(c.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${c.owner ? ', for an owner device' : ''}` : ''; };
  code(s.code);
  byId('setup-new-code').onclick = () => { void desktop.settingsPhoneCode({ owner: byId<HTMLInputElement>('setup-owner-code').checked }).then(code, (e: unknown) => note(errorMessage(e))); };
  byId('setup-paired').hidden = !s.devices.length;
  byId('setup-devices').replaceChildren(...s.devices.map(d => {
    const li = element('li');
    li.append(element('b', '', d.name), element('span', 'when', `${d.owner ? 'owner: sets Processors · ' : ''}${d.push ? 'notifications on · ' : ''}${d.seen ? `last here ${new Date(d.seen).toLocaleString()}` : `paired ${new Date(d.paired).toLocaleString()}`}`),
      button('btn', 'Remove', () => { void desktop.settingsPhoneRemove(d.id).then(() => phone(), (e: unknown) => note(errorMessage(e))); }));
    return li;
  }));
}
/** Phone, on a paired device: its name, and its notifications (Web Push, through the service worker). */
async function away() {
  byId('setup-here').hidden = true; byId('setup-away').hidden = false;
  const d = await desktop.settingsDevice(); if (!d) return;
  byId('setup-device-name').textContent = d.name;
  const can = 'serviceWorker' in navigator && 'PushManager' in window && isSecureContext;
  byId('setup-push-state').textContent = !isSecureContext ? 'Open vindu at its HTTPS address to enable notifications.'
    : !can ? 'This browser can\'t get notifications from vindu here: on an iPhone, add this page to the Home Screen and open it from there.'
    : d.push ? 'Notifications are on: what needs you comes here.' : 'Notifications are off.';
  const b = byId<HTMLButtonElement>('setup-push'); b.hidden = !can; b.textContent = d.push ? 'Turn off notifications' : 'Turn on notifications';
  b.onclick = async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready;
      if (d.push) { await (await reg.pushManager.getSubscription())?.unsubscribe(); await desktop.settingsPush(null); }
      else {
        if (await Notification.requestPermission() !== 'granted') { note('Notifications are not allowed for vindu on this device: allow them in its settings.'); return; }
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(d.key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) });
        await desktop.settingsPush(sub.toJSON());
      }
      await away();
    } catch (e) { note(`Notifications did not turn ${d.push ? 'off' : 'on'}: ${errorMessage(e)}`); }
  };
}
