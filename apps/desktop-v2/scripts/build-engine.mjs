import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryCompileArgs, buildAssetPack } from '../../../scripts/build-binaries.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(appDir, '../..');
const stageDir = join(appDir, '.engine-stage');
const outputDir = join(appDir, 'binaries');

/**
 * Bun standalone target -> Rust target triple. Tauri bundles an `externalBin` named
 * `<name>-<triple>[.exe]` and installs it beside the application as `<name>[.exe]`.
 * Linux uses glibc: the deb/rpm installers target the same glibc desktops as WebKitGTK.
 */
export const ENGINE_TARGETS = {
  'bun-windows-x64': 'x86_64-pc-windows-msvc',
  'bun-windows-arm64': 'aarch64-pc-windows-msvc',
  'bun-linux-x64': 'x86_64-unknown-linux-gnu',
  'bun-linux-arm64': 'aarch64-unknown-linux-gnu',
  'bun-darwin-x64': 'x86_64-apple-darwin',
  'bun-darwin-arm64': 'aarch64-apple-darwin',
};

/** The Bun target for a Rust triple, so the engine always matches the application it ships in. */
export function engineTargetForTriple(triple) {
  const entry = Object.entries(ENGINE_TARGETS).find(([, value]) => value === triple);
  if (!entry) {
    throw new Error(
      `Desktop packaging has no engine target for ${triple}. Supported: ${Object.values(ENGINE_TARGETS).join(', ')}`,
    );
  }
  return entry[0];
}

/**
 * The Rust triple the desktop application is being built for: the toolchain's host triple
 * (what `tauri build` targets without `--target`), or this process's platform when no
 * Rust toolchain is installed.
 */
export function hostTriple() {
  const rustc = spawnSync('rustc', ['-vV'], { encoding: 'utf8', windowsHide: true });
  const host = rustc.status === 0 ? /^host:\s*(\S+)/m.exec(rustc.stdout)?.[1] : undefined;
  if (host) return host;
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const target = os && `bun-${os}-${process.arch}`;
  if (!target || !(target in ENGINE_TARGETS)) {
    throw new Error(`Desktop packaging does not support ${process.platform}-${process.arch}.`);
  }
  return ENGINE_TARGETS[target];
}

/** Where the Tauri bundler expects the engine sidecar for `triple`. */
export function engineSidecarPath(triple, dir = appDir) {
  const suffix = triple.includes('-windows-') ? '.exe' : '';
  return join(dir, 'binaries', `wrongstack-engine-${triple}${suffix}`);
}

export function createEngineEntry(source) {
  const cliImport = "await import('../../packages/cli/dist/index.js');";
  const packImport = "'../../dist-bin/.stage/assets.pack'";
  if (source.split(cliImport).length !== 2 || source.split(packImport).length !== 2) {
    throw new Error('Standalone bootstrap contract changed; review the desktop engine adapter.');
  }
  return source
    .replace(cliImport, "await import('../engine/main.ts');")
    .replace(packImport, "'./assets.pack'")
    .replaceAll("'../../packages/", "'../../../packages/");
}

function run(args) {
  const child = spawnSync(process.execPath, args, {
    cwd: repoDir,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Desktop engine build failed (${child.status}).`);
}

export function buildEngine({ skipBuild = false, triple = hostTriple() } = {}) {
  const target = engineTargetForTriple(triple);
  if (!skipBuild) run(['scripts/build.mjs', '--target', '@wrongstack/webui-server']);
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  const packId = buildAssetPack({
    destination: stageDir,
    assets: {
      core: ['package.json', 'skills', 'design-kits', 'instructions', 'data'],
      'agent-catalog': ['package.json', 'instructions'],
      cli: ['package.json', 'data'],
      tools: ['package.json', 'dist/wasm'],
      bench: ['package.json', 'fixtures', 'subsets'],
    },
  });
  const entry = join(stageDir, 'entry.mjs');
  writeFileSync(
    entry,
    createEngineEntry(readFileSync(join(repoDir, 'scripts/binary/entry.mjs'), 'utf8')),
  );
  const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
  const apiVersion =
    JSON.parse(readFileSync(join(repoDir, 'packages/core/package.json'), 'utf8'))
      .wrongstackApiVersion ?? '0.0.0';
  const outfile = engineSidecarPath(triple);
  run(binaryCompileArgs(target, { version, apiVersion, packId }, entry, outfile));
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const at = process.argv.indexOf('--triple');
    const triple = at > 0 ? process.argv[at + 1] : undefined;
    if (at > 0 && !triple) throw new Error('--triple requires a Rust target triple');
    console.log(
      `Desktop engine: ${buildEngine({ skipBuild: process.argv.includes('--skip-build'), ...(triple ? { triple } : {}) })}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
