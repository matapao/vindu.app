// Export a task's saved files and Vindu views as a ZIP with a digest manifest.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type ArchiveFile = { path: string; bytes: number; sha256: string } | { path: string; unreadable: string };
export type Manifest = { format: 'vindu task archive 1'; created: string; about: Record<string, unknown>; files: ArchiveFile[]; note: string };
export type ArchiveOptions = {
  dirs: { name: string; path: string }[];   // the process's folders, each under its own name in the zip (record, window, …)
  out: string;                              // the zip to write
  about?: Record<string, unknown>;          // what the process was: its processor, its folder, when; said in the manifest
  skip?: (rel: string) => boolean;          // files to leave out (and list as left out)
};

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const dos = (d: Date) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });

/** A zip of the given files, stored as they are (no compression): names in UTF-8, each with its CRC-32. */
export function zipStore(entries: { name: string; data: Buffer; at?: Date }[]): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  if (entries.length > 65_535) throw new Error('more than 65 535 files: too many for one plain zip');
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8'); const { time, date } = dos(e.at ?? new Date()); const crc = crc32(e.data);
    if (offset + e.data.length > 0xffffffff - 1_000_000) throw new Error('over 4 GB: too large for one plain zip');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(e.data.length, 20); cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    parts.push(local, name, e.data); central.push(cd, name);
    offset += local.length + name.length + e.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, end]);
}

const walk = (dir: string, base = dir): string[] => {
  let out: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isSymbolicLink()) continue; // a link is not the process's own file
    if (d.isDirectory()) out = out.concat(walk(full, base)); else if (d.isFile()) out.push(path.relative(base, full));
  }
  return out.sort();
};

/** Write the process's archive: a manifest first (what each file is, its size and sha256), then every file, by folder. */
export function exportArchive(o: ArchiveOptions): { file: string; files: number; bytes: number; manifest: Manifest } {
  const files: ArchiveFile[] = []; const entries: { name: string; data: Buffer; at?: Date }[] = []; let bytes = 0;
  const out = path.resolve(o.out);
  for (const d of o.dirs) {
    if (!fs.existsSync(d.path)) { files.push({ path: `${d.name}/`, unreadable: 'the folder is not there' }); continue; }
    for (const rel of walk(d.path)) {
      const full = path.join(d.path, rel); const name = `${d.name}/${rel.split(path.sep).join('/')}`;
      if (path.resolve(full) === out) continue; // the archive itself, if it is written inside a folder it archives
      if (o.skip?.(name)) { files.push({ path: name, unreadable: 'left out by the host' }); continue; }
      try {
        const data = fs.readFileSync(full); const st = fs.statSync(full);
        files.push({ path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
        entries.push({ name, data, at: st.mtime }); bytes += data.length;
      } catch (e) { files.push({ path: name, unreadable: (e as Error).message }); }
    }
  }
  const manifest: Manifest = { format: 'vindu task archive 1', created: new Date().toISOString(), about: o.about ?? {}, files,
    note: 'Every file the task kept, as it was kept: the record (record.jsonl, append-only), the recorded result and turn events, images, attachments, the window\'s answers and log. sha256 is of each file\'s bytes; the zip stores them uncompressed.' };
  const zip = zipStore([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 1)) }, ...entries]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip);
  return { file: out, files: entries.length, bytes, manifest };
}

/** Read a plain zip's entries back (stored entries only): for checking an archive without other tools. */
export function readZip(buf: Buffer): { name: string; data: Buffer; crcOk: boolean }[] {
  let eocd = buf.length - 22; while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10); let at = buf.readUInt32LE(eocd + 16); const out: { name: string; data: Buffer; crcOk: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const crc = buf.readUInt32LE(at + 16), size = buf.readUInt32LE(at + 20), nlen = buf.readUInt16LE(at + 28), xlen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32), off = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nlen);
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28); const data = buf.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + size);
    out.push({ name, data, crcOk: crc32(data) === crc }); at += 46 + nlen + xlen + clen;
  }
  return out;
}
