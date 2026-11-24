// The trusted core: the modules that hold the person's tokens and keys, serve the pages, and pair the
// person's devices. They take only Node's own modules and each other, nothing from a package, so what has to be trusted
// is what is here to read, and they stay small enough to read. The app wires in Celler for execution and Vindu for views.
// These modules do not import either library.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TRUSTED = ['web', 'socket-messages', 'page-credentials', 'request-target', 'lan-tls', 'page-doors', 'remote', 'phone-transfer', 'devices', 'push', 'tailnet', 'network', 'service', 'secrets', 'keyrefs', 'frame-link'];
const LINES = 2000; // the whole of it: past this, something in it belongs outside it
const BUILT = path.join(import.meta.dirname, '..', 'src'), SOURCE = path.join(import.meta.dirname, '..', '..', 'src');

/** What a module takes at run time, as it was built: its imports, its re-exports, and any import() or require(). */
const takes = (js: string) => [...js.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
  .map(m => m[1] ?? m[2] ?? m[3] ?? m[4]!);

test('the trusted core takes only Node\'s own modules and its own, and stays small', () => {
  let lines = 0;
  for (const m of TRUSTED) {
    const js = fs.readFileSync(path.join(BUILT, `${m}.js`), 'utf8');
    for (const spec of takes(js)) {
      const own = /^\.\/([\w-]+)\.js$/.exec(spec)?.[1];
      assert.ok(spec.startsWith('node:') || (own !== undefined && TRUSTED.includes(own)), `${m}.ts takes ${spec}: the trusted core takes only Node's own modules and its own`);
    }
    assert.ok(!/\bimport\(\s*[^'"\s)]/.test(js), `${m}.ts imports something it names at run time`);
    lines += fs.readFileSync(path.join(SOURCE, `${m}.ts`), 'utf8').split('\n').length;
  }
  assert.ok(lines <= LINES, `the trusted core is ${lines} lines, past ${LINES}: something in it belongs outside it`);
  console.log(`# the trusted core: ${TRUSTED.length} modules, ${lines} lines`);
});

test('what the rest of the app is, the trusted core does not take: the harnesses, the views, the window', () => {
  for (const m of TRUSTED) {
    const js = fs.readFileSync(path.join(BUILT, `${m}.js`), 'utf8');
    for (const outside of ['@matapao/celler', '@matapao/vindu', 'playwright-core', 'electron', '@agentclientprotocol/sdk', '@modelcontextprotocol']) assert.ok(!takes(js).some(s => s === outside || s.startsWith(`${outside}/`)), `${m}.ts takes ${outside}`);
  }
});
