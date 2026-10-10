import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { workspaceMemberDirs } from './publishable-packages.mjs';

/** Materialise a production workspace closure using Bun tarballs and a hoisted install. */
export function deployBunWorkspace(name, destination, root) {
  const absolute = resolve(destination);
  if (
    absolute === root ||
    !absolute.startsWith(`${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`Unsafe deploy destination: ${absolute}`);
  }
  const packages = new Map(
    workspaceMemberDirs(root).map((dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      return [manifest.name, { dir, manifest }];
    }),
  );
  const entry = packages.get(name);
  if (!entry) throw new Error(`Unknown workspace package: ${name}`);
  const selected = new Set();
  function visit(pkg) {
    if (selected.has(pkg.manifest.name)) return;
    selected.add(pkg.manifest.name);
    for (const dep of Object.keys({
      ...pkg.manifest.dependencies,
      ...pkg.manifest.optionalDependencies,
      ...pkg.manifest.peerDependencies,
    })) {
      if (packages.has(dep)) visit(packages.get(dep));
    }
  }
  visit(entry);
  // Outside the workspace: Bun must install the staged manifest, not its parent workspace.
  const scratch = mkdtempSync(join(tmpdir(), 'wrongstack-bun-deploy-'));
  const packs = join(scratch, 'packs');
  const stage = join(scratch, 'app');
  mkdirSync(packs);
  mkdirSync(stage);
  const overrides = { ...JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string' && /^(link|file):/.test(value)) delete overrides[key];
  }
  const tarballs = new Map();
  for (const key of selected) {
    const pkg = packages.get(key);
    const filename = `${key.replace(/^@/, '').replace('/', '-')}-${pkg.manifest.version}.tgz`;
    execFileSync(process.execPath, ['pm', 'pack', '--ignore-scripts', '--destination', packs], {
      cwd: pkg.dir,
      stdio: 'inherit',
    });
    const tarball = join(packs, filename);
    tarballs.set(key, tarball);
    overrides[key] = `file:${tarball.replaceAll('\\', '/')}`;
  }
  execFileSync(
    'tar',
    ['-xzf', relative(stage, tarballs.get(name)).replaceAll('\\', '/'), '--strip-components=1'],
    { cwd: stage, stdio: 'inherit' },
  );
  const manifest = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
  delete manifest.devDependencies;
  manifest.overrides = overrides;
  manifest.trustedDependencies = [];
  // Do not execute the staged workspace's own prepare/install hooks.
  delete manifest.scripts;
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const locked = Bun.JSONC.parse(readFileSync(join(root, 'bun.lock'), 'utf8'));
  const registryPackages = new Set(
    Object.values(locked.packages)
      .map((pkg) => pkg[0])
      .filter((spec) => !spec.includes('@workspace:') && !spec.includes('@file:')),
  );
  const stagedLock = {
    ...locked,
    packages: Object.fromEntries(
      Object.entries(locked.packages).filter(([, pkg]) => !pkg[0].includes('@workspace:')),
    ),
    workspaces: {
      '': {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
        optionalDependencies: manifest.optionalDependencies,
        peerDependencies: manifest.peerDependencies,
      },
    },
    overrides,
  };
  for (const [key, tarball] of tarballs) {
    const source = packages.get(key).manifest;
    const metadata = {};
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
      'bin',
      'os',
      'cpu',
    ]) {
      if (source[field]) metadata[field] = source[field];
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (!metadata[field]) continue;
      metadata[field] = Object.fromEntries(
        Object.entries(metadata[field]).map(([dep, version]) => [
          dep,
          packages.has(dep) ? packages.get(dep).manifest.version : version,
        ]),
      );
    }
    stagedLock.packages[key] = [
      `${key}@${tarball.replaceAll('\\', '/')}`,
      metadata,
      `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`,
    ];
  }
  const patches =
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).patchedDependencies ?? {};
  manifest.patchedDependencies = patches;
  for (const file of Object.values(patches)) {
    mkdirSync(join(stage, 'patches'), { recursive: true });
    cpSync(join(root, file), join(stage, file));
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(stage, 'bun.lock'), `${JSON.stringify(stagedLock, null, 2)}\n`);
  execFileSync(process.execPath, ['install', '--lockfile-only', '--ignore-scripts', '--offline'], {
    cwd: stage,
    stdio: 'inherit',
  });
  const resolvedLock = Bun.JSONC.parse(readFileSync(join(stage, 'bun.lock'), 'utf8'));
  const localPackages = new Set(
    [...tarballs].map(([key, tarball]) => `${key}@${tarball.replaceAll('\\', '/')}`),
  );
  for (const pkg of Object.values(resolvedLock.packages)) {
    if (
      !pkg[0].includes('@file:') &&
      !pkg[0].includes('@workspace:') &&
      !localPackages.has(pkg[0]) &&
      !registryPackages.has(pkg[0])
    ) {
      throw new Error(`Bun deploy changed a locked registry dependency: ${pkg[0]}`);
    }
  }
  execFileSync(
    process.execPath,
    ['install', '--frozen-lockfile', '--production', '--ignore-scripts', '--linker', 'hoisted'],
    { cwd: stage, stdio: 'inherit' },
  );
  mkdirSync(absolute, { recursive: true });
  cpSync(stage, absolute, { recursive: true });
  // Retain scratch inputs for diagnosis; no workspace install or relinking occurs here.
  return { destination: absolute, scratch };
}
