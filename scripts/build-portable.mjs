#!/usr/bin/env node
/**
 * Build a Windows portable WrongStack CLI distribution.
 *
 * The launcher is a Node SEA executable, while the application and production
 * dependencies remain beside it. Keeping the application external is
 * intentional: WrongStack loads plugins, workers, native addons, WebUI assets,
 * and optional browser tooling dynamically, which a single-file JS bundle
 * cannot preserve reliably.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { cleanBuildOutput } from './lib/build-output-cleanup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = manifest.version;
const platform = process.platform;
const arch = process.arch;

if (platform !== 'win32') {
  throw new Error(`Windows portable artifacts must be built on Windows (current: ${platform}).`);
}
if (arch !== 'x64' && arch !== 'arm64') {
  throw new Error(`Unsupported Windows architecture: ${arch}`);
}

const artifactsRoot = join(root, 'artifacts');
const bundleName = `wrongstack-v${version}-windows-${arch}`;
const bundleDir = join(artifactsRoot, bundleName);
const appDir = join(bundleDir, 'app');
const stagingDir = join(artifactsRoot, '.portable-staging');
const executable = join(bundleDir, 'WrongStack.exe');
let retiredExecutable;

for (const target of [bundleDir, stagingDir]) {
  const relative = target.slice(root.length + 1);
  if (!target.startsWith(`${root}\\`) || !relative.startsWith('artifacts\\')) {
    throw new Error(`Refusing to clean unsafe portable-build path: ${target}`);
  }
}
rmSync(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(bundleDir, { recursive: true });
mkdirSync(stagingDir, { recursive: true });

const pnpmCli = process.env.npm_execpath?.includes('pnpm')
  ? { script: process.env.npm_execpath, prefix: [] }
  : {
      script: join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js'),
      prefix: ['pnpm'],
    };
if (!existsSync(pnpmCli.script)) {
  throw new Error(`Unable to locate the pnpm CLI: ${pnpmCli.script}`);
}
const deployDir = mkdtempSync(join(tmpdir(), 'wrongstack-portable-deploy-'));
try {
  try {
    runPnpm([
      '--config.node-linker=hoisted',
      '--filter',
      '@wrongstack/cli',
      'deploy',
      '--prod',
      '--legacy',
      deployDir,
    ]);
  } finally {
    // pnpm's legacy deploy can leave workspace dependency verification wanting
    // a production-only reinstall. Restore the checkout before a local release
    // continues to `pnpm publish` (and before a failed build returns control).
    runPnpm(['install', '--frozen-lockfile']);
  }

  // pnpm 11's deploy importer cannot reliably replace its pre-created target
  // directory on Windows when that target is inside the workspace (EPERM).
  // Complete the deploy in the system temp directory, then copy the resulting
  // self-contained, hoisted application into the portable bundle.
  cleanBuildOutput(appDir);
  mkdirSync(appDir, { recursive: true });
  cpSync(deployDir, appDir, { recursive: true, errorOnExist: true });
} finally {
  rmSync(deployDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

const cliEntry = join(appDir, 'dist', 'index.js');
if (!existsSync(cliEntry)) {
  throw new Error(`Deployed CLI entry point is missing: ${cliEntry}`);
}

const electronPackageDir = join(appDir, 'node_modules', 'electron');
const electronExecutable = join(electronPackageDir, 'dist', 'electron.exe');
if (existsSync(electronPackageDir) && !existsSync(electronExecutable)) {
  run(process.execPath, [join(electronPackageDir, 'install.js')]);
}
if (!existsSync(electronExecutable)) {
  throw new Error(`Portable Desktop runtime is missing: ${electronExecutable}`);
}

const bootstrap = join(stagingDir, 'bootstrap.cjs');
const seaBlob = join(stagingDir, 'sea-prep.blob');
const seaConfig = join(stagingDir, 'sea-config.json');
writeFileSync(
  bootstrap,
  `const path = require('node:path');\n` +
    `const fs = require('node:fs');\n` +
    `const { pathToFileURL } = require('node:url');\n` +
    `const app = path.join(__dirname, 'app');\n` +
    `const cli = path.join(__dirname, 'app', 'dist', 'index.js');\n` +
    `const requested = typeof process.argv[2] === 'string' ? path.resolve(process.argv[2]) : '';\n` +
    `const appPrefix = path.resolve(app) + path.sep;\n` +
    `const internalScript = requested.startsWith(appPrefix) && /\\.[cm]?js$/i.test(requested) && fs.existsSync(requested);\n` +
    `const entry = internalScript ? requested : cli;\n` +
    `if (internalScript) process.argv.splice(1, 2, requested);\n` +
    `else process.argv[1] = cli;\n` +
    `import(pathToFileURL(entry).href).catch((error) => {\n` +
    `  console.error(error instanceof Error ? error.stack : String(error));\n` +
    `  process.exitCode = 1;\n` +
    `});\n`,
);
writeFileSync(
  seaConfig,
  `${JSON.stringify({ main: bootstrap, output: seaBlob, disableExperimentalSEAWarning: true }, null, 2)}\n`,
);

run(process.execPath, ['--experimental-sea-config', seaConfig]);
const preparedExecutable = existsSync(executable) ? join(stagingDir, 'WrongStack.exe') : executable;
copyFileSync(process.execPath, preparedExecutable);
run(process.execPath, [
  join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
  preparedExecutable,
  'NODE_SEA_BLOB',
  seaBlob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);

if (preparedExecutable !== executable) {
  const preparedDigest = hashFile(preparedExecutable);
  const existingDigest = hashFile(executable);
  if (preparedDigest === existingDigest) {
    rmSync(preparedExecutable, { force: true });
  } else {
    retiredExecutable = join(
      artifactsRoot,
      `.portable-retired-WrongStack-${process.pid}-${Date.now()}.exe`,
    );
    await renameWithRetry(executable, retiredExecutable);
    try {
      await renameWithRetry(preparedExecutable, executable);
    } catch (error) {
      await renameWithRetry(retiredExecutable, executable);
      throw error;
    }
  }
}

writeFileSync(
  join(bundleDir, 'README.txt'),
  [
    `WrongStack ${version} portable for Windows ${arch}`,
    '',
    'Run WrongStack.exe from PowerShell, Windows Terminal, or cmd.exe.',
    'No separate Node.js or npm installation is required.',
    '',
    'Keep WrongStack.exe and the app directory together.',
    'Run "WrongStack.exe desktop" to open the bundled Electron desktop shell.',
    'The executable is unsigned unless the release pipeline is configured with a code-signing certificate.',
    '',
  ].join('\r\n'),
);

const smoke = spawnSync(executable, ['version'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
});
if (smoke.error || smoke.status !== 0 || !smoke.stdout.includes(`WrongStack ${version}`)) {
  throw new Error(
    `Portable executable smoke test failed.\nstdout:\n${smoke.stdout ?? ''}\nstderr:\n${smoke.stderr ?? ''}`,
    { cause: smoke.error },
  );
}

const digest = hashFile(executable);
writeFileSync(join(bundleDir, 'SHA256SUMS.txt'), `${digest}  WrongStack.exe\n`);
rmSync(stagingDir, { recursive: true, force: true });
if (retiredExecutable) {
  try {
    rmSync(retiredExecutable, { force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(
      `Previous portable launcher is still locked and was retained at ${retiredExecutable}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

console.log(`Portable artifact ready: ${bundleDir}`);
console.log(smoke.stdout.trim());

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function runPnpm(args) {
  run(process.execPath, [pnpmCli.script, ...pnpmCli.prefix, ...args]);
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function renameWithRetry(source, destination, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let retryDelayMs = 50;

  while (true) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const transientWindowsError =
        process.platform === 'win32' &&
        (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES');
      if (!transientWindowsError || Date.now() >= deadline) throw error;

      await delay(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
    }
  }
}
