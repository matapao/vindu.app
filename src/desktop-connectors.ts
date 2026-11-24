import path from 'node:path';
import { configuredServers, loadConnectors, type ConnectorSpec } from './connectors.js';
import { envName, serverKeys } from './keyrefs.js';
import { connectorKeyIndex, systemSecrets } from './secrets.js';
import { keptToken } from './page-credentials.js';
import { startPageServer, type PageServer } from './web.js';
import { STATIC, BUILT, type AppOptions, type Settings } from './desktop-settings.js';

export function desktopConnectors(userData: string, readSettings: () => Settings, o: AppOptions, tokens: string) {
  // connectors: folders in the app's folder, each reaching one system (an HTTP API or an MCP server), with its guide
  const connectorsDir = path.join(userData, 'connectors');
  const keysFile = path.join(userData, 'keys.json');
  const keyIndex = connectorKeyIndex(keysFile); // which keys the system's own store keeps (secrets.ts); never in a task's folders, never sent to the window
  const keyName = (c: ConnectorSpec) => c.http?.auth?.secret ?? c.name;
  const secrets = o.secrets ?? systemSecrets();
  /** Whether the system has a store that keeps keys safe: the keychain, the Secret Service, DPAPI. */
  const safeStore = () => secrets.available();
  /** A key the app keeps, by its name: from the system's own store, or else from the app's environment. */
  const keyNamed = async (n: string): Promise<string | undefined> => {
    const kept = keyIndex.read()[n];
    if (kept) { const v = await secrets.get(n, kept).catch(() => undefined); if (v) return v; } // kept on another machine, or cleared there: not readable here
    return process.env[envName(n)] || undefined;
  };
  const keyOf = (c: ConnectorSpec) => keyNamed(keyName(c));
  const availableConnectors = () => {
    const found = loadConnectors(connectorsDir);
    const names = new Set(found.connectors.map(connector => connector.name));
    return { ...found, connectors: [...found.connectors, ...configuredServers(readSettings().servers ?? []).filter(server => !names.has(server.name))] };
  };
  /** The keys connectors and the settings' servers take, and where each is (never what it is). */
  const keyed = () => {
    const wanted = new Map<string, string>(); // a key's name, and what takes it
    for (const c of loadConnectors(connectorsDir).connectors) if (c.kind === 'http' && c.http?.auth && !wanted.has(keyName(c))) wanted.set(keyName(c), c.title);
    for (const k of serverKeys(readSettings().servers ?? [])) if (!wanted.has(k.key)) wanted.set(k.key, k.title);
    const markers = keyIndex.read();
    return [...wanted].map(([n, title]) => ({ key: n, title, env: envName(n), has: markers[n] ? 'kept' as const : process.env[envName(n)] ? 'environment' as const : null }));
  };
  let keysPage: Promise<PageServer> | undefined;
  /** The page where the person sets a connector's key: its own address, on an origin of its own, so no other page reaches the keys. */
  const openKeys = async () => {
    keysPage ??= startPageServer({ name: 'keys', port: (o.port ?? 7300) + 1, token: keptToken(tokens, 'keys'), page: path.join(STATIC, 'keys.html'),
      files: { 'keys.bundle.js': path.join(BUILT, 'keys.bundle.js') },
      csp: "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'" }).then(k => {
      k.handle('keys:list', async () => ({ safe: await safeStore(), list: keyed() }));
      k.handle('keys:set', async (_e, name: string, value: string) => {
        if (!keyed().some(x => x.key === name)) throw new Error(`no connector or server takes the key "${name}"`);
        const v = String(value ?? '').trim(); if (!v) throw new Error('the key is empty');
        await keyIndex.update(name, async () => {
          if (!await safeStore()) throw new Error(`this system has no safe store for keys: give it as ${envName(name)} in the app's environment instead`);
          return secrets.set(name, v);
        });
        return { safe: true, list: keyed() };
      });
      k.handle('keys:clear', async (_e, name: string) => {
        await keyIndex.update(name, async previous => { if (previous) await secrets.clear(name, previous); return undefined; });
        return { safe: await safeStore(), list: keyed() };
      });
      return k;
    });
    return (await keysPage).url;
  };

  const close = async () => { await (await keysPage?.catch(() => undefined))?.close(); };
  return { availableConnectors, keyOf, keyNamed, connectorsDir, keysFile, openKeys, close };
}
