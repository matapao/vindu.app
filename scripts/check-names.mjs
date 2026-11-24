// vindu names no other app, and none of the projects it came from: it is its own app. This fails on any
// file that does. The names are those, past and present; a new one joins the list.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const self = fileURLToPath(import.meta.url);
const NAMES = /\b(randoms|zirbel|thirtyfive|35d|skal)\b|thirtyfive desks|matapao-core|matapao\/core\b|senter-host|vindu-randoms/i;
const SKIP = new Set(['node_modules', 'dist', 'out', '.git', 'icons']);

const found = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (file !== self && name !== 'pnpm-lock.yaml' && !/\.(png|ico|icns)$/.test(name)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => NAMES.test(line) && found.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 120)}`));
    }
  }
};
walk(root);
if (found.length) {
  console.error(`Names vindu never uses:\n${found.join('\n')}`);
  process.exit(1);
}
console.log('No project is named.');
