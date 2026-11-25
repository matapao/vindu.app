/** Both page sockets and the Electron window's link carry JSON objects. */
export function readObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Ignore an incomplete or invalid message. */ }
  return undefined;
}

export function isCallId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

type PageRequest =
  | { t: 'call'; id: number; ch: string; a: unknown[] }
  | { t: 'post'; ch: string; a: unknown[] };

export function readPageRequest(text: string): PageRequest | undefined {
  const message = readObject(text);
  if (!message || typeof message.ch !== 'string' || !Array.isArray(message.a)) return undefined;
  const { t, ch, a, id } = message;
  if (t === 'call' && isCallId(id)) return { t, id, ch, a };
  if (t === 'post') return { t, ch, a };
  return undefined;
}
