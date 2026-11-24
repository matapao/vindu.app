// All app listeners accept origin-form request targets. Preserve the raw target when proxying.
export function requestTarget(raw: string | undefined): URL | null {
  if (!raw?.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('#')) return null;
  return URL.parse(raw, 'http://localhost');
}
