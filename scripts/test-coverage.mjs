import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COVERAGE_RUNS = [
  {
    label: 'Node packages',
    args: ['test:coverage:root'],
    vitest: true,
  },
  {
    label: 'Zero-statement file ratchet',
    args: ['check:coverage-zero'],
  },
  {
    label: 'LSP package per-file gate',
    args: ['--filter', '@wrongstack/plug-lsp', 'test:coverage'],
    vitest: true,
  },
  {
    label: 'WebUI package',
    args: ['--filter', '@wrongstack/webui', 'test:coverage'],
    vitest: true,
  },
  {
    label: 'webui-protocol package',
    args: ['--filter', '@wrongstack/webui-protocol', 'test:coverage'],
    vitest: true,
  },
  {
    label: 'Desktop package',
    args: ['--filter', '@wrongstack/desktop', 'test:coverage'],
    vitest: true,
  },
  {
    label: 'Coverage runtime scripts',
    args: ['test:coverage:scripts'],
    vitest: true,
  },
];

export function isDirectRun(metaUrl = import.meta.url, argvEntry = process.argv[1]) {
  return typeof argvEntry === 'string' && path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

export function resolvePnpmInvocation(pnpmCli, execPath = process.execPath) {
  // Corepack 0.34+ can set npm_execpath to its native pnpm executable on
  // Windows. Unlike pnpm's JavaScript CLI, an .exe must be spawned directly;
  // passing it to Node makes ESM reject the unknown extension.
  return path.extname(pnpmCli).toLowerCase() === '.exe'
    ? { command: pnpmCli, args: [] }
    : { command: execPath, args: [pnpmCli] };
}

export function runCoverage(options = {}) {
  const pnpmCli = options.pnpmCli ?? process.env.npm_execpath;
  const runs = options.runs ?? COVERAGE_RUNS;
  const spawnPnpm = options.spawnPnpm ?? spawnSync;
  const execPath = options.execPath ?? process.execPath;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;

  if (!pnpmCli) {
    throw new Error('test:coverage must be started through pnpm');
  }

  const pnpm = resolvePnpmInvocation(pnpmCli, execPath);

  let failed = false;
  const transientRetryArgs =
    env.CI === 'true'
      ? [
          '--',
          // Vitest supports --retry, but not nested retry config flags. Keep
          // this as an argv value so pnpm never hands a shell a `|` expression.
          '--retry',
          '2',
        ]
      : [];

  for (const run of runs) {
    log(`\n=== Coverage: ${run.label} ===\n`);
    const args = run.vitest ? [...run.args, ...transientRetryArgs] : run.args;
    const result = spawnPnpm(pnpm.command, [...pnpm.args, ...args], {
      cwd,
      env,
      stdio: 'inherit',
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      failed = true;
    }
  }

  return failed ? 1 : 0;
}

if (isDirectRun()) {
  process.exitCode = runCoverage();
}
