import assert from 'node:assert/strict';
import test from 'node:test';
import { linkIn, windowOf } from '../src/links.js';

test('a launch takes its Vindu link from argv and resolves the window it names', () => {
  const link = 'VINDU://desktop/inbox?message=1';
  assert.equal(linkIn(['electron', '/app', link]), link);
  assert.equal(windowOf(link), 'desktop');
  assert.equal(linkIn(['electron', '/app']), undefined);
});

test('malformed links never select a window', () => {
  const malformed = [
    'vindu:desktop', 'vindu://', 'vindu://%zz/x', 'vindu://bad app/x',
    `vindu://desktop${'/x'.repeat(5000)}`, 'https://desktop/path',
  ];
  for (const link of malformed) assert.equal(windowOf(link), undefined, link.slice(0, 48));
});
