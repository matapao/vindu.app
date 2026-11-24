export const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
export const button = (cls: string, text: string, click: () => void) => {
  const b = element('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', click);
  return b;
};
export const errorMessage = (err: unknown) =>
  String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); // the main process's own words
const plain = (s: string) =>
  s
    .replace(/[`*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
export const firstLine = (s: string) => {
  const l = s.split('\n').map(plain).find(Boolean) ?? '';
  return l.length > 120 ? `${l.slice(0, 119)}…` : l;
};
export const chip = (name: string, remove?: () => void, label = 'Remove') => {
  const c = element('span', 'chip');
  c.append(element('span', '', name));
  if (remove) {
    const x = button('', '×', remove);
    x.title = label;
    x.setAttribute('aria-label', label);
    c.append(x);
  }
  return c;
};

export const lastPart = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
