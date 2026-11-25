// The app's own server process, as the Electron app runs it: the same server `pnpm start` runs (src/main.ts), on the
// Electron app's own Node, with no browser opened, and given the window's link (link.ts) so its browser views' pages live
// here; or one running already on this computer (started in a terminal, or as a login service), which the Electron app
// uses and leaves running, with no link. The server says where its Desktop is in a line of its own, and the app opens that.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';

/** The server: inside the app as it is packed (its resources' server/, by scripts/pack.mjs), or built beside this folder
 *  (pnpm build in the app), or where VINDU_SERVER says. */
const SERVER = process.env.VINDU_SERVER ?? (app.isPackaged ? path.join(process.resourcesPath, 'server', 'dist', 'src', 'main.js') : path.join(import.meta.dirname, '..', '..', '..', 'dist', 'src', 'main.js'));

export type AppServer = {
  /** Desktop's address, token and all. */
  url: string;
  /** Whether the Electron app started it: then it stops it as it quits. One found running is left running. */
  owned: boolean;
  /** Stopped, and all it started (tasks, their pages): what it does on SIGTERM. */
  stop(): Promise<void>;
};

/** The server started, or found running. link: where the window's link is, and its token, for the server to take out of
 *  its environment at once. onExit: it stopped by itself (not by stop()). */
export function startServer(o: { link?: { address: string; token: string }; onExit?: (why: string) => void } = {}): Promise<AppServer> {
  const child: ChildProcess = spawn(process.execPath, [SERVER, '--no-open'], { cwd: path.dirname(path.dirname(path.dirname(SERVER))),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(o.link ? { VINDU_FRAME: o.link.address, VINDU_FRAME_TOKEN: o.link.token } : {}) }, stdio: ['ignore', 'pipe', 'inherit'] });
  let stopping = false;
  return new Promise<AppServer>((resolve, reject) => {
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
    child.once('error', e => { if (!done) { done = true; reject(new Error(`Vindu's server did not start (${SERVER}): ${e.message}`)); } });
    child.once('exit', (code, signal) => {
      if (!done) { done = true; reject(new Error(`Vindu's server stopped as it started (${signal ?? `exit code ${code}`}): ${SERVER}`)); return; }
      if (!stopping && /^vindu: /m.test(said)) o.onExit?.(signal ?? `exit code ${code}`); // one found running leaves at once: that is no stop
    });
  });
}
