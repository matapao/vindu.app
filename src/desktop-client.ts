// Desktop's page's way to the app, in the person's browser: window.desktop, as Electron's preload gave it before, over the
// page's socket (socket.ts) instead of IPC. Each on…() returns a function that stops listening, so a pane that leaves the
// window leaves nothing behind. A file dropped on the window is sent to the app, which keeps it as an attachment, and the
// page gets back its id and name. The page tells the app whether the person can see it (for what counts as seen, and for
// when a notice is the system's), and shows the app's notices as the browser's notifications, once the person allows
// them.
import { connect } from './socket.js';
import type { DesktopApi, Picked } from './renderer/desktop-api.js';

const s = connect();
const on = (channel: string) => (cb: (...a: any[]) => void) => s.on(channel, cb);
const invoke = (channel: string) => (...a: unknown[]) => s.invoke(channel, ...a);
const post = (channel: string) => (...a: unknown[]) => { s.post(channel, ...a); };

// what the person can see: the tab in front and the window focused
const attention = () => s.post('page:attention', { visible: document.visibilityState === 'visible', focused: document.hasFocus() });
document.addEventListener('visibilitychange', attention); window.addEventListener('focus', attention); window.addEventListener('blur', attention);
attention();
s.post('page:screen', { width: screen.width, height: screen.height, scale: devicePixelRatio, language: navigator.language });

// notices: the browser's notifications, once the person allows them (asked on their first click here)
window.addEventListener('pointerdown', () => { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); }, { once: true });
s.on('notice', (n: { id: string; title: string; body: string }) => {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const shown = new Notification(n.title, { body: n.body, tag: n.id, requireInteraction: true });
  shown.onclick = () => { window.focus(); shown.close(); s.post('notice:click', n.id); };
  shown.onclose = () => s.post('notice:closed', n.id);
});

// a file dropped on the window: kept by the app as an attachment; the page gets its id and name, never its path
let dropped: ((files: Picked[]) => void) | undefined;
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  void Promise.all(files.map(f => fetch(`${s.base}files?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, headers: { 'Content-Type': f.type || 'application/octet-stream' } })
    .then(r => (r.ok ? r.json() : []), () => []))).then(lists => { const list = lists.flat(); if (list.length) dropped?.(list); });
});

const transport = {
  servers: invoke('settings:servers'), connectors: invoke('settings:connectors'), reminders: invoke('task:reminders'),
  // the connector keys' page: a tab of its own, on an origin of its own, so no other page reaches the keys
  keys: () => { const tab = window.open('', 'vindu-keys'); return s.invoke('keys:open').then((url: string) => { if (tab) { try { if (tab.location.href === 'about:blank') tab.location.href = url; } catch { /* open already */ } tab.focus(); } }); },
  folder: invoke('settings:folder'), pickFolder: invoke('pick:folder'), pickFiles: invoke('pick:files'),
  processors: invoke('app:processors'), onProcessors: on('processors'), // the harnesses Desktop may use, as Processors in Settings give them
  inference: invoke('settings:inference'), onAppNote: on('app-note'),
  branch: invoke('task:branch'), onMenu: on('menu'),
  activity: invoke('activity:list'), restoreActivity: invoke('activity:restore'), onUser: on('user'), pinTask: invoke('activity:pin'), muteTask: invoke('activity:mute'), onActivity: on('activity'), onFront: on('front'),
  templates: invoke('templates:list'), templatesDelete: invoke('templates:delete'),
  mode: invoke('task:mode'), pin: invoke('task:pin'), arrangement: invoke('task:arrangement'), letModelChange: invoke('task:let-model-change'),
  selection: invoke('task:selection'), exportTask: invoke('task:export'),
  captureFile: invoke('capture:file'), captureSkip: invoke('capture:skip'), onCaptures: on('captures'), phone: invoke('phone:toggle'),
  settingsState: invoke('settings:state'), settingsProcessors: invoke('settings:processors'), settingsGrant: invoke('settings:grant'),
  settingsBudget: invoke('settings:budget'), settingsSetBudget: invoke('settings:set-budget'),
  settingsPhone: invoke('settings:phone'), settingsPhoneServe: invoke('settings:phone-serve'), settingsPhoneCode: invoke('settings:phone-code'),
  settingsPhoneRemove: invoke('settings:phone-remove'), settingsDevice: invoke('settings:device'), settingsPush: invoke('settings:push'),
  create: invoke('task:create'),
  prompt: invoke('task:prompt'),
  set: invoke('task:set'), cancel: invoke('task:cancel'), reveal: invoke('task:reveal'),
  close: invoke('task:close'),
  unheard: invoke('task:unheard'),
  shown: post('task:shown'),
  event: post('shell:event'),
  onView: on('view'), onText: on('text'), onShell: on('shell'), onNote: on('note'), onSwitches: on('switches'), onApp: on('app'), onSuggest: on('suggest'), onCommand: on('command'),
  onAct: on('act'), onAskGone: on('askGone'), onSent: on('sent'), onTold: on('told'),
  onFiles: (cb: (files: Picked[]) => void) => { dropped = cb; },
  // terminals and browser pages: ending or sharing one, where a page's pane is (and the screen's scale), a terminal's
  // bytes, a page's bar, its pictures and what the person does in it
  viewEnd: invoke('view:end'), viewShare: invoke('view:share'),
  viewBox: (task: string, name: string, box: { x: number; y: number; w: number; h: number } | null) => s.post('view:box', task, name, box && { ...box, scale: devicePixelRatio }),
  ptyNew: invoke('pty:new'), ptyAttach: invoke('pty:attach'), ptyDetach: post('pty:detach'), ptyInput: post('pty:input'), ptyResize: post('pty:resize'), onPty: on('pty'), onPtyExit: on('pty-exit'),
  browserNew: invoke('browser:new'), browserState: invoke('browser:state'), browserNavigate: invoke('browser:navigate'), browserGo: invoke('browser:go'), onBrowser: on('browser'),
  browserPoint: invoke('browser:point'), browserStopPointing: invoke('browser:stop-pointing'),
  browserInput: post('browser:input'), onFrame: on('frame'),
};

export const desktop: DesktopApi = transport;
Object.assign(window, { desktop });
