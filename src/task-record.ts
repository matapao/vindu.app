// A task's local projection for Vindu. Celler's run, call and approval audit stays in its own database.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AttachmentEntry, ResultEntry, ResultSource, Row } from '@matapao/vindu/server';

type Origin = { task: string; id: string };
type Attachment = AttachmentEntry & { at: string; digest: string; carried?: Origin };
type Result = ResultEntry & {
  at: string;
  digest: string;
  fidelity: 'exact' | 'reported';
  via: 'celler' | 'acp' | 'window' | 'device' | 'source' | 'tap' | 'proxy' | 'connector';
  carried?: Origin;
  raw?: unknown;
};
type Entry = Result | Attachment;
type NewResult = Pick<Result, 'tool' | 'server' | 'input' | 'fidelity' | 'via' | 'error'> & {
  text?: string;
  value?: unknown;
  rows?: Row[];
  raw: unknown;
  images?: { data: Buffer; mime: string }[];
};
const digest = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const safeName = (name: string) => path.basename(name).replace(/[^\w. -]/g, '_');

export class TaskRecord implements ResultSource {
  private readonly entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private results = 0;
  private attachments = 0;
  readonly file: string;
  readonly frames: string;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'record.jsonl');
    this.frames = path.join(dir, 'frames');
    fs.mkdirSync(this.frames, { recursive: true });
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as Entry;
      const index = Number(entry.id.slice(1));
      if (!Number.isSafeInteger(index) || index < 1 || this.byId.has(entry.id)) throw new Error('The task record is inconsistent.');
      this.remember(entry);
      if (entry.kind === 'result') this.results = Math.max(this.results, index);
      else this.attachments = Math.max(this.attachments, index);
    }
  }

  get(id: string): Entry | undefined { return this.byId.get(id); }
  all(): readonly Entry[] { return this.entries; }

  addResult(result: NewResult): Result {
    const { images = [], ...data } = result;
    const id = `r${++this.results}`;
    const saved = images.map((image, index) => {
      const file = this.artifact('images', `${id}-${index + 1}`);
      fs.writeFileSync(file, image.data, { mode: 0o600, flag: 'wx' });
      return { file, mime: image.mime };
    });
    return this.keep({
      ...data, id, kind: 'result', text: result.text ?? '', images: saved,
      at: new Date().toISOString(), digest: digest(JSON.stringify(result.raw ?? null)),
    });
  }

  addAttachment(name: string, mime: string, file: string): Attachment {
    return this.keep({ id: `a${++this.attachments}`, kind: 'attachment', name, mime, file,
      at: new Date().toISOString(), digest: digest(fs.readFileSync(file)) });
  }

  carry(entry: Entry, task: string): Entry {
    const carried = { task, id: entry.id };
    const at = new Date().toISOString();
    if (entry.kind === 'attachment') {
      const id = `a${++this.attachments}`;
      const file = this.artifact('carried', `${id}-${safeName(entry.name)}`);
      fs.copyFileSync(entry.file, file, fs.constants.COPYFILE_EXCL);
      return this.keep({ ...entry, id, file, carried, at });
    }
    const id = `r${++this.results}`;
    const images = entry.images.map((image, index) => {
      const file = this.artifact('images', `${id}-${index + 1}`);
      fs.copyFileSync(image.file, file, fs.constants.COPYFILE_EXCL);
      return { ...image, file };
    });
    return this.keep({ ...entry, id, images, carried, at });
  }

  frame(name: 'progress' | 'turns', value: unknown): void {
    fs.appendFileSync(path.join(this.frames, `${name}.jsonl`), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  private artifact(folder: string, name: string): string {
    const dir = path.join(this.dir, folder);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  }

  private remember(entry: Entry): void {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
  }

  private keep<E extends Entry>(entry: E): E {
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.remember(entry);
    return entry;
  }
}
