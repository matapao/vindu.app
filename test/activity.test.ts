// The activity column, without Electron: each task's state by what it needs from the person, the order (pinned first,
// then the groups, the longest wait first, muted last), the next task, and when the system's notification is worth it.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { arrange, stateOf, notifies, ago, type Activity } from '../src/activity.js';

const T0 = Date.parse('2026-11-11T09:00:00Z'); const min = 60_000;
const task = (id: string, o: Partial<Activity> = {}): Activity => ({ id, title: id, folder: `/work/${id}`, harness: 'claude', opened: T0, asks: [], due: { count: 0 }, problems: [], unseen: [], seenAt: T0, pinned: false, muted: false, ...o });

test('a task is in one state, the first that holds: an open ask, a problem not seen, a due reminder, what a hook said, a turn under way, something new, nothing', () => {
  assert.deepEqual(stateOf(task('a')), { state: 'quiet', since: T0, reason: 'nothing new' });
  assert.deepEqual(stateOf(task('a', { running: { since: T0 + min, what: 'Chase the overdue invoices' } })), { state: 'running', since: T0 + min, reason: 'working on "Chase the overdue invoices"' });
  assert.deepEqual(stateOf(task('a', { ended: { at: T0 + 2 * min, stop: 'end_turn' }, unseen: ['inv', 'todo'], changedAt: T0 + min })), { state: 'done', since: T0 + 2 * min, reason: 'finished: 2 new views, not seen yet' });
  assert.deepEqual(stateOf(task('a', { unseen: ['inv'], changedAt: T0 + min })), { state: 'done', since: T0 + min, reason: '1 new view, not seen yet' });
  assert.deepEqual(stateOf(task('a', { ended: { at: T0 - min, stop: 'end_turn' } })).state, 'quiet'); // finished before the person looked: seen
  assert.deepEqual(stateOf(task('a', { due: { count: 1, since: T0 + 3 * min, what: 'Send the VAT report' }, running: { since: T0, what: 'x' } })), { state: 'due', since: T0 + 3 * min, reason: 'reminder: Send the VAT report' });
  assert.deepEqual(stateOf(task('a', { problems: [{ at: T0 - min, what: 'old' }, { at: T0 + min, what: 'accounts: write (POST /invoices/INV-2026-0412/reminders): went, but not as approved' }], due: { count: 2, since: T0 } })),
    { state: 'wrong', since: T0 + min, reason: 'accounts: write (POST /invoices/INV-2026-0412/reminders): went, but not as approved' }); // the old one was seen
  assert.deepEqual(stateOf(task('a', { notices: [{ at: T0 + 2 * min, what: 'Watch: More than 50 000 is overdue' }], running: { since: T0, what: 'x' } })), { state: 'noticed', since: T0 + 2 * min, reason: 'Watch: More than 50 000 is overdue' }); // what a view's hook was written to say
  assert.equal(stateOf(task('a', { notices: [{ at: T0 - min, what: 'seen' }] })).state, 'quiet');
  const asks = [{ view: 'ask-2', title: 'Which suite should run again?', since: T0 + 5 * min }, { view: 'ask-1', title: 'npm test', since: T0 + 4 * min }];
  assert.deepEqual(stateOf(task('a', { asks, problems: [{ at: T0 + min, what: 'x' }] })), { state: 'waiting', since: T0 + 4 * min, reason: '2 questions: npm test; Which suite should run again?' });
});

test('the column: pinned first, then waiting, went wrong, due, done, running, quiet, the longest wait first; muted last; the next is the first that needs the person and is not in front', () => {
  const list = [
    task('quiet'),
    task('running', { running: { since: T0 + min, what: 'x' } }),
    task('done-late', { unseen: ['v'], changedAt: T0 + 9 * min }),
    task('done-early', { unseen: ['v'], changedAt: T0 + 2 * min }),
    task('waiting', { asks: [{ view: 'ask-1', title: 'npm test', since: T0 + 7 * min }] }),
    task('wrong', { problems: [{ at: T0 + 8 * min, what: 'the turn failed: no network' }] }),
    task('muted', { muted: true, asks: [{ view: 'ask-1', title: 'Sign in', since: T0 }] }),
    task('pinned', { pinned: true }),
  ];
  const { entries, next } = arrange(list, 'waiting');
  assert.deepEqual(entries.map(e => [e.id, e.state]), [['pinned', 'quiet'], ['waiting', 'waiting'], ['wrong', 'wrong'], ['done-early', 'done'], ['done-late', 'done'], ['running', 'running'], ['quiet', 'quiet'], ['muted', 'waiting']]);
  assert.deepEqual(entries.map(e => e.group), ['Quiet', 'Waiting for you', 'Went wrong', 'Done', 'Done', 'Running', 'Quiet', 'Waiting for you']);
  assert.equal(entries.find(e => e.id === 'waiting')!.front, true);
  assert.deepEqual([next?.id, next?.reason], ['wrong', 'the turn failed: no network']); // the one in front is not the next, nor the muted one
  assert.equal(arrange([task('a'), task('b', { running: { since: T0, what: 'x' } })]).next, undefined); // nothing needs the person
  assert.deepEqual(arrange(list.map(a => ({ ...a })), 'pinned').next?.id, 'waiting');
});

test('the system\'s notification: only what blocks a task (an ask) or a due reminder, when the person is not looking at it, never for a muted task, once per change', () => {
  const o = { front: false, focused: true, muted: false };
  assert.equal(notifies('running', 'waiting', o), true);
  assert.equal(notifies('waiting', 'waiting', o), false);                      // still the same: once
  assert.equal(notifies('quiet', 'due', o), true);
  assert.equal(notifies('running', 'done', o), false);                         // done waits in the column
  assert.equal(notifies('running', 'noticed', o), true);                       // what a hook was written to tell
  assert.equal(notifies('running', 'wrong', o), false);
  assert.equal(notifies('running', 'waiting', { ...o, front: true }), false);  // the person is looking at it
  assert.equal(notifies('running', 'waiting', { ...o, front: true, focused: false }), true); // in front, but the app is not
  assert.equal(notifies('running', 'waiting', { ...o, muted: true }), false);
  assert.deepEqual([ago(T0, T0 + 20_000), ago(T0, T0 + 12 * min), ago(T0, T0 + 130 * min), ago(T0, T0 + 3 * 24 * 60 * min)], ['now', '12 min', '2 h', '3 d']);
});
