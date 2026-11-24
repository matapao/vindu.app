// The person's other devices, paired with this core: a phone, a tablet, another computer's browser. The person makes a
// code on this computer (six digits, for ten minutes); the device opens the core's pairing page, at its address on their
// private network, types it, and is given a token of its own, which it keeps in the page's address, never in a cookie (a
// browser sends a host's cookies to every port on it, so to every page of the core's). Only its hash is kept here, so the devices file
// opens nothing. A code takes five tries; a device can be removed, and then its token opens nothing. Each device may give
// its push subscription, for notifications when no page of the person's is open (push.ts). A code made for an owner pairs
// one of the person's owner devices, which may set what Vindu may use (Processors) as this computer does: for a core
// no one sits at (a Pi), it is made there, on its command line (main.ts --pair --owner), or under Phone in its Settings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { PushSubscription } from './push.js';

export type Device = { id: string; name: string; hash: string; paired: string; seen?: string; push?: PushSubscription; owner?: boolean };
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const TRIES = 5, CODE_MS = 10 * 60_000;

export function devices(file: string, revoked?: (device: string) => void) {
  const read = (): Device[] => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Device[]; } catch { return []; } };
  const write = (all: Device[]) => fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  let code: { digits: string; until: number; tries: number; owner: boolean } | undefined;
  return {
    list: () => read().map(({ hash: _h, push, ...d }) => ({ ...d, push: !!push })),
    /** A new code to pair a device with, an owner device's when it says so: the last one no longer works. */
    newCode(o: { owner?: boolean } = {}) { code = { digits: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), until: Date.now() + CODE_MS, tries: 0, owner: o.owner === true }; return { code: code.digits, until: code.until, owner: code.owner }; },
    code: () => (code && code.until > Date.now() && code.tries < TRIES ? { code: code.digits, until: code.until, owner: code.owner } : null),
    /** The code typed on a device: its new token, or why not. One code pairs one device. */
    pair(digits: string, name: string): { token: string; id: string } | { error: string } {
      if (!code || code.until <= Date.now() || code.tries >= TRIES) return { error: 'There is no code to pair with now: make one on the computer, under Phone.' };
      if (!/^\d{6}$/.test(digits) || !crypto.timingSafeEqual(Buffer.from(digits), Buffer.from(code.digits))) {
        if (++code.tries >= TRIES) code = undefined;
        return { error: code ? 'That is not the code.' : 'That was the last try: make a new code on the computer.' };
      }
      const owner = code.owner; code = undefined;
      const token = crypto.randomBytes(24).toString('base64url'), id = crypto.randomBytes(6).toString('hex');
      write([...read(), { id, name: String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'A device', hash: hash(token), paired: new Date().toISOString(), ...(owner ? { owner: true } : {}) }]);
      return { token, id };
    },
    /** The device a token is, if it is one. */
    of(token: string): Device | undefined { const h = hash(token); return read().find(d => crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(h))); },
    /** Whether a device is one of the person's owner devices, paired by an owner's code. */
    owner: (id: string) => read().some(d => d.id === id && d.owner === true),
    seen(id: string) { const all = read(), d = all.find(x => x.id === id); if (d) { d.seen = new Date().toISOString(); write(all); } },
    subscribe(id: string, push: PushSubscription | null) { const all = read(), d = all.find(x => x.id === id); if (!d) return false; if (push) d.push = push; else delete d.push; write(all); return true; },
    remove(id: string) {
      const all = read(), kept = all.filter(d => d.id !== id);
      if (kept.length === all.length) return false;
      write(kept); revoked?.(id); return true;
    },
    subscribed: () => read().filter(d => d.push).map(d => ({ id: d.id, push: d.push! })),
  };
}
export type Devices = ReturnType<typeof devices>;
