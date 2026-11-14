import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bunSpawnInvocation, resolveBunExecutable } from './lib/bun-executable.mjs';

export const COVERAGE_RUNS = [
  {
    label: 'Bun packages',
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
    label: 'Coverage runtime scripts',
    args: ['test:coverage:scripts'],
    vitest: true,
  },
];

export function isDirectRun(metaUrl = import.meta.url, argvEntry = process.argv[1]) {
  return typeof argvEntry === 'string' && path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

export function runCoverage(options = {}) {
  const runs = options.runs ?? COVERAGE_RUNS;
  const spawnCommand = options.spawnCommand ?? spawnSync;
  const execPath = options.execPath ?? resolveBunExecutable(options.env ?? process.env);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;

  if (!execPath) {
    throw new Error('test:coverage requires a Bun executable');
  }

  let failed = false;
  const transientRetryArgs = env.CI === 'true' ? ['--retry', '2'] : [];

  for (const run of runs) {
    log(`\n=== Coverage: ${run.label} ===\n`);
    const args = run.vitest ? [...run.args, ...transientRetryArgs] : run.args;
    const spawn = bunSpawnInvocation(execPath, ['run', ...args]);
    const result = spawnCommand(spawn.command, spawn.args, {
      cwd,
      env,
      stdio: 'inherit',
      ...spawn.options,
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
