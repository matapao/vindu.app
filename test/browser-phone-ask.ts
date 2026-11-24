// An ask that is open before the phone window connects reaches it, and answering it there closes it on the computer: the
// app keeps an open ask for a phone that comes later (its replay), and the phone keeps it through the window's layout
// changes until it goes. Desktop's page and the phone's are opened in a Chromium of the test's own (Playwright's). Not
// part of npm test: it needs that Chromium.   node dist/test/browser-phone-ask.js
import fs from 'node:fs';
import { connectConsumer, processors } from './consumer.js';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { startApp } from '../src/app.js';
import { openDesktop } from './browse.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const check = (cond: unknown, what: string) => { if (!cond) throw new Error(`not ok: ${what}`); console.log(`ok ${++passed} - ${what}`); };
async function until<T>(f: () => Promise<T> | T, what: string, ms = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); }
}

await (async () => {
  let code = 1;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-ask-')), work = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-ask-work-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ tasksFolder: work, person: { name: 'Sam' } }));
  const a = await startApp({ userData, processors, connect: connectConsumer });
  const d = await openDesktop(a), js = d.js; // Desktop's page, as the person's browser opens it
  const browser = await chromium.launch({ headless: true }); let phone: Page | undefined;
  try {
    await until(() => js<boolean>('!!document.getElementById("place")'), 'the window');
    // a task whose harness asks before a command, on its first turn: the ask waits in the thread
    await js(`(() => { const p = document.getElementById('prompt'); p.value = 'Run the tests and show them.'; p.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(() => js<boolean>(`!document.getElementById('send').disabled`), 'Send'); await js(`document.getElementById('send').click()`);
    const task = await until(() => a.activity().entries[0]?.id, 'the task');
    await until(() => a.activity().entries.find(e => e.id === task)?.state === 'waiting', 'the ask, waiting', 30_000);
    check(true, 'the harness asks before a command; the ask waits for the person');
    // the phone window, only now
    await a.togglePhone(); const url = (a.phone() as { url?: string } | undefined)?.url;
    check(!!url, 'the phone window is on, after the ask');
    phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    await phone.goto(url!);
    const pjs = <T = unknown>(c: string) => phone!.evaluate(c) as Promise<T>;
    const text = (sel: string) => `(() => { const t = n => [...n.childNodes].map(c => c.nodeType === 3 ? c.data : c.nodeType === 1 ? (c.shadowRoot ? t(c.shadowRoot) : '') + t(c) : '').join(''); const r = document.querySelector(${JSON.stringify(sel)}); return r ? t(r) : ''; })()`;
    await until(async () => /Yes, and don't ask again|npm test/.test(await pjs<string>(`${text('#asks')} + ${text('#views')}`)), 'the ask on the phone', 15_000)
      .catch(async e => { console.log('# the phone shows:', JSON.stringify(await pjs<string>(`document.body.innerText.slice(0, 600)`)), '| asks area:', await pjs<string>(`(() => { const a = document.getElementById('asks'); return a ? (a.hidden ? 'hidden' : 'shown') + ' ' + a.children.length : 'missing'; })()`)); throw e; });
    check(true, 'the ask that was open before the phone connected is on the phone');
    // answered on the phone: the first of the harness's options
    const pressed = await pjs<string | null>(`(() => {
      const t = n => [...n.childNodes].map(c => c.nodeType === 3 ? c.data : c.nodeType === 1 ? (c.shadowRoot ? t(c.shadowRoot) : '') + t(c) : '').join('');
      const buttons = n => [...n.querySelectorAll('*')].flatMap(e => [...(e.tagName === 'BUTTON' ? [e] : []), ...(e.shadowRoot ? buttons(e.shadowRoot) : [])]);
      const b = buttons(document.getElementById('asks')).find(b => /^Yes$/.test(t(b).trim())); if (!b) return null; b.click(); return t(b).trim(); })()`);
    check(pressed === 'Yes', 'the person answers it on the phone');
    await until(() => { const answers = fs.readFileSync(path.join(userData, 'tasks', task, 'ui-calls.jsonl'), 'utf8').split('\n').filter(l => l.includes('"answer"')); return answers.some(l => l.includes('"window":"phone"')); }, 'the answer, from the phone');
    check(true, 'the answer is kept with the phone window as where it came from');
    await until(async () => !/npm test/.test(await pjs<string>(`${text('#asks')} + ${text('#views')}`)), 'the ask gone from the phone', 10_000);
    check(true, 'the ask leaves the phone once answered');
    // A second task starts at the same ticket number and asks for a file and multiple choices.
    const form = { name: 'Documents', inputs: {
      areas: { type: 'string', title: 'Areas', enum: ['a', 'b'], labels: ['North', 'South'], multi: true },
      file: { type: 'string', title: 'Document', format: 'file' },
    }, slots: { report: { title: 'Report', block: 'free' } } };
    fs.mkdirSync(a.templatesDir, { recursive: true });
    fs.writeFileSync(path.join(a.templatesDir, 'documents.json'), JSON.stringify(form));
    await js("desktop.create({id:'second',harness:'claude',template:'documents.json'}).then(() => desktop.shown('second'))");
    const submit = phone.getByRole('button', { name: 'Submit', exact: true });
    await submit.waitFor();
    await submit.click(); // validation returns the same ticket, which can be corrected
    await phone.locator('.ask-error').waitFor();
    await phone.route('**/capture', route => route.fulfill({ status: 413, body: '{}' }), { times: 1 });
    await phone.getByLabel('Document', { exact: true }).setInputFiles({ name: 'rejected.txt', mimeType: 'text/plain', buffer: Buffer.from('Rejected by uplink') });
    await submit.click();
    await phone.getByText('Choose smaller files.', { exact: false }).waitFor();
    await phone.getByLabel('Areas').selectOption(['a', 'b']);
    await phone.getByLabel('Document', { exact: true }).setInputFiles({ name: 'letter.txt', mimeType: 'text/plain', buffer: Buffer.from('A test document') });
    await submit.click();
    const second = await until(() => a.tasks.get('second'), 'second task');
    await until(() => fs.readFileSync(path.join(userData, 'tasks', 'second', 'ui-calls.jsonl'), 'utf8').includes('"areas":["a","b"]'), 'both choices recorded');
    const attachments = second.record.all().filter(e => e.kind === 'attachment');
    check(attachments.some(e => e.name === 'letter.txt'), 'the next task accepts a corrected phone answer with both choices and the chosen attachment');
    code = 0;
    console.log(`# ${passed} passed`);
  } catch (e) { console.log(`not ok - ${(e as Error).message}`); }
  finally { await browser.close().catch(() => undefined); await d.close().catch(() => undefined); await a.close().catch(() => undefined); process.exit(code); }
})();
