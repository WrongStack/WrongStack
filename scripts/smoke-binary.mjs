#!/usr/bin/env bun
/**
 * Smoke-test a standalone executable from scripts/build-binaries.mjs on the
 * machine it was built for. Runs in an isolated WRONGSTACK_HOME and a scratch
 * git project, so it never touches the operator's real profile.
 *
 *   node scripts/smoke-binary.mjs                      # dist-bin/<this platform>
 *   node scripts/smoke-binary.mjs dist-bin/wstack-linux-x64
 *
 * Each check targets a way the binary can break while `version` still works:
 * assets not extracted, a daemon not dispatched, a project script handed to
 * the CLI, a frontend not served, bundled plugins dropped by the bundler, or a
 * module that auto-starts because every module shares the executable's URL.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function defaultBinary() {
  const os = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  const name = `wstack-${os}-${process.arch}`;
  return path.join(root, 'dist-bin', process.platform === 'win32' ? `${name}.exe` : name);
}

const binary = path.resolve(process.argv[2] ?? defaultBinary());
const home = mkdtempSync(path.join(tmpdir(), 'wstack-smoke-home-'));
const project = mkdtempSync(path.join(tmpdir(), 'wstack-smoke-project-'));
const env = { ...process.env, WRONGSTACK_HOME: home, NO_COLOR: '1' };
const failures = [];

function run(args, timeoutMs = 60_000) {
  const result = spawnSync(binary, args, {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      return { status: res.status, body: await res.text() };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

async function main() {
  spawnSync('git', ['init', '-q', '.'], { cwd: project, windowsHide: true });
  console.log(`binary: ${binary}`);

  const version = run(['version']);
  check(
    'version',
    version.code === 0 && /^WrongStack \d+\.\d+\.\d+/m.test(version.out),
    version.out.trim(),
  );

  // A repo's `.env` / `bunfig.toml` must not reach the binary: Bun autoloads
  // both from the working directory unless the build disables it, and a
  // `bunfig.toml` `preload` runs repo code before WrongStack starts.
  const repo = mkdtempSync(path.join(tmpdir(), 'wstack-smoke-repo-'));
  writeFileSync(path.join(repo, 'bunfig.toml'), 'preload = ["./preload.js"]\n');
  writeFileSync(
    path.join(repo, 'preload.js'),
    'console.log("WSTACK_SMOKE_PRELOAD_RAN", process.env.WSTACK_SMOKE_DOTENV ?? "");\n',
  );
  // Observable without any CLI code: the entry extracts its assets under
  // WRONGSTACK_HOME, which the repo's `.env` points INTO the repo. Dotenv never
  // overrides a set variable, so this run leaves WRONGSTACK_HOME unset and
  // aims the home-dir fallback at a scratch dir instead of the real profile.
  const dotenvHome = path.join(repo, 'dotenv-home');
  writeFileSync(
    path.join(repo, '.env'),
    `WSTACK_SMOKE_DOTENV=leaked\nWRONGSTACK_HOME=${dotenvHome.replaceAll('\\', '/')}\n`,
  );
  const { WRONGSTACK_HOME: _unset, ...repoEnv } = env;
  const inRepo = spawnSync(binary, ['version'], {
    cwd: repo,
    env: { ...repoEnv, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const repoOut = `${inRepo.stdout ?? ''}${inRepo.stderr ?? ''}`;
  const dotenvLoaded = existsSync(dotenvHome);
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  check(
    'repo bunfig.toml preload not run',
    inRepo.status === 0 && !repoOut.includes('WSTACK_SMOKE_PRELOAD_RAN'),
    `exit ${inRepo.status}`,
  );
  check(
    'repo .env not loaded',
    !dotenvLoaded,
    dotenvLoaded ? 'WRONGSTACK_HOME taken from repo .env' : '',
  );

  const skills = run(['skills']);
  const bundled = (skills.out.match(/\[bundled\]/g) ?? []).length;
  check('bundled skills read from extracted assets', bundled > 0, `${bundled} bundled`);

  const chronicle = run(['chronicle']);
  check(
    'daemon dispatch (chronicle client ↔ __wstack_daemon)',
    chronicle.code === 0,
    `exit ${chronicle.code}`,
  );

  writeFileSync(
    path.join(project, 'tool.cjs'),
    'console.log("tool-ran", process.argv.slice(2).join(" ")); process.exit(7);\n',
  );
  const script = run(['__wstack_run_script', 'tool.cjs', 'a', 'b']);
  check(
    'script dispatch',
    script.code === 7 && script.out.includes('tool-ran a b'),
    `exit ${script.code}`,
  );

  const port = 38_000 + Math.floor(Math.random() * 1000);
  const webui = spawn(
    binary,
    ['webui', '--port', String(port), '--provider', 'wrongstack-setup', '--model', 'no-api-key'],
    { cwd: project, env, windowsHide: true },
  );
  let log = '';
  webui.stdout.on('data', (d) => {
    log += d;
  });
  webui.stderr.on('data', (d) => {
    log += d;
  });
  const page = await waitForHttp(`http://127.0.0.1:${port}/`, 45_000);
  const asset = page?.body.match(/assets\/[^"]+\.js/)?.[0];
  const assetRes = asset ? await waitForHttp(`http://127.0.0.1:${port}/${asset}`, 5_000) : null;
  webui.kill();
  check('webui serves index.html', page?.status === 200, `HTTP ${page?.status ?? 'no response'}`);
  check('webui serves bundled assets', assetRes?.status === 200, asset ?? 'no asset link');
  const pluginFailures = (log.match(/failed to load/g) ?? []).length;
  check('built-in plugins load', pluginFailures === 0, `${pluginFailures} failures`);
  check('no runtime SyntaxError', !log.includes('SyntaxError'));
}

try {
  await main();
} finally {
  // Project daemons spawned by the checks idle out on their own; on Windows
  // they hold the scratch dirs until then, so cleanup is best-effort.
  await new Promise((r) => setTimeout(r, 500));
  for (const dir of [project, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.log(`(left ${dir} for the idle daemons to release)`);
    }
  }
}

if (failures.length > 0) {
  console.error(`\nBinary smoke FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nBinary smoke passed.');
