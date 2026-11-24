import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

type TokenStore = Record<string, unknown>;

function readStore(file: string): TokenStore {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as TokenStore;
  } catch { /* Earlier versions wrote in place. A torn file gets fresh credentials. */ }
  return {};
}

export function writePrivateJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

/** Older shell logs stored the complete local URL for every opened Desktop or folder app. */
export async function upgradePageCredentials(file: string, log: string) {
  const hasLog = fs.existsSync(log);
  if (hasLog) fs.chmodSync(log, 0o600);
  if (readStore(file).version === 2) return;
  if (hasLog) {
    const temp = log + '.' + crypto.randomUUID();
    const output = fs.openSync(temp, 'wx', 0o600);
    try {
      const input = fs.createReadStream(log);
      try {
        for await (const line of createInterface({ input, crlfDelay: Infinity })) {
          let record;
          try { record = JSON.parse(line); } catch { continue; } // a partial record can still contain part of a credential
          if (record && typeof record.opened === 'string') record.opened = true;
          fs.writeFileSync(output, JSON.stringify(record) + '\n');
        }
      } finally { input.destroy(); fs.closeSync(output); }
      fs.renameSync(temp, log);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  // The log may already have been copied or rotated. Invalidate every potentially logged page address.
  // Write the version together with the change, so an interrupted upgrade can safely repeat the cleanup.
  const store = readStore(file);
  if (store.version === 2) return;
  for (const key of Object.keys(store)) if (key === 'desktop' || key.startsWith('app:')) delete store[key];
  store.version = 2;
  writePrivateJson(file, store);
}

/** Keep page addresses stable between restarts for bookmarks and installed web apps. */
export function keptToken(file: string, name: string): string {
  const store = readStore(file);
  const saved = store[name];
  if (typeof saved === 'string' && /^[\w-]{20,}$/.test(saved)) return saved;
  const token = crypto.randomBytes(24).toString('base64url');
  store[name] = token;
  writePrivateJson(file, store);
  return token;
}
