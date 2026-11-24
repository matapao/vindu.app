// Notifications to the person's phones and browsers when no page of theirs is open: Web Push, through the push service
// each browser uses (Apple's, Google's, Mozilla's, Microsoft's). The core sends them itself, outbound, each encrypted for
// its device (RFC 8291, aes128gcm), and signed with the core's own keys (VAPID, RFC 8292), made once and kept in its
// folder: nothing is hosted by anyone, and no account is needed. Only to those services, never to an address a device
// could make up. Nothing but Node's own crypto.
import crypto from 'node:crypto';
import fs from 'node:fs';

export type PushKeys = { publicKey: string; privateKey: string }; // the public key as a browser takes it (base64url, 65 bytes); the private one as PEM
export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushResult = { outcome: 'sent' | 'gone' | 'failed'; reason?: string };

/** The core's keys: read from where they are kept, or made once and kept there (only this user's). */
export function pushKeys(file: string): PushKeys {
  try { const k = JSON.parse(fs.readFileSync(file, 'utf8')) as PushKeys; if (k.publicKey && k.privateKey) return k; } catch { /* none yet */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const keys = { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url'), privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
  fs.writeFileSync(file, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  return keys;
}

/** The push services browsers use. */
export function pushServiceAllowed(endpoint: string): boolean {
  try {
    const u = new URL(endpoint); if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(h) || h.endsWith('.push.apple.com') || h.endsWith('.notify.windows.com');
  } catch { return false; }
}

/** A subscription as a browser hands it over, or null: its endpoint, and its keys as they must be. */
export function subscriptionOf(v: unknown): PushSubscription | null {
  const s = v as PushSubscription;
  if (!s || typeof s.endpoint !== 'string' || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string' || s.endpoint.length > 2048) return null;
  if (!/^[\w-]+$/.test(s.keys.p256dh) || !/^[\w-]+$/.test(s.keys.auth)) return null;
  const key = Buffer.from(s.keys.p256dh, 'base64url');
  if (key.length !== 65 || key[0] !== 4 || Buffer.from(s.keys.auth, 'base64url').length !== 16) return null;
  try { crypto.ECDH.convertKey(key, 'prime256v1'); } catch { return null; }
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, n: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));
/** A message encrypted for one device (RFC 8291, aes128gcm): the body a push service takes. */
export function encrypt(sub: PushSubscription, plaintext: Buffer, o: { salt?: Buffer; ecdh?: crypto.ECDH } = {}): Buffer {
  const ua = Buffer.from(sub.keys.p256dh, 'base64url'), auth = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = o.ecdh ?? crypto.createECDH('prime256v1'); if (!o.ecdh) ecdh.generateKeys();
  const as = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua);
  const ikm = hkdf(secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32);
  const salt = o.salt ?? crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16), nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()]); // one record, the last: its delimiter 2
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = as.length;
  return Buffer.concat([head, as, sealed]);
}

/** The core's signature for one push service (VAPID): a JWT for its origin, good for twelve hours. */
export function vapid(endpoint: string, keys: PushKeys, subject: string, now = Date.now()): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${b64({ typ: 'JWT', alg: 'ES256' })}.${b64({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${sig.toString('base64url')}, k=${keys.publicKey}`;
}

/** One notification, sent: taken, gone (turned off there, or the web app removed), or not taken and why. subject: who
 *  sends it, as the service is told: the core's own address, never an e-mail address (Apple refuses one made up). */
export async function sendPush(sub: PushSubscription, message: { title: string; body: string; url?: string; tag?: string }, keys: PushKeys, subject: string,
  o: { fetch?: typeof fetch; allowed?: (endpoint: string) => boolean; urgent?: boolean } = {}): Promise<PushResult> {
  if (!(o.allowed ?? pushServiceAllowed)(sub.endpoint)) return { outcome: 'failed', reason: 'not a push service a browser uses' };
  try {
    const r = await (o.fetch ?? fetch)(sub.endpoint, { method: 'POST', signal: AbortSignal.timeout(15_000), body: new Uint8Array(encrypt(sub, Buffer.from(JSON.stringify(message)))),
      headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(6 * 3600), Urgency: o.urgent ? 'high' : 'normal', Authorization: vapid(sub.endpoint, keys, subject) } });
    if (r.ok) return { outcome: 'sent' };
    const text = (await r.text().catch(() => '')).slice(0, 300); let said = text.split('\n')[0].trim();
    try { const why = (JSON.parse(text) as { reason?: unknown }).reason; if (typeof why === 'string') said = why; } catch { /* its own text */ }
    return { outcome: r.status === 404 || r.status === 410 ? 'gone' : 'failed', reason: `${r.status}${said ? ` ${said.slice(0, 80)}` : ''}` };
  } catch (e) { return { outcome: 'failed', reason: (e as Error)?.message?.slice(0, 80) ?? 'no answer' }; }
}
