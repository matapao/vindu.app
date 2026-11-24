import type { Ask } from '@matapao/vindu/server';

/** Maximum bytes of JSON the phone can send in one request, including base64 file data. */
export const PHONE_BODY_LIMIT = 40 * 1024 * 1024;

/** The host compares these IDs when the person submits a shared form. */
export function fileSelection(ask: Ask): Record<string, string[]> {
  return Object.fromEntries(Object.entries(ask.fields).filter(([, field]) => field.format === 'file')
    .map(([key]) => [key, ask.files?.[key]?.ids ?? []]));
}
