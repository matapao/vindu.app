// A task's record, as a restored view reads it again: each result by its ref (the record's id), from the record on disk,
// with nothing called again; a pointer to another call, or to a file that is gone, finds nothing. All synthetic.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskRecord } from '../src/task-record.js';

test('a restored view finds each result its record keeps, by its ref, and an attachment while its file is there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-task-record-'));
  try {
    const record = new TaskRecord(dir);
    const sent = record.addResult({ server: 'ledger', tool: 'send_invoice', input: { invoice: 'INV-0042' }, text: 'sent', raw: { ok: true }, fidelity: 'exact', via: 'celler' });
    assert.equal(sent.ref, sent.id);
    const file = path.join(dir, 'plan.md'); fs.writeFileSync(file, '# Plan\n');
    const plan = record.addAttachment('plan.md', 'text/markdown', file);

    const reopened = new TaskRecord(dir); // as the app starts again
    const pointer = { id: sent.id, kind: 'result' as const, server: 'ledger', tool: 'send_invoice', ref: sent.id };
    assert.equal(reopened.kept(pointer), sent.id, 'a tool that changes things is found by its ref, never called again');
    assert.equal(reopened.kept({ ...pointer, ref: undefined, input: { invoice: 'INV-0042' } }), sent.id, 'or by its call, where a pointer names no ref');
    assert.equal(reopened.kept({ ...pointer, ref: undefined, input: { invoice: 'INV-0043' } }), undefined, 'another call');
    assert.equal(reopened.kept({ ...pointer, tool: 'list_invoices' }), undefined, 'another tool');
    assert.equal(reopened.kept({ ...pointer, ref: 'r9' }), undefined, 'a ref this record does not keep');

    const attached = { id: plan.id, kind: 'attachment' as const, name: 'plan.md', mime: 'text/markdown', file };
    assert.equal(reopened.kept(attached), plan.id);
    fs.rmSync(file);
    assert.equal(reopened.kept(attached), undefined, 'the file is gone');

    const carried = reopened.carry(sent, 'parent');
    assert.notEqual(carried.id, sent.id);
    assert.equal(carried.kind === 'result' ? carried.ref : undefined, carried.id, 'a carried result has a ref of its own');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
