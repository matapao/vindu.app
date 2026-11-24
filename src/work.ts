import fs from 'node:fs';
import path from 'node:path';

export type Act =
  | { type: 'call'; id: string; title?: string; kind?: string; status?: string; input?: string; output?: string }
  | { type: 'plan'; entries: { content: string; status: string }[] }
  | { type: 'thinking' };

/** A new folder for a task started without one: <root>/<date>-<the prompt's first words>, never one already there. */
export function workFolder(root: string, prompt: string, now = new Date()): string {
  const base = path.join(root, folderName(prompt, now));
  fs.mkdirSync(root, { recursive: true });
  for (let n = 1; ; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    try { fs.mkdirSync(dir); return dir; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
}

/** A task's folder name: the date and the prompt's first words, as in a box, where the runner makes it. */
export function folderName(prompt: string, now = new Date()): string {
  const words = prompt.toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6).join('-').slice(0, 48).replace(/-$/, '');
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  return words ? `${day}-${words}` : day;
}

// The attachment's media type is sent with its workspace reference.
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', xml: 'application/xml',
  yaml: 'application/yaml', yml: 'application/yaml', html: 'text/html', htm: 'text/html', log: 'text/plain', sql: 'text/plain',
  js: 'text/javascript', ts: 'text/plain', py: 'text/x-python',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export type Attachment = { name: string; mime: string; file: string };
/** A file the person attached, by its name, type and path. A folder, or nothing there, is no file. */
export function attachment(file: string): Attachment | undefined {
  try { if (!fs.statSync(file).isFile()) return undefined; } catch { return undefined; }
  return { name: path.basename(file), mime: MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream', file };
}
