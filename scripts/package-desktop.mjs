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
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');
const stageDir = join(repoRoot, 'apps', 'desktop', '.package-stage');

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

/**
 * Run a Node CLI directly, with NO shell.
 *
 * `run()` above keeps `shell: true` because it invokes `pnpm`, which on Windows
 * is a `.cmd` shim that `execFileSync` cannot execute otherwise. A plain
 * `node <script>` needs no shim and therefore no shell, so nothing this script
 * assembles is ever re-parsed as a command line.
 */
function runNode(args, cwd) {
  execFileSync(process.execPath, args, { cwd, stdio: 'inherit' });
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

// 5. Run the electron-builder this repo already installed — never `npx --yes`.
//
// `npx --yes electron-builder@<range>` fetched a fresh dependency tree from the
// network at package time, outside the lockfile and outside every supply-chain
// control this repo maintains (`minimumReleaseAge`, `onlyBuiltDependencies`,
// the audit gate). It did that in the one process that holds `CSC_LINK`,
// `CSC_KEY_PASSWORD` and the Apple notarization credentials — so a compromised
// release of electron-builder or any of its transitives would have executed
// with the signing keys in its environment.
//
// The workspace copy is pinned by `pnpm-lock.yaml` and already installed. It is
// resolved from `apps/desktop`, so the version is exactly the devDependency
// that was audited, and no network fetch happens at all.
//
// Invoked through `process.execPath` on the CLI's own JS entry rather than the
// `.bin` shim: that avoids the Windows `.cmd`-shim `execFileSync` failure this
// repo has hit before, and lets the spawn drop `shell: true` — no argument this
// script builds is re-parsed by a shell.
const desktopRequire = createRequire(join(desktopDir, 'package.json'));
const builderPkgPath = desktopRequire.resolve('electron-builder/package.json');
const builderPkg = JSON.parse(readFileSync(builderPkgPath, 'utf8'));
const builderCli = resolve(dirname(builderPkgPath), builderPkg.bin['electron-builder']);

const declaredBuilder = pkg.devDependencies['electron-builder'].replace(/^[\^~]/, '');
if (builderPkg.version !== declaredBuilder) {
  // Not fatal — a caret range legitimately resolves forward — but silence here
  // would hide a lockfile/manifest drift in the tool that signs the release.
  console.warn(
    `[package-desktop] electron-builder resolved to ${builderPkg.version}, ` +
      `manifest declares ${declaredBuilder}. Using the installed (lockfile) version.`,
  );
}

runNode(
  [
    builderCli,
    '--config',
    'electron-builder.yml',
    `--config.electronVersion=${electronVersion}`,
    ...forwarded,
  ],
  stageDir,
);

console.log(`\nArtifacts: ${join(stageDir, 'release')}`);
