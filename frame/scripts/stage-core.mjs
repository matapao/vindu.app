// Install each checkout's locked runtime dependencies before embedding it in the desktop app.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function stageCore(stage, app, { os, cpu, libc }) {
  const packages = [
    { id: 'vindu.app', src: app, files: ['dist/src', 'static'] },
    { id: 'vindu', src: path.resolve(app, '../vindu'), files: ['dist'] },
    { id: 'celler', src: path.resolve(app, '../celler'), files: ['dist'] },
  ];
  const staged = packages.map(({ id, src, files }) => {
    const dest = path.join(stage, id);
    const manifest = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    fs.mkdirSync(dest);
    for (const file of ['package.json', 'pnpm-lock.yaml', 'LICENSE', ...files]) {
      fs.cpSync(path.join(src, file), path.join(dest, file), { recursive: true, filter: source => path.basename(source) !== '.DS_Store' });
    }
    const workspace = path.join(src, 'pnpm-workspace.yaml');
    const settings = fs.existsSync(workspace) ? fs.readFileSync(workspace, 'utf8') : '';
    const patches = path.join(src, 'patches');
    if (fs.existsSync(patches)) fs.cpSync(patches, path.join(dest, 'patches'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'pnpm-workspace.yaml'), `${settings}\nnodeLinker: hoisted\nsupportedArchitectures:\n  os: [${os}]\n  cpu: [${cpu}]\n${libc ? `  libc: [${libc}]\n` : ''}`);
    return { dest, manifest };
  });

  for (const { dest } of staged) {
    execFileSync('pnpm', ['install', '--prod', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts'], { cwd: dest, stdio: 'inherit' });
    // pnpm's installation bookkeeping includes the workstation's store and checkout paths.
    for (const file of ['node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.pnpm/lock.yaml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'patches']) {
      fs.rmSync(path.join(dest, file), { recursive: true, force: true });
    }
  }
  const [core, ...siblings] = staged;
  // Replace the development links with the exact packages installed above.
  for (const sibling of siblings) {
    const target = path.join(core.dest, 'node_modules', sibling.manifest.name);
    if (!fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== fs.realpathSync(sibling.dest)) {
      throw new Error(`Expected ${sibling.manifest.name} to resolve to its staged package`);
    }
    fs.unlinkSync(target);
    fs.renameSync(sibling.dest, target);
    core.manifest.dependencies[sibling.manifest.name] = sibling.manifest.version;
  }
  fs.writeFileSync(path.join(core.dest, 'package.json'), JSON.stringify(core.manifest, null, 2));
  fs.renameSync(core.dest, path.join(stage, 'core'));
}
