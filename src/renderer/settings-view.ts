// Desktop's Settings, in Activity's column in place of the tasks: Processors (the harnesses Vindu may use and what each
// still needs, the connectors each task chooses from, and its day's budget) and Notifications (whether this browser shows
// the app's notices here). Everything it shows is set as text, never as markup.
import { desktop } from '../desktop-client.js';
import type { ProcessorCheck } from '../desktop-settings.js';
import type { Budget } from './desktop-api.js';
import { byId, element, errorMessage } from './dom.js';

let checksAsked = 0;
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
}

async function draw() {
  const s = await desktop.settingsState();
  byId('setup-host').textContent = `On ${s.host}`;
  drawNotices();
  await processors();
}

/** The harnesses, each ticked when Vindu may use it, with what its check says once it comes; the connectors, which
 *  each task chooses from; and the day. */
async function processors() {
  const p = await desktop.settingsProcessors();
  const harnesses = byId('setup-harnesses');
  harnesses.replaceChildren(...(p.processors.length ? p.processors.flatMap(x => {
    const box = element('input'); box.type = 'checkbox'; box.dataset.processor = x.id; box.checked = p.granted.includes(x.id);
    box.addEventListener('change', () => { void desktop.settingsGrant(x.id, box.checked).then(g => { box.checked = g.includes(x.id); }, (e: unknown) => { box.checked = !box.checked; note(errorMessage(e)); }); });
    const label = element('label'); label.title = `Vindu may use ${x.name}`; label.append(box, element('span', '', x.name));
    const check = element('p', 'check muted'); check.dataset.check = x.id; check.hidden = true;
    return [label, check];
  }) : [element('p', 'muted', 'No harness was found on this computer.')]));
  const asked = ++checksAsked; // a check that comes after Settings was drawn again is not this list's
  void desktop.settingsProcessorChecks().then(checks => { if (asked === checksAsked) drawChecks(harnesses, checks); }, () => undefined);
  byId('setup-connectors').textContent = p.connectors.length ? `Connectors: ${p.connectors.map(c => c.title).join(', ')}. Each task is given those you choose as you start it.`
    : 'No connectors are set up. Each task is given those you choose as you start it.';
  drawBudget(await desktop.settingsBudget());
}
/** Under each harness, what its check says; after them, each one not found on this computer, and what to do about it. */
function drawChecks(harnesses: HTMLElement, checks: ProcessorCheck[]) {
  for (const c of checks) {
    const shown = harnesses.querySelector<HTMLElement>(`p.check[data-check="${CSS.escape(c.id)}"]`);
    if (c.found && shown) { shown.textContent = c.detail; shown.hidden = false; shown.classList.toggle('needs', !c.ready); }
    else if (!c.found) { const missing = element('p', 'check needs', c.detail); missing.dataset.missing = c.id; harnesses.append(missing); }
  }
}
function drawBudget(b: Budget) {
  const spent = byId('setup-spent');
  spent.textContent = `Today: ${[`${Math.round(b.spent.tokens).toLocaleString()} tokens`, b.spent.cost ? `${b.spent.cost.toFixed(2)}${b.spent.currency ? ` ${b.spent.currency}` : ''}` : 'no cost reported', `${Math.round(b.spent.minutes)} min`].join(' · ')}`;
  spent.classList.toggle('over', !!b.over); spent.title = b.over ? `Over today's budget: ${b.over}` : '';
  for (const box of limitBoxes()) { const v = b.limits[box.dataset.limit as keyof Budget['limits']]; box.value = v ? String(v) : ''; }
}

/** Notifications: whether this browser shows the app's notices on this computer, and a button to allow them. */
function drawNotices() {
  const can = 'Notification' in window, on = can && Notification.permission === 'granted';
  byId('setup-notices-state').textContent = !can ? 'This browser shows no notifications.' : on ? 'Notifications on this computer are on: what needs you shows here.' : 'Notifications on this computer are off.';
  const allow = byId<HTMLButtonElement>('setup-notices-allow'); allow.hidden = !can || on || Notification.permission === 'denied';
  allow.onclick = () => { void Notification.requestPermission().then(() => drawNotices()); };
}
