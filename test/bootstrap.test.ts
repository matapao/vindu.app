import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'vitest';

const project = path.resolve(import.meta.dirname, '../..');
const workspaces: string[] = [];
const names = ['celler', 'vindu'] as const;
type Pin = { url: string; sha: string };
type Pins = Record<typeof names[number], Pin>;
const sha = 'a'.repeat(40);
const pins: Pins = {
  celler: { url: 'https://example.invalid/celler.git', sha },
  vindu: { url: 'https://example.invalid/vindu.git', sha },
};

afterEach(() => {
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vindu-bootstrap-')));
  workspaces.push(parent);
  const app = path.join(parent, 'vindu.app');
  const scripts = path.join(app, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(path.join(project, 'scripts/bootstrap.mjs'), path.join(scripts, 'bootstrap.mjs'));
  // Exercise the real Git bootstrap, without installing dependencies or executing fetched code.
  const bin = path.join(parent, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pnpm.cmd'), '@exit /b 0\r\n');
  return {
    parent,
    build(config: Pins, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
      fs.writeFileSync(path.join(app, 'dependencies.json'), JSON.stringify(config));
      return spawnSync(process.execPath, [path.join(scripts, 'bootstrap.mjs'), ...args], {
        cwd: app, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GIT_ALLOW_PROTOCOL: 'file', ...env },
      });
    },
  };
}

test('both pins are checked before either dependency directory is created', () => {
  const fixture = workspace();
  for (const name of names) {
    for (const invalid of [{ url: '', sha: '' }, { ...pins[name], sha: 'main' }, { ...pins[name], url: 'http://example.invalid/repo' }]) {
      const result = fixture.build({ ...pins, [name]: invalid });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(name + '\\.'));
      assert.deepEqual(fs.readdirSync(fixture.parent).sort(), ['bin', 'vindu.app']);
    }
  }
});

test('an existing directory containing local work is preserved before any checkout is created', () => {
  const fixture = workspace();
  const sibling = path.join(fixture.parent, 'vindu');
  fs.mkdirSync(sibling);
  const localFile = path.join(sibling, 'notes.txt');
  fs.writeFileSync(localFile, 'keep this work');
  const result = fixture.build(pins);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /vindu.*checkout/i);
  assert.equal(fs.readFileSync(localFile, 'utf8'), 'keep this work');
  assert.deepEqual(fs.readdirSync(fixture.parent).sort(), ['bin', 'vindu', 'vindu.app']);
});

test('only explicit local mode builds the two named sibling packages without pins', () => {
  const fixture = workspace();
  const unpublished = { celler: { url: '', sha: '' }, vindu: { url: '', sha: '' } };
  for (const [name, packageName] of [['celler', 'celler'], ['vindu', '@matapao/vindu']]) {
    const missing = fixture.build(unpublished, {}, ['--local']);
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, new RegExp('Expected the local ' + packageName));
    assert.doesNotMatch(missing.stdout, /Installing/);
    const sibling = path.join(fixture.parent, name);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'package.json'), JSON.stringify({ name: packageName }));
  }
  const local = fixture.build(unpublished, {}, ['--local']);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /building celler[\s\S]*building vindu\n[\s\S]*building vindu\.app/);
  const pinned = fixture.build(unpublished);
  assert.equal(pinned.status, 1, pinned.stderr);
  assert.match(pinned.stderr, /dependencies\.json/);
});

// CI has its checked-out revision. An unpublished working tree can use an existing
// local Git repository as its read-only object source.
const gitSource = process.env.VINDU_TEST_GIT_SOURCE ?? project;
const revision = spawnSync('git', ['-C', gitSource, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' });
test.skipIf(revision.status !== 0)('pinned checkouts are reused and mismatched or dirty siblings are preserved', () => {
  const fixture = workspace();
  const commit = revision.stdout.trim();
  const config = { celler: { ...pins.celler, sha: commit }, vindu: { ...pins.vindu, sha: commit } };
  const rewrite = 'url.' + pathToFileURL(path.resolve(gitSource)).href + '.insteadOf';
  const env = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: rewrite, GIT_CONFIG_VALUE_0: config.celler.url,
    GIT_CONFIG_KEY_1: rewrite, GIT_CONFIG_VALUE_1: config.vindu.url,
  };
  for (let build = 0; build < 2; build++) {
    const result = fixture.build(config, env);
    assert.equal(result.status, 0, result.stderr);
    for (const name of names) {
      const cwd = path.join(fixture.parent, name);
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), commit);
      assert.equal(execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8' }).trim(), config[name].url);
    }
    assert.deepEqual(fs.readdirSync(fixture.parent).sort(), ['bin', 'celler', 'vindu', 'vindu.app']);
  }
  for (const name of names) {
    const cwd = path.join(fixture.parent, name);
    const userFile = path.join(cwd, 'local-work.txt');
    fs.writeFileSync(userFile, 'local work');
    const dirty = fixture.build(config, env);
    assert.equal(dirty.status, 1, dirty.stderr);
    assert.equal(fs.readFileSync(userFile, 'utf8'), 'local work');
    fs.unlinkSync(userFile);
    for (const wrong of [{ ...config[name], sha }, { ...config[name], url: 'https://example.invalid/other.git' }]) {
      const result = fixture.build({ ...config, [name]: wrong }, env);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), commit);
    }
  }
});
