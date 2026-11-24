// The cores elsewhere the person added to this app (a Pi, a Mac mini, a server): each by its address on their tailnet and
// the token it gave this computer when they paired, by a code made under Phone there (vindu's src/network.ts), kept in the
// system's keychain (Electron's safeStorage), never in the clear. A core elsewhere is reached at its https address only.
// This computer's own core is not here: the app starts it, or finds it running.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { app, safeStorage } from 'electron';

export type Elsewhere = { id: string; name: string; address: string };
type Kept = Elsewhere & { token: string }; // the token as the keychain's key encrypted it, in base64
/** How a token is kept: the keychain, or a test's own store (VINDU_FRAME_SECRETS=memory, in an app not packed). */
type Keep = { put(token: string): string; take(kept: string): string };
const memory = (): Keep => ({ put: t => Buffer.from(t).toString('base64'), take: k => Buffer.from(k, 'base64').toString() });
const keychain = (): Keep => ({
  put: t => { if (!safeStorage.isEncryptionAvailable()) throw new Error('this computer has no keychain to keep the core\'s token in'); return safeStorage.encryptString(t).toString('base64'); },
  take: k => safeStorage.decryptString(Buffer.from(k, 'base64')),
});

export function coresElsewhere(file: string) {
  // Node handles pairing and the desktop's WebSocket link. Honor the user's trusted
  // issuers there as well as in the Electron browser window.
  setDefaultCACertificates([...getCACertificates('default'), ...getCACertificates('system')]);
  const allowed = (u: URL) => u.protocol === 'https:' || (!app.isPackaged && u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  const keep = !app.isPackaged && process.env.VINDU_FRAME_SECRETS === 'memory' ? memory() : keychain();
  const read = (): Kept[] => { try { const list: Kept[] = JSON.parse(fs.readFileSync(file, 'utf8'));
    return list.filter(c => { const u = typeof c?.address === 'string' && URL.parse(c.address); return u && allowed(u) && c.address === u.origin; }); } catch { return []; } };
  const write = (all: Kept[]) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 }); };
  const find = (id: string) => { const c = read().find(x => x.id === id); if (!c) throw new Error(`no core "${id}"`); return c; };
  return {
    list: (): Elsewhere[] => read().map(({ token: _t, ...c }) => c),
    /** Paired by the code made there: its address (https; or this computer's own name, for a test's core) and a name. */
    async add(address: string, code: string, name: string): Promise<Elsewhere> {
      let u: URL; try { u = new URL(/^[a-z]+:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`); } catch { throw new Error('that is not an address'); }
      if (!allowed(u)) throw new Error('a core elsewhere is reached at its https address');
      const r = await fetch(`${u.origin}/pair`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Origin: u.origin }, body: JSON.stringify({ code: code.trim(), name: os.hostname().replace(/\.local$/, '') }), signal: AbortSignal.timeout(15_000) })
        .catch((e: Error) => { throw new Error(`${u.host} did not answer: ${e.message}`); });
      const j = await r.json().catch(() => ({})) as { url?: string; error?: string };
      if (!r.ok || !j.url) throw new Error(j.error ?? `${u.host} did not pair (${r.status})`);
      const token = j.url.split('/')[1]; if (!token || !/^[\w-]{20,}$/.test(token)) throw new Error(`${u.host} answered something else`);
      const c: Kept = { id: randomBytes(6).toString('hex'), name: name.trim().slice(0, 40) || u.hostname.split('.')[0], address: u.origin, token: keep.put(token) };
      write([...read().filter(x => x.address !== u.origin), c]); // pairing again replaces what was kept for that core
      return { id: c.id, name: c.name, address: c.address };
    },
    /** The core's shell, at this computer's token there. */
    shell: (id: string) => { const c = find(id); return `${c.address}/${keep.take(c.token)}/`; },
    /** Its link's address, for its browser views' pages to live here (link.ts). */
    linkAt: (id: string) => { const c = find(id); return `${c.address.replace(/^http/, 'ws')}/${keep.take(c.token)}/frame`; },
    remove: (id: string) => { write(read().filter(x => x.id !== id)); },
    /** The core a page is of, by its host: each of its pages is at a port of its own there. */
    of(url: string): Elsewhere | undefined {
      try { const u = new URL(url); return this.list().find(c => { const a = new URL(c.address); return a.hostname === u.hostname && a.protocol === u.protocol; }); } catch { return undefined; }
    },
  };
}
export type Cores = ReturnType<typeof coresElsewhere>;
