// Each task gets a working folder and typed attachments chosen by the person.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachment, workFolder } from '../src/work.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));

test('a task started without a folder gets one of its own, by the date and its first words, never one already there', () => {
  const root = path.join(tmp(), 'Vindu'); const day = new Date(2026, 10, 9);
  const a = workFolder(root, 'Hvilke fakturaer er forfalt, og hvor mye skylder Havgap Media oss?', day);
  assert.equal(path.basename(a), '2026-11-09-hvilke-fakturaer-er-forfalt-og-hvor'); assert.ok(fs.statSync(a).isDirectory());
  assert.equal(path.basename(workFolder(root, 'Hvilke fakturaer er forfalt, og hvor mye?', day)), '2026-11-09-hvilke-fakturaer-er-forfalt-og-hvor-2');
  assert.equal(path.basename(workFolder(root, 'Gjør det på nytt: åpne Bodø-rapporten', day)), '2026-11-09-gjor-det-pa-nytt-apne-bodo');
  assert.equal(path.basename(workFolder(root, '???', day)), '2026-11-09');
});

test('an attached file goes by its name, its type and its path; a folder, or nothing there, is no file', () => {
  const dir = tmp(); const f = path.join(dir, 'Fakturaer.CSV'); fs.writeFileSync(f, 'id\nINV-1');
  assert.deepEqual(attachment(f), { name: 'Fakturaer.CSV', mime: 'text/csv', file: f });
  assert.equal(attachment(path.join(dir, 'notes.weird'))?.mime, undefined); // not there
  fs.writeFileSync(path.join(dir, 'notes.weird'), '');
  assert.equal(attachment(path.join(dir, 'notes.weird'))?.mime, 'application/octet-stream'); // there: passed on as a link
  assert.equal(attachment(dir), undefined);
});
