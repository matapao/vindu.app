import { element } from './dom.js';

/** The reply's markdown as elements: paragraphs, headings, lists, tables, code, bold and italics. A link shows its
 *  words and its host, and opens nothing. */
export function renderMarkdown(src: string): DocumentFragment {
  const out = document.createDocumentFragment(),
    lines = src.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [],
    list: HTMLElement | undefined;
  const flush = () => {
    if (para.length) {
      const p = element('p');
      inline(p, para.join('\n'));
      out.append(p);
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      flush();
      list = undefined;
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.append(element('pre', '', code.join('\n')));
      continue;
    }
    if (/^\s*\|/.test(l)) {
      flush();
      list = undefined;
      const table = element('table');
      let first = true;
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        const tr = element('tr');
        for (const c of cells) {
          const cell = element(first ? 'th' : 'td');
          inline(cell, c);
          tr.append(cell);
        }
        table.append(tr);
        first = false;
      }
      i--;
      out.append(table);
      continue;
    }
    const head = /^#{1,6}\s+(.*)$/.exec(l);
    if (head) {
      flush();
      list = undefined;
      const p = element('p', 'h');
      inline(p, head[1]);
      out.append(p);
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (item) {
      flush();
      const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (list?.tagName.toLowerCase() !== tag) {
        list = element(tag);
        out.append(list);
      }
      const li = element('li');
      inline(li, item[2]);
      list.append(li);
      continue;
    }
    if (!l.trim()) {
      flush();
      list = undefined;
      continue;
    }
    if (list && /^\s+\S/.test(l)) {
      const li = list.lastElementChild as HTMLElement;
      li.append('\n');
      inline(li, l.trim());
      continue;
    }
    list = undefined;
    para.push(l);
  }
  flush();
  return out;
}
const host = (u: string) => {
  try {
    return new URL(u).host || u;
  } catch {
    return u;
  }
};
function inline(into: HTMLElement, s: string) {
  let at = 0;
  for (const m of s.matchAll(
    /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?![\s*])(.+?)\*(?!\w)|(?<!\w)_(?![\s_])(.+?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g,
  )) {
    into.append(s.slice(at, m.index));
    if (m[1] !== undefined) into.append(element('code', '', m[1]));
    else if (m[2] !== undefined || m[3] !== undefined) {
      const b = element('strong');
      inline(b, m[2] ?? m[3]);
      into.append(b);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      const e = element('em');
      inline(e, m[4] ?? m[5]);
      into.append(e);
    } else into.append(element('span', 'link', m[6]), element('span', 'url', ` (${host(m[7])})`));
    at = (m.index ?? 0) + m[0].length;
  }
  into.append(s.slice(at));
}
