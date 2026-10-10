#!/usr/bin/env bun
/**
 * Build standalone WrongStack executables — one self-contained file per
 * platform, no Node.js or npm needed on the target machine.
 *
 *   node scripts/build-binaries.mjs                 # every target
 *   node scripts/build-binaries.mjs --target=bun-windows-x64,bun-linux-x64
 *   node scripts/build-binaries.mjs --current       # this machine only
 *   node scripts/build-binaries.mjs --skip-build    # reuse existing dist/
 *
 * Output: dist-bin/wstack-<os>-<arch>[.exe] and dist-bin/SHA256SUMS.
 *
 * How it fits together: scripts/binary/entry.mjs is the executable's entry;
 * the CLI, every project daemon and the Bun runtime are compiled in, and the
 * package assets (prompts, skills, design kits, grammars, frontends) travel as
 * one gzip pack the entry extracts on first run. The runtime side of that
 * contract lives in packages/persistence/src/standalone-binary.ts.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-bin');
const stageDir = path.join(outDir, '.stage');

export const ALL_TARGETS = [
  'bun-windows-x64',
  'bun-windows-arm64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
  'bun-darwin-x64',
  'bun-darwin-arm64',
];

/**
 * Optional or native dependencies that cannot be compiled in. Each is loaded
 * lazily behind a graceful fallback: the browser tool reports Playwright as
 * unavailable, the WebUI terminal panel reports node-pty as unavailable, and
 * the desktop shell is not part of the binary at all.
 */
const EXTERNALS = [
  'playwright-core',
  'playwright',
  '@playwright/test',
  'chromium-bidi',
  'node-pty',
  'electron',
];

/**
 * Package assets the code reads from disk at runtime, relative to each
 * package root. Laid out as `<package>/<path>` in the pack, which is exactly
 * what `standalonePackageDir()` / `moduleDirFor()` resolve against.
 */
const ASSETS = {
  core: ['package.json', 'skills', 'design-kits', 'instructions', 'data'],
  cli: ['package.json', 'data'],
  tools: ['package.json', 'dist/wasm'],
  bench: ['package.json', 'fixtures', 'subsets'],
  webui: ['package.json', 'dist'],
  'webui-hq': ['package.json', 'dist'],
  simpleui: ['package.json', 'dist'],
};

/** Build noise that is never read at runtime. */
const EXCLUDED = /(?:\.map|\.d\.ts|\.d\.mts|\.tsbuildinfo)$/;

export function parseBinaryBuildArgs(argv) {
  const opts = { targets: [...ALL_TARGETS], skipBuild: false };
  for (const arg of argv) {
    if (arg === '--skip-build') opts.skipBuild = true;
    else if (arg === '--current') opts.targets = [currentTarget()];
    else if (arg.startsWith('--target='))
      opts.targets = arg.slice('--target='.length).split(',').filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const target of opts.targets) {
    if (!ALL_TARGETS.includes(target))
      throw new Error(`Unknown target ${target}. Known: ${ALL_TARGETS.join(', ')}`);
  }
  opts.targets = [...new Set(opts.targets)];
  if (opts.targets.length === 0) {
    throw new Error('--target requires at least one build target');
  }
  return opts;
}

function currentTarget() {
  const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) throw new Error(`No binary target for ${process.platform}-${process.arch}`);
  return `bun-${os}-${arch}`;
}

export function outputName(target) {
  const name = `wstack-${target.replace(/^bun-/, '')}`;
  return target.startsWith('bun-windows') ? `${name}.exe` : name;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function listFiles(absolute, relative, out) {
  const stat = statSync(absolute);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(absolute).sort()) {
      listFiles(path.join(absolute, entry), `${relative}/${entry}`, out);
    }
  } else if (stat.isFile() && !EXCLUDED.test(relative)) {
    out.push([relative, absolute]);
  }
}

