// Tailscale on this computer, for the person's phone: whether it is installed and signed in, this computer's name on
// their private network, and serving the core's pages there over https (`tailscale serve`), each at its own port, so each
// app keeps an origin of its own; never on the internet (Funnel). Tailscale is the person's own, with their account on
// their devices: the core only runs its command line, and only when the person turns it on.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** How far Tailscale is: to install, to sign in to (or start), its https certificates to turn on, or ready. */
export type TailnetStep = 'install' | 'signin' | 'https' | 'ready';
export type Tailnet = { step: TailnetStep; host?: string };

/** Where Tailscale's command line is, in the places its installers put it: never whatever PATH finds. */
export function tailscaleCli(platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string | null {
  const places = platform === 'darwin' ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
    : platform === 'win32' ? [path.win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale', '/snap/bin/tailscale'];
  return places.find(p => exists(p)) ?? null;
}

/** Where Tailscale is, from `tailscale status --json`. */
export function tailnetOf(statusJson: string): Tailnet {
  let st: { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null };
  try { st = JSON.parse(statusJson) as typeof st; } catch { return { step: 'signin' }; } // installed, not answering: not running
  if (st.BackendState !== 'Running') return { step: 'signin' };
  const host = String(st.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
  if (!host || !(st.CertDomains ?? []).some(d => d.toLowerCase() === host)) return { step: 'https', ...(host ? { host } : {}) }; // MagicDNS and HTTPS certificates, in the tailnet's settings
  return { step: 'ready', host };
}

/** The ports the core serves now, and whether each is the core's, someone else's, or on the internet, from
 *  `tailscale serve status --json`. */
export function servedPorts(configJson: string, host: string): Map<number, { to?: number; funnel: boolean }> {
  let c: { TCP?: Record<string, { HTTPS?: boolean } | null>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string } | null> } | null>; AllowFunnel?: Record<string, boolean> };
  try { c = (JSON.parse(configJson || '{}') ?? {}) as typeof c; } catch { c = {}; }
  const out = new Map<number, { to?: number; funnel: boolean }>();
  for (const port of Object.keys(c.TCP ?? {}).map(Number)) {
    const key = `${host}:${port}`, h = Object.entries(c.Web?.[key]?.Handlers ?? {});
    const to = h.length === 1 && h[0][0] === '/' ? /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(h[0][1]?.Proxy ?? '')?.[1] : undefined;
    out.set(port, { ...(to ? { to: Number(to) } : {}), funnel: !!c.AllowFunnel?.[key] });
  }
  return out;
}

/** The proxy the core sets for one of its pages: https at the same port number on the tailnet, to that port here only. */
export const serveArgs = (port: number) => ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`];
export const serveOffArgs = (port: number) => ['serve', `--https=${port}`, 'off'];
/** A page Tailscale asks the person to open (to allow serving in their tailnet), from its output. */
export const tailscaleLink = (output: string) => /https:\/\/login\.tailscale\.com\/[^\s"']+/.exec(output)?.[0] ?? null;

/** Runs Tailscale's command line: its output, and whether it succeeded. */
export function runTailscale(cli: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => execFile(cli, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}` })));
}
