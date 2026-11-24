import fs from 'node:fs';
import path from 'node:path';
import { attachment, type Attachment } from './work.js';
import { bodyOf } from './web.js';

export function desktopFiles(userData: string) {
  // what the person attached, by id: the window holds names, never paths, and a prompt names its files by these ids
  const files = new Map<string, Attachment>(); let filed = 0;
  const attach = (paths: unknown[]) => paths.flatMap(f => { const a = typeof f === 'string' ? attachment(f) : undefined; if (!a) return []; const id = `f${++filed}`; files.set(id, a); return [{ id, name: a.name, mime: a.mime }]; });
  /** A file dropped on Desktop's page: kept here, as an attachment; the page gets its id and name back. */
  async function dropped(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, rest: string, origin: string): Promise<boolean> {
    if (rest !== 'files' || req.method !== 'POST') return false;
    if (req.headers.origin !== origin && req.headers.origin !== origin.replace('localhost', '127.0.0.1')) { res.writeHead(403).end(); return true; }
    const name = path.basename(new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? 'file').replace(/[^\w. -]/g, '_') || 'file';
    const dir = path.join(userData, 'dropped', `${Date.now()}-${++filed}`); fs.mkdirSync(dir, { recursive: true });
    const to = path.join(dir, name); fs.writeFileSync(to, await bodyOf(req, 512 * 1024 * 1024));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(attach([to]))); return true;
  }
  return { files, attach, dropped };
}
