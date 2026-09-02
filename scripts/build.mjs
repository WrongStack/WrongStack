#!/usr/bin/env node
/**
 * Workspace build runner — bypasses `pnpm -r build` to work around
 * pnpm 11's `; echo "EXIT=$?"` wrapper, which cmd.exe (the default
 * script-shell on Windows) does not understand as a separator. The
 * wrapper is passed as literal args to package build commands, which then
 * fail. pnpm 11.5.2 + cmd.exe has no clean
 * `script-shell` setting, so we run each workspace package's `build`
 * script directly via cmd.exe here. cmd.exe handles `&&` correctly,
 * so chained scripts like `vite build && node build-package.mjs` keep working.
 *
 * Workspace layout is mirrored from pnpm-workspace.yaml (packages/*
 * apps/* and website). Update both together if packages move.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

const workspaceGlobs = [
  ['packages', true],
  ['apps', true],
  ['website', false],
];

function parseArgs(argv) {
  const targets = [];
  let skipIfWorkspaceBuild = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-if-workspace-build') {
      skipIfWorkspaceBuild = true;
      continue;
    }
    if (arg === '--target' || arg === '-t') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error(`${arg} requires a package name or workspace path`);
      }
      targets.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown build option: ${arg}`);
    }
    targets.push(arg);
  }
  return { targets, skipIfWorkspaceBuild };
}

function discoverPackages() {
  const found = [];
  for (const [dir] of workspaceGlobs) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      const child = join(abs, entry);
      if (!existsSync(join(child, 'package.json'))) continue;
      found.push(relative(root, child));
    }
  }
  return found;
}

function readPkgMeta(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(root, pkgDir, 'package.json'), 'utf8'));
  const deps = Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  }).filter((d) => d.startsWith('@wrongstack/'));
  return { dir: pkgDir, name: pkg.name, build: pkg.scripts?.build ?? null, deps };
}

// Build packages in dependency (topological) order, not the alphabetical
// order readdirSync yields. TypeScript declaration emit resolves a package's
// `@wrongstack/*` imports from each dependency's *emitted* dist/*.d.ts, so
// every dependency must be fully built first. Alphabetical order is unsafe:
// `cli` depends on `tools` but sorts before it, `acp` before `core`, etc. On
// a clean dist that fails outright; with a half-populated dist (stale .d.ts,
// missing .js) the build silently "succeeds" but ships an unloadable runtime
// (ERR_MODULE_NOT_FOUND). Ties are broken alphabetically for determinism.
//
// PR-11 (2026-07): the historical workspace cycles
// (core↔sdd and core↔security-scanner) were broken by PR-08 + PR-10.
// The build runner no longer tolerates cycles — if a cycle is detected,
// the build fails with the cycle path so it can be fixed at source.
function topoSort(metas) {
  const byName = new Map(metas.map((m) => [m.name, m]));
  const visited = new Set();
  const onStack = new Set();
  const ordered = [];
  const cycles = [];
  const visit = (m, ancestors) => {
    if (visited.has(m.name)) return;
    if (onStack.has(m.name)) {
      const cycleStart = ancestors.indexOf(m.name);
      const cyclePath =
        cycleStart >= 0 ? [...ancestors.slice(cycleStart), m.name].join(' → ') : m.name;
      if (!cycles.includes(cyclePath)) cycles.push(cyclePath);
      return;
    }
    onStack.add(m.name);
    const deps = m.deps
      .map((d) => byName.get(d))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const dep of deps) visit(dep, [...ancestors, m.name]);
    onStack.delete(m.name);
    visited.add(m.name);
    ordered.push(m);
  };
  for (const m of [...metas].sort((a, b) => a.name.localeCompare(b.name))) {
    visit(m, []);
  }
  if (cycles.length > 0) {
    console.error(`❌ ${cycles.length} workspace dependency cycle(s) detected:`);
    for (const c of cycles) console.error(`   ${c}`);
    console.error('The workspace package graph must be a DAG. Fix the cycle before building.');
    process.exit(1);
  }
  return ordered;
}

function selectBuildSet(ordered, targets) {
  if (targets.length === 0) return ordered;
  const byName = new Map(ordered.map((m) => [m.name, m]));
  const byDir = new Map(ordered.map((m) => [m.dir.replaceAll('\\', '/'), m]));
  const selected = new Set();
  const visiting = new Set();
  const visit = (m) => {
    if (selected.has(m.name)) return;
    if (visiting.has(m.name)) return; // cycle: skip back-edge
    visiting.add(m.name);
    for (const depName of m.deps) {
      const dep = byName.get(depName);
      if (dep) visit(dep);
    }
    visiting.delete(m.name);
    selected.add(m.name);
  };

  for (const target of targets) {
    const normalized = target.replaceAll('\\', '/');
    const meta = byName.get(target) ?? byDir.get(normalized);
    if (!meta) {
      throw new Error(`Unknown build target: ${target}`);
    }
    visit(meta);
  }

  return ordered.filter((m) => selected.has(m.name));
}

function runBuild(pkgDir, script, envOverrides) {
  // Cross-platform: cmd.exe on Windows (ComSpec), POSIX sh elsewhere.
  // pnpm 11.5.2 + cmd.exe strips the script-shell config that lets `npm
  // run`-style `; echo "EXIT=$?"` wrappers work, so on Windows we still
  // shell out to cmd.exe /c which handles `&&` chained scripts correctly
  // (e.g. `vite build && node build-package.mjs`). On macOS/Linux we use the user's $SHELL
  // (or /bin/sh fallback) with `-c`.
  const isWin = process.platform === 'win32';
  const shell = isWin ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
  const shellArgs = isWin ? ['/c', script] : ['-c', script];
  console.log(`\n> ${pkgDir} > ${script}`);
  // node_modules/.bin must be on PATH so tsc, vite, etc. resolve when
  // spawned via cmd.exe (or sh) — the Node process inherits npm's path
  // resolution but the spawned shell does not. Prefer the package-local bin:
  // pnpm places workspace dependency symlinks under each package; prefer those
  // so package-local tool versions resolve before the root shim.
  const rootBin = join(root, 'node_modules', '.bin');
  const pkgBin = join(root, pkgDir, 'node_modules', '.bin');
  const pathSep = isWin ? ';' : ':';
  const envPath = [pkgBin, rootBin, process.env.PATH || process.env.Path || ''].join(pathSep);
  const env = {
    ...process.env,
    ...(envOverrides ?? {}),
    PATH: envPath,
    Path: envPath,
    NODE_OPTIONS: '--max-old-space-size=4096',
    WRONGSTACK_WORKSPACE_BUILD: '1',
  };
  const result = spawnSync(shell, shellArgs, {
    cwd: join(root, pkgDir),
    stdio: 'inherit',
    env,
  });
  if (result.status !== 0) {
    console.error(`\nBuild failed in ${pkgDir} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (args.skipIfWorkspaceBuild && process.env.WRONGSTACK_WORKSPACE_BUILD === '1') {
  console.log('Workspace build already handles dependency order; skipping nested target build.');
  process.exit(0);
}

const pkgs = discoverPackages();
if (pkgs.length === 0) {
  console.error('No workspace packages found.');
  process.exit(1);
}

let ordered;
try {
  ordered = selectBuildSet(topoSort(pkgs.map(readPkgMeta)), args.targets);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

for (const { dir, build } of ordered) {
  if (!build) {
    console.log(`> ${dir} — no build script, skipping`);
    continue;
  }
  runBuild(dir, build);
}

console.log('\nBuild complete.');
