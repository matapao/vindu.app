// What the app asks of the system it runs on, now that no browser window of its own does it: the system's own dialogs
// for a folder, files, or where to save; opening a folder or an address with what the person uses for it; the
// clipboard's text; where the app keeps its folder. Each by the system's own tools (macOS: osascript, open, pbpaste;
// Linux: zenity, xdg-open, wl-paste or xclip; Windows: PowerShell), so the app needs nothing installed for them. The
// dialogs are this computer's: the app's pages are opened in a browser on this computer.
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const mac = process.platform === 'darwin', windows = process.platform === 'win32';

/** A command's output; null when it was called off (a dialog the person closed) or failed. */
const run = (command: string, args: string[], input?: string) => new Promise<string | null>(resolve => {
  const p = execFile(command, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? null : String(out)));
  if (input !== undefined) p.stdin?.end(input);
});
/** AppleScript run with its words as arguments, never written into the script. */
const osascript = (lines: string[], args: string[]) => run('osascript', [...lines.flatMap(l => ['-e', l]), ...args]);
const ps = (script: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script]);
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Where the app keeps its folder, as Electron kept it before: the system's place for an app's data, under its name. */
export function appDataDir(name: string): string {
  if (mac) return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (windows) return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), name);
}

/** The person's language and region, as the system has them. */
export const locale = () => Intl.DateTimeFormat().resolvedOptions().locale;

/** A folder or a file, opened as the system opens it (a folder in its file manager). */
export function openPath(p: string): void {
  const [c, a] = mac ? ['open', [p]] : windows ? ['explorer.exe', [p]] : ['xdg-open', [p]];
  spawn(c, a, { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}
/** A web address, in the person's own browser. */
export function openAddress(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const [c, a] = mac ? ['open', [url]] : windows ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  spawn(c, a, { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

/** A folder the person picks; null if they did not. */
export async function pickFolder(title: string): Promise<string | null> {
  const out = mac ? await osascript(['on run argv', 'activate', 'return POSIX path of (choose folder with prompt (item 1 of argv))', 'end run'], [title])
    : windows ? await ps(`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = ${psQuote(title)}; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`)
    : await run('zenity', ['--file-selection', '--directory', `--title=${title}`]);
  const p = out?.trim(); return p ? p.replace(/(.)\/$/, '$1') : null;
}

/** Files the person picks, of these extensions if any are given; none if they did not. */
export async function pickFiles(title: string, o: { many?: boolean; extensions?: string[] } = {}): Promise<string[]> {
  const ext = (o.extensions ?? []).filter(e => /^\w+$/.test(e));
  let out: string | null;
  if (mac) {
    out = await osascript(['on run argv', 'activate', 'set kinds to {}', 'repeat with i from 3 to count of argv', 'set end of kinds to item i of argv', 'end repeat',
      'if (item 2 of argv) is "many" then', 'if kinds is {} then', 'set picked to choose file with prompt (item 1 of argv) with multiple selections allowed', 'else',
      'set picked to choose file with prompt (item 1 of argv) of type kinds with multiple selections allowed', 'end if', 'else', 'if kinds is {} then',
      'set picked to {choose file with prompt (item 1 of argv)}', 'else', 'set picked to {choose file with prompt (item 1 of argv) of type kinds}', 'end if', 'end if',
      'set out to ""', 'repeat with f in picked', 'set out to out & POSIX path of f & linefeed', 'end repeat', 'return out', 'end run'], [title, o.many ? 'many' : 'one', ...ext]);
  } else if (windows) {
    out = await ps(`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = ${psQuote(title)}; $d.Multiselect = ${o.many ? '$true' : '$false'}; ${ext.length ? `$d.Filter = ${psQuote(`Files|${ext.map(e => `*.${e}`).join(';')}`)};` : ''} if ($d.ShowDialog() -eq 'OK') { $d.FileNames -join [char]10 }`);
  } else {
    out = await run('zenity', ['--file-selection', `--title=${title}`, ...(o.many ? ['--multiple', '--separator=\n'] : []), ...(ext.length ? [`--file-filter=${ext.map(e => `*.${e}`).join(' ')}`] : [])]);
  }
  return (out ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/** Where the person saves a file, starting from a name and a folder; null if they did not. */
export async function pickSave(title: string, name: string, folder: string): Promise<string | null> {
  const out = mac ? await osascript(['on run argv', 'activate', 'return POSIX path of (choose file name with prompt (item 1 of argv) default name (item 2 of argv) default location (POSIX file (item 3 of argv)))', 'end run'], [title, name, folder])
    : windows ? await ps(`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.SaveFileDialog; $d.Title = ${psQuote(title)}; $d.FileName = ${psQuote(name)}; $d.InitialDirectory = ${psQuote(folder)}; if ($d.ShowDialog() -eq 'OK') { $d.FileName }`)
    : await run('zenity', ['--file-selection', '--save', '--confirm-overwrite', `--title=${title}`, `--filename=${path.join(folder, name)}`]);
  return out?.trim() || null;
}

/** The clipboard's text now; empty when it holds none. */
export async function clipboardText(): Promise<string> {
  if (mac) return (await run('pbpaste', [])) ?? '';
  if (windows) return ((await ps('Get-Clipboard -Raw')) ?? '').replace(/\r?\n$/, '');
  return (await run('wl-paste', ['--no-newline'])) ?? (await run('xclip', ['-selection', 'clipboard', '-o'])) ?? '';
}
