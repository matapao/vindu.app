// Build a checkout using the same dependency revisions locally and in CI.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const parent = path.dirname(root);

const dependencies = [
  { name: 'celler', packageName: 'celler' },
  { name: 'vindu', packageName: '@matapao/vindu' },
].map(dep => ({ ...dep, dir: path.join(parent, dep.name) }));

function pinnedDependencies() {
  const pins = JSON.parse(readFileSync(path.join(root, 'dependencies.json'), 'utf8'));
  const errors = [];
  const result = dependencies.map(dep => {
    const { url, sha } = pins?.[dep.name] ?? {};
    const remote = typeof url === 'string' && URL.parse(url);
    if (!remote || !url.startsWith('https://') || /\s/.test(url) || remote.username || remote.password || remote.search || remote.hash) {
      errors.push(`${dep.name}.url must be a public HTTPS Git URL without credentials, a query or a fragment`);
    }
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
      errors.push(`${dep.name}.sha must be a full 40-character Git commit SHA`);
    }
    return { ...dep, url, sha: typeof sha === 'string' ? sha.toLowerCase() : '' };
  });
  if (errors.length) throw new Error('Fill in dependencies.json before building:\n' + errors.join('\n'));
  return result;
}

function verifyLocalPackage({ name, packageName, dir }) {
  const manifest = path.join(dir, 'package.json');
  if (!lstatSync(manifest, { throwIfNoEntry: false }) || JSON.parse(readFileSync(manifest, 'utf8')).name !== packageName) {
    throw new Error(`Expected the local ${packageName} package in ../${name} (${manifest})`);
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

// Never switch an existing developer checkout.
function checkedOut({ name, dir, url, sha }) {
  const entry = lstatSync(dir, { throwIfNoEntry: false });
  if (!entry) return false;
  let reason;
  try {
    if (!entry.isDirectory() || realpathSync(git(dir, 'rev-parse', '--show-toplevel')) !== realpathSync(dir)) reason = 'is not a Git checkout at that path';
    else if (git(dir, 'config', '--get', 'remote.origin.url') !== url) reason = 'has a different origin URL';
    else if (git(dir, 'rev-parse', '--verify', 'HEAD') !== sha) reason = 'is at a different commit';
    else if (git(dir, 'status', '--porcelain=v1', '--untracked-files=normal')) reason = 'has local changes';
  } catch {
    reason = 'could not be verified as a Git checkout with an origin and a commit';
  }
  if (reason) throw new Error(`${dir} ${reason}. Use a fresh parent directory or a clean ${name} checkout at ${sha} from dependencies.json.`);
  return true;
}

function fetchDependency(dep) {
  const staging = mkdtempSync(path.join(parent, `.vindu-${dep.name}-`));
  try {
    console.log(`Fetching ${dep.name} at ${dep.sha}`);
    git(staging, 'init', '--quiet');
    git(staging, 'remote', 'add', 'origin', dep.url);
    git(staging, 'fetch', '--depth=1', '--no-tags', 'origin', dep.sha);
    git(staging, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
    if (git(staging, 'rev-parse', 'HEAD') !== dep.sha) throw new Error(`${dep.name}: fetched revision is not the pinned commit`);
    // Another invocation may have finished the same checkout while Git was fetching.
    if (!checkedOut(dep)) renameSync(staging, dep.dir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// Windows uses a .cmd launcher. Only fixed command words go through cmd.
function pnpm(cwd, ...args) {
  const options = { cwd, stdio: 'inherit' };
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/d', '/c', 'pnpm', ...args], options);
  } else {
    execFileSync('pnpm', args, options);
  }
}

function build() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--local') {
    for (const dep of dependencies) verifyLocalPackage(dep);
  } else if (args.length === 0) {
    // Check every existing checkout before creating a missing sibling.
    const missing = pinnedDependencies().filter(dep => !checkedOut(dep));
    for (const dep of missing) fetchDependency(dep);
  } else {
    throw new Error('Usage: node scripts/bootstrap.mjs [--local]');
  }
  for (const dep of dependencies) {
    console.log(`Installing and building ${dep.name}`);
    pnpm(dep.dir, 'install', '--frozen-lockfile');
    pnpm(dep.dir, 'run', 'build');
  }
  console.log('Installing and building vindu.app');
  pnpm(root, 'install', '--frozen-lockfile');
  pnpm(root, 'run', 'compile');
  pnpm(root, '-C', 'frame', 'run', 'build');
}

try {
  build();
} catch (error) {
  console.error(`Vindu build failed: ${error.message}`);
  process.exitCode = 1;
}
