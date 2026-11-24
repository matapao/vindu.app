import assert from 'node:assert/strict';
import test from 'node:test';
import { appOf, linkIn } from '../src/links.js';

test('a launch takes its Vindu link from argv and resolves the app id', () => {
  const link = 'VINDU://desktop/inbox?message=1';
  assert.equal(linkIn(['electron', '/app', link]), link);
  assert.equal(appOf(link), 'desktop');
  assert.equal(linkIn(['electron', '/app']), undefined);
});

test('malformed links never select an app', () => {
  const malformed = [
    'vindu:desktop', 'vindu://', 'vindu://%zz/x', 'vindu://bad app/x',
    `vindu://desktop${'/x'.repeat(5000)}`, 'https://desktop/path',
  ];
  for (const link of malformed) assert.equal(appOf(link), undefined, link.slice(0, 48));
});
