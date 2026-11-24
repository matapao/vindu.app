// This computer's core, as the desktop app runs it: the same core `pnpm start` runs (src/main.ts), on the app's
// own Node, with no browser opened, and given the app's link (link.ts) so its browser views' pages live here; or one
// running already (started in a terminal), which the app uses and leaves running, with no link. The core says where its
// shell is in a line of its own, and the app opens that. A client build has no core here, and starts none.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** Whether the app is a client build (scripts/pack.mjs --client, which says so in its package.json): the frame alone, with
 *  no core inside, for cores elsewhere only (a Pi's, a server's). It never starts a core on this computer, nor uses one
 *  running here. */
export const client = (() => {
  try { return (JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { client?: unknown }).client === true; } catch { return false; }
})();

/** The core: inside the app as it is packed (its resources' core/, by scripts/pack.mjs), or built beside this folder
 *  (pnpm build in vindu), or where VINDU_CORE says. */
const CORE = process.env.VINDU_CORE ?? (app.isPackaged ? path.join(process.resourcesPath, 'core', 'dist', 'src', 'main.js') : path.join(import.meta.dirname, '..', '..', '..', 'dist', 'src', 'main.js'));

export type Core = {
  /** The shell's address, token and all. */
  url: string;
  /** Whether the app started it: then it stops it as it quits. One started elsewhere is left running. */
  owned: boolean;
  /** Stopped, and all it started (tasks, the apps' servers): what it does on SIGTERM. */
  stop(): Promise<void>;
};

/** The core started, or found running. link: where the app's link is, and its token, for the core to take out of its
 *  environment at once. onExit: it stopped by itself (not by stop()). */
export function startCore(o: { link?: { address: string; token: string }; onExit?: (why: string) => void } = {}): Promise<Core> {
  const child: ChildProcess = spawn(process.execPath, [CORE, '--no-open'], { cwd: path.dirname(path.dirname(path.dirname(CORE))),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(o.link ? { VINDU_FRAME: o.link.address, VINDU_FRAME_TOKEN: o.link.token } : {}) }, stdio: ['ignore', 'pipe', 'inherit'] });
  let stopping = false;
  return new Promise<Core>((resolve, reject) => {
    let said = '', done = false;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      process.stdout.write(d); // its own words, as in a terminal
      if (done) return;
      said += d;
      const m = /^vindu( runs already)?: (http:\/\/\S+)\r?\n/m.exec(said); if (!m) return; // its whole line
      done = true;
      const owned = !m[1];
      resolve({
        url: m[2], owned,
        stop: () => new Promise<void>(r => {
          if (!owned || child.exitCode !== null || child.signalCode !== null) { r(); return; }
          stopping = true; child.once('exit', () => r()); child.kill('SIGTERM');
          setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 20_000).unref(); // it closes what it started first
        }),
      });
    });
    child.once('error', e => { if (!done) { done = true; reject(new Error(`the core did not start (${CORE}): ${e.message}`)); } });
    child.once('exit', (code, signal) => {
      if (!done) { done = true; reject(new Error(`the core stopped as it started (${signal ?? `exit code ${code}`}): ${CORE}`)); return; }
      if (!stopping && /^vindu: /m.test(said)) o.onExit?.(signal ?? `exit code ${code}`); // one found running leaves at once: that is no stop
    });
  });
}
