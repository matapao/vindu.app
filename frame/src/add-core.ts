// The window where the person adds a core elsewhere: its address, and the code made under Phone in Settings there. A form and nothing
// else: no script, no preload, no way to the app but the address it is sent to (vindu-add:), which the app takes before
// anything loads (main.ts), pairs with (cores.ts), and answers by drawing the form again with what happened.
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export const ADD_SCHEME = 'vindu-add:';

/** The form, as a page of its own: what was typed, kept, and what happened (an error, or that it is added). */
export function addCorePage(o: { address?: string; name?: string; said?: string; done?: boolean } = {}): string {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Add a core</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action ${ADD_SCHEME}">
<style>
  :root { color-scheme: light dark; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { margin: 0; padding: 22px 24px; background: light-dark(#fcfcfb, #1a1a19); color: light-dark(#0b0b0b, #f0efec); }
  h1 { font-size: 16px; margin: 0 0 6px; } p { margin: 0 0 14px; color: light-dark(#52514e, #c3c2b7); }
  label { display: grid; gap: 4px; margin: 0 0 12px; } input { font: inherit; padding: 7px 9px; border: 1px solid light-dark(#d6d5cf, #353533); border-radius: 6px; background: transparent; color: inherit; }
  #code { font: 600 20px ui-monospace, Menlo, monospace; letter-spacing: 6px; }
  button { font: inherit; font-weight: 600; padding: 7px 14px; border: 0; border-radius: 6px; background: light-dark(#2a78d6, #3987e5); color: #fff; }
  .said { padding: 8px 10px; border-radius: 6px; background: light-dark(#f6f5f1, #151514); margin: 0 0 12px; } .bad { color: #d70015; } .good { color: #1f8a3b; }
</style></head><body>
<h1>Add a core elsewhere</h1>
<p>A Pi, a Mac mini or a server running vindu, on your tailnet. There, in Settings, under Phone, put vindu on the tailnet and make a code; type its address and the code here.</p>
${o.said ? `<p class="said ${o.done ? 'good' : 'bad'}">${esc(o.said)}</p>` : ''}
${o.done ? '' : `<form action="${ADD_SCHEME}add" method="get">
<label>Its address <input name="address" value="${esc(o.address ?? '')}" placeholder="https://mini.tail1234.ts.net:7300" required autocomplete="off"></label>
<label>Its code <input id="code" name="code" inputmode="numeric" maxlength="6" required autocomplete="one-time-code"></label>
<label>A name for it <input name="name" value="${esc(o.name ?? '')}" placeholder="The Mac mini" maxlength="40"></label>
<button>Add</button></form>`}
</body></html>`;
  return `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
}
