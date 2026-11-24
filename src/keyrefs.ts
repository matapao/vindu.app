// Resolve named keys in the host for Celler connector adapters. The agent does not receive them.
import type { ServerSpec } from './connectors.js';

type Entry = { name: string; value?: string; key?: string; prefix?: string };
const KEYLIKE = /key|token|secret|passw|credential|auth|cookie/i;

/** Where a key is looked for in the app's environment, when it is not kept: VINDU_KEY_<NAME>. */
export const envName = (n: string) => `VINDU_KEY_${n.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** The keys the settings' servers name, each with what it is for, to list where each is (never what it is). */
export const serverKeys = (servers: ServerSpec[]): { key: string; title: string }[] =>
  servers.flatMap(s => entries(s).filter(e => typeof e.key === 'string').map(e => ({ key: e.key!, title: `${s.name} (${e.name})` })));

const entries = (s: ServerSpec): Entry[] => (('command' in s ? (s as { env?: Entry[] }).env : (s as { headers?: Entry[] }).headers) ?? []);

/** The servers with their keys from where the app keeps them. A server whose key is not set is not started, since it
 *  would fail without it; the notes say why, and what is written out that should not be. */
export async function withKeys(servers: ServerSpec[], keyNamed: (name: string) => Promise<string | undefined>): Promise<{ servers: ServerSpec[]; notes: string[] }> {
  const out: ServerSpec[] = [], notes: string[] = [];
  for (const s of servers) {
    const plain: { name: string; value: string }[] = [], secrets: { name: string; value: string }[] = [];
    let unset: Entry | undefined;
    for (const e of entries(s)) {
      if (typeof e.key !== 'string') {
        if (e.value && KEYLIKE.test(e.name)) notes.push(`the server "${s.name}" has ${e.name} written out in settings.json: keep it with the app's keys instead ({ "name": "${e.name}", "key": "…" }, set in the Connector Keys page (the key button in Activity))`);
        plain.push({ name: e.name, value: e.value ?? '' });
        continue;
      }
      const v = await keyNamed(e.key);
      if (v === undefined) { unset = e; break; }
      secrets.push({ name: e.name, value: `${e.prefix ?? ''}${v}` });
    }
    if (unset) { notes.push(`the server "${s.name}" takes the key "${unset.key}" (for ${unset.name}), which is not set yet: set it on the Connector Keys page (the key button in Activity), or as ${envName(unset.key!)} in the app's environment. It is not started`); continue; }
    out.push({ ...s, ['command' in s ? 'env' : 'headers']: plain, ...(secrets.length ? { secrets: [...(s.secrets ?? []), ...secrets] } : {}) } as ServerSpec);
  }
  return { servers: out, notes };
}
