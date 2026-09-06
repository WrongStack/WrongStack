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

  let failed = false;
  const transientRetryArgs =
    env.CI === 'true'
      ? [
          '--',
          '--retry.count',
          '2',
          '--retry.delay',
          '250',
          '--retry.condition',
          'ENOBUFS|EADDRINUSE|EADDRNOTAVAIL|EACCES|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE',
        ]
      : [];

  for (const run of runs) {
    log(`\n=== Coverage: ${run.label} ===\n`);
    const args = run.vitest ? [...run.args, ...transientRetryArgs] : run.args;
    const result = spawnPnpm(execPath, [pnpmCli, ...args], {
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
