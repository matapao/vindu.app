// Connector keys, kept by the system's own store, as Electron's safeStorage kept them before: the macOS keychain (through
// `security`), the Secret Service on Linux (`secret-tool`), or the user's DPAPI on Windows (PowerShell). A key's value goes
// to the store on standard input, never as an argument other processes could see. The app's keys file says only which
// keys are kept there (and holds DPAPI's encrypted blob on Windows); where none of these is, no key is kept here, and the
// person gives it in the app's environment instead.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { writePrivateJson } from './page-credentials.js';

const SERVICE = 'vindu: connector keys';
const mac = process.platform === 'darwin', windows = process.platform === 'win32';
const run = (command: string, args: string[], input?: string) => new Promise<{ ok: boolean; out: string; code?: string | number | null }>(resolve => {
  const p = execFile(command, args, { windowsHide: true }, (err, out) => resolve({ ok: !err, out: String(out ?? ''), code: err?.code }));
  p.stdin?.end(input ?? '');
});
/** What `security -i` reads as one argument: in quotes, with nothing that would end it. */
const quoted = (s: string) => { if (/["\\\n\r]/.test(s)) throw new Error('a key with quotes, backslashes or line breaks cannot be kept in the keychain: give it in the app\'s environment instead'); return `"${s}"`; };

export type Secrets = {
  /** Whether this system has a store for them. */
  available(): Promise<boolean>;
  /** The marker the keys file keeps for a key: what get() needs back. */
  set(name: string, value: string): Promise<string>;
  get(name: string, marker: string): Promise<string | undefined>;
  clear(name: string, marker: string): Promise<void>;
};

/** Serialize the system-store operation with its index update. Windows keeps the encrypted value in the index. */
export function connectorKeyIndex(file: string) {
  let pending = Promise.resolve();
  const read = (): Record<string, string> => {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null); throw e; }
    const entries: unknown = JSON.parse(text);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.values(entries).some(v => typeof v !== 'string'))
      throw new Error('The connector key index could not be read.');
    // nosemgrep: javascript.lang.security.insecure-object-assign.insecure-object-assign -- onto an object without a prototype, from an index checked to hold only strings
    return Object.assign(Object.create(null), entries);
  };
  return {
    read,
    update(name: string, change: (previous?: string) => Promise<string | undefined>): Promise<void> {
      const done = pending.then(async () => {
        const entries = read();
        const previous = entries[name], next = await change(previous);
        if (next === previous) return;
        if (next === undefined) delete entries[name]; else entries[name] = next;
        writePrivateJson(file, entries);
      });
      pending = done.catch(() => {}); // a failed operation still reports its error to its caller
      return done;
    },
  };
}

export function systemSecrets(): Secrets {
  if (mac) return {
    available: async () => true,                                   // every Mac has its keychain
    set: async (name, value) => {
      const r = await run('security', ['-i'], `add-generic-password -U -s ${quoted(SERVICE)} -a ${quoted(name)} -w ${quoted(value)}\n`);
      if (!r.ok) throw new Error('the keychain did not keep the key'); return 'keychain';
    },
    get: async name => { const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']); return r.ok ? r.out.replace(/\n$/, '') : undefined; },
    clear: async name => {
      const r = await run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]);
      // security reports an item that was already deleted with errSecItemNotFound (exit 44).
      if (!r.ok && r.code !== 44) throw new Error('the keychain could not clear the key');
    },
  };
  if (windows) {
    const dpapi = (verb: 'Protect' | 'Unprotect', input: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd(); ${verb === 'Protect'
        ? '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, \'CurrentUser\'))'
        : '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in.Trim()), $null, \'CurrentUser\'))'}`], input);
    return {
      available: async () => (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'])).ok,
      set: async (_name, value) => { const r = await dpapi('Protect', value); if (!r.ok || !r.out.trim()) throw new Error('DPAPI did not keep the key'); return `dpapi:${r.out.trim()}`; },
      get: async (_name, marker) => { if (!marker.startsWith('dpapi:')) return undefined; const r = await dpapi('Unprotect', marker.slice(6)); return r.ok ? r.out : undefined; },
      clear: async () => undefined, // the keys file held the only copy
    };
  }
  const attrs = (name: string) => ['service', SERVICE, 'key', name];
  return {
    available: async () => (await run('secret-tool', ['--version'])).ok || (await run('which', ['secret-tool'])).ok,
    set: async (name, value) => { const r = await run('secret-tool', ['store', `--label=${SERVICE}: ${name}`, ...attrs(name)], value); if (!r.ok) throw new Error('the Secret Service did not keep the key'); return 'secret-service'; },
    get: async name => { const r = await run('secret-tool', ['lookup', ...attrs(name)]); return r.ok && r.out ? r.out : undefined; },
    clear: async name => {
      const r = await run('secret-tool', ['clear', ...attrs(name)]);
      if (!r.ok) throw new Error('the Secret Service could not clear the key');
    },
  };
}
