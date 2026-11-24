// The task folder keeps UI state and conversation. Live processes, endpoint credentials and pending approvals stay in memory.
import fs from 'node:fs';
import path from 'node:path';
import type { ViewCheckpoint } from '@matapao/vindu/server';
import type { Activity } from './activity.js';
import type { Act } from './work.js';
import { writePrivateJson } from './page-credentials.js';

export type Opening = { harness: string; servers?: string[]; connectors?: string[]; template?: string; inference?: string };
export type ThreadItem =
  | { kind: 'user'; text: string; files: { name: string }[] }
  | { kind: 'text' | 'note' | 'told' | 'error'; text: string }
  | { kind: 'act'; event: Act };
/** An open task of Desktop's, as its folder keeps it to reopen it. */
export type DesktopTaskCheckpoint = {
  version: 1; cwd: string; opening: Opening; readsOnly: boolean;
  activity: Activity; named: boolean; view: ViewCheckpoint; thread: ThreadItem[];
};

export class TaskCheckpoints {
  constructor(private readonly root: string) {}
  private file(id: string) { return path.join(this.root, id, 'open-task.json'); }
  save(id: string, data: DesktopTaskCheckpoint) { writePrivateJson(this.file(id), data); }
  close(id: string) {
    const file = this.file(id);
    fs.renameSync(file, path.join(path.dirname(file), 'closed-task.json'));
  }
  *open(): Generator<{ id: string; load: () => DesktopTaskCheckpoint }> {
    if (!fs.existsSync(this.root)) return;
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      const id = entry.name;
      if (!entry.isDirectory() || !/^[\w-]{1,64}$/.test(id)) continue;
      const file = this.file(id);
      if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
      yield { id, load() {
        const data: DesktopTaskCheckpoint = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.version !== 1 || data.activity?.id !== id || data.activity.harness !== data.opening?.harness ||
            typeof data.readsOnly !== 'boolean' || !Array.isArray(data.thread) ||
            !Array.isArray(data.view?.views) || !Array.isArray(data.activity.problems)) throw new Error('Invalid task checkpoint.');
        if (!path.isAbsolute(data.cwd) || fs.realpathSync(data.cwd) !== data.cwd || !fs.statSync(data.cwd).isDirectory()) throw new Error('The original workspace is unavailable.');
        return data;
      } };
    }
  }
}
