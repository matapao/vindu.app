// The Connector Keys page: each key a connector or a server of the settings takes, where it is now (kept, from the environment, or none), and a
// field to set it. A key typed here goes to the app over this page's own socket, and is never shown again, here or anywhere.
import { connect } from './socket.js';
type Key = { key: string; title: string; env: string; has: 'kept' | 'environment' | null };
type Keys = { safe: boolean; list: Key[] };
const s = connect();
const api = { list: (): Promise<Keys> => s.invoke('keys:list'), set: (name: string, value: string): Promise<Keys> => s.invoke('keys:set', name, value), clear: (name: string): Promise<Keys> => s.invoke('keys:clear', name) };

const root = document.getElementById('keys')!, status = document.getElementById('status')!;
const say = (t: string) => { status.textContent = t; };
function draw(k: Keys): void {
  root.replaceChildren();
  if (!k.list.length) { const p = document.createElement('p'); p.textContent = 'No connector or server takes a key. Connectors are folders in the app\'s connectors folder; a server in settings.json names its key as { "name": …, "key": … }.'; root.append(p); }
  if (!k.safe) { const p = document.createElement('p'); p.className = 'warn'; p.textContent = 'This system has no safe store for keys, so none is kept here: give each in the app\'s environment, as named below.'; root.append(p); }
  for (const x of k.list) {
    const row = document.createElement('form'); row.className = 'key';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = x.title;
    const where = document.createElement('div'); where.className = 'where';
    where.textContent = x.has === 'kept' ? 'Kept by this computer\'s keychain' : x.has === 'environment' ? `From the environment (${x.env})` : `None yet: set it here, or as ${x.env} in the app's environment`;
    const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.disabled = !k.safe;
    input.setAttribute('aria-label', `The key for ${x.title}`); input.placeholder = x.has === 'kept' ? 'Replace the key' : 'The key';
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save'; save.disabled = !k.safe;
    const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear'; clear.disabled = x.has !== 'kept';
    row.addEventListener('submit', e => {
      e.preventDefault(); const v = input.value; input.value = ''; // never kept in this page
      if (!v.trim()) { say('The key is empty.'); return; }
      api.set(x.key, v).then(r => { draw(r); say(`The key for ${x.title} is kept.`); }, err => say(String((err as Error).message ?? err)));
    });
    clear.addEventListener('click', () => { api.clear(x.key).then(r => { draw(r); say(`The key for ${x.title} is cleared.`); }, err => say(String((err as Error).message ?? err))); });
    row.append(name, where, input, save, clear); root.append(row);
  }
}
api.list().then(draw, err => say(String((err as Error).message ?? err)));