/** Write the asset pack (format documented in scripts/binary/entry.mjs). */
function buildAssetPack() {
  const files = [];
  for (const [pkg, entries] of Object.entries(ASSETS)) {
    for (const entry of entries) {
      const absolute = path.join(root, 'packages', pkg, entry);
      if (!existsSync(absolute))
        throw new Error(`Missing binary asset packages/${pkg}/${entry} — build first.`);
      listFiles(absolute, `${pkg}/${entry}`, files);
    }
  }
  const contents = files.map(([, absolute]) => readFileSync(absolute));
  const index = Buffer.from(
    JSON.stringify(files.map(([relative], i) => [relative, contents[i].length])),
  );
  const header = Buffer.alloc(10);
  header.write('WSPK1\n', 0, 'latin1');
  header.writeUInt32LE(index.length, 6);
  const raw = Buffer.concat([header, index, ...contents]);
  const packed = gzipSync(raw, { level: 9 });
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(path.join(stageDir, 'assets.pack'), packed);
  const packId = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  console.log(
    `asset pack: ${files.length} files, ${(raw.length / 1e6).toFixed(1)} MB → ${(packed.length / 1e6).toFixed(1)} MB gz (${packId})`,
  );
  return packId;
}

function readVersions() {
  const version = JSON.parse(
    readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8'),
  ).version;
  const apiVersion =
    JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8'))
      .wrongstackApiVersion ?? '0.0.0';
  return { version, apiVersion };
}

function compile(target, { version, apiVersion, packId }) {
  const outfile = path.join(outDir, outputName(target));
  const args = [
    'build',
    'scripts/binary/entry.mjs',
    '--compile',
    `--target=${target}`,
    `--outfile=${outfile}`,
    // Whitespace + syntax only: identifier mangling would rename classes whose
    // `name` the code reports (error kinds, tool names in diagnostics).
    '--minify-whitespace',
    '--minify-syntax',
    // Bun's standalone default is to load `.env` and `bunfig.toml` from the
    // CURRENT directory at startup — i.e. from whatever repo `wstack` is run
    // in. A cloned repo's `bunfig.toml` `preload` then executed repo code
    // before any trust check (even for `wstack --version`, and again in every
    // daemon the binary respawns there), and its `.env` rewrote proxy /
    // provider / WRONGSTACK_* settings. The Node build loads neither.
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    `--define=WRONGSTACK_BINARY_VERSION=${JSON.stringify(version)}`,
    `--define=WRONGSTACK_BINARY_API_VERSION=${JSON.stringify(apiVersion)}`,
    `--define=WRONGSTACK_BINARY_PACK_ID=${JSON.stringify(packId)}`,
    `--define=WRONGSTACK_BINARY_TARGET=${JSON.stringify(target)}`,
    ...EXTERNALS.flatMap((name) => ['--external', name]),
  ];
  console.log(`\n→ ${target}`);
  run('bun', args);
  return outfile;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const opts = parseBinaryBuildArgs(process.argv.slice(2));
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (bun.status !== 0) throw new Error('Bun is required to build binaries (https://bun.sh).');
  console.log(`bun ${bun.stdout.trim()}`);

  if (!opts.skipBuild) run(process.execPath, ['scripts/build.mjs']);

  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch (error) {
    // Windows locks a running executable: usually a project daemon started
    // by a previous smoke run of a dist-bin/ binary, idling out.
    throw new Error(
      `cannot clear dist-bin/ (${error instanceof Error ? error.message : error}). ` +
        'Stop running dist-bin binaries (and their idle daemons) and retry.',
    );
  }
  const versions = readVersions();
  const packId = buildAssetPack();
  const outputs = opts.targets.map((target) => compile(target, { ...versions, packId }));

  const sums = [];
  for (const file of outputs) {
    sums.push(`${await sha256File(file)}  ${path.basename(file)}`);
  }
  writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  rmSync(stageDir, { recursive: true, force: true });

  console.log(`\nWrongStack ${versions.version} — ${outputs.length} binaries in dist-bin/:`);
  for (const file of outputs) {
    console.log(`  ${path.basename(file).padEnd(32)} ${(statSync(file).size / 1e6).toFixed(1)} MB`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`build-binaries: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
