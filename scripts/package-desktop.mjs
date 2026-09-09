#!/usr/bin/env node
/**
 * Package WrongStack Desktop into a native application.
 *
 * Why this wrapper exists rather than calling electron-builder directly:
 * electron-builder cannot follow pnpm's `link:` workspace dependencies. Run in
 * `apps/desktop`, it walks node_modules, reports
 *
 *   unresolved duplicate dependency references
 *   cannot find path for dependency  ["@wrongstack/core@link:../../packages/core", ...]
 *
 * and then packages anyway — producing an app whose asar contains `ws` and
 * `zod` and none of the four workspace packages the main process imports. It
 * builds, it signs, it looks fine, and it cannot start. That is the failure
 * this script exists to prevent.
 *
 * `pnpm deploy` is the supported fix: it materialises the workspace closure
 * into a real directory tree with no symlinks, which electron-builder can walk.
 * We deploy production dependencies only and pass the Electron version
 * explicitly, because `--prod` correctly omits the `electron` devDependency
 * that electron-builder would otherwise read the version from.
 *
 * Usage:
 *   node scripts/package-desktop.mjs            # installers for this platform
 *   node scripts/package-desktop.mjs --dir      # unpacked app, no installer
 *   node scripts/package-desktop.mjs --win --linux
 *
 * Signing is opt-in via the environment (CSC_LINK / CSC_KEY_PASSWORD, plus
 * APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID to notarize). With
 * none set, the artifacts are unsigned and electron-builder says so.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const stageDir = join(repoRoot, 'apps', 'desktop', '.package-stage');

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

const forwarded = process.argv.slice(2);

// 1. Build the app itself (vite + esbuild) so `dist/` is current.
run('pnpm', ['--filter', '@wrongstack/desktop', 'build'], repoRoot);

// 2. Materialise the workspace closure. `deploy` refuses to overwrite, so the
//    stage is removed first; it is disposable by construction.
if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
mkdirSync(dirname(stageDir), { recursive: true });
run(
  'pnpm',
  ['--filter', '@wrongstack/desktop', 'deploy', '--prod', stageDir],
  repoRoot,
);

// 3. The packaging inputs are not dependencies, so `deploy` does not copy them.
cpSync(join(desktopDir, 'electron-builder.yml'), join(stageDir, 'electron-builder.yml'));
cpSync(join(desktopDir, 'build'), join(stageDir, 'build'), { recursive: true });

// 4. Electron's version comes from the devDependency that `--prod` left out.
//    Read rather than hardcoded so the two cannot drift.
const pkg = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
const electronRange = pkg.devDependencies?.electron;
if (!electronRange) {
  throw new Error(
    'apps/desktop/package.json has no devDependencies.electron — electron-builder ' +
      'cannot determine which Electron to package against.',
  );
}
const electronVersion = electronRange.replace(/^[\^~]/, '');

run(
  'npx',
  [
    '--yes',
    `electron-builder@${pkg.devDependencies['electron-builder'].replace(/^[\^~]/, '')}`,
    '--config',
    'electron-builder.yml',
    `--config.electronVersion=${electronVersion}`,
    ...forwarded,
  ],
  stageDir,
);

console.log(`\nArtifacts: ${join(stageDir, 'release')}`);
