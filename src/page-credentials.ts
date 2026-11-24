import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type TokenStore = Record<string, unknown>;

function readStore(file: string): TokenStore {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as TokenStore;
  } catch { /* A file that does not read gets fresh credentials. */ }
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
