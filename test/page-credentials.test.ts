// Desktop's page addresses stay the same from one start to the next, and a token file that does not read gives fresh ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { keptToken } from '../src/page-credentials.js';

test('a token file that does not read gets fresh credentials, kept from then on', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-tokens-'))), file = path.join(dir, 'pages.json');
  try {
    fs.writeFileSync(file, '{"desktop":"');
    const issued = keptToken(file, 'desktop');
    assert.match(issued, /^[\w-]{32}$/);
    assert.equal(keptToken(file, 'desktop'), issued);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
