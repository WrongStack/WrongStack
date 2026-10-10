import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
function plan(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/test-package.mjs', ...args, '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('package test command', () => {
  it('selects exactly one package without broadening to similarly named packages', () => {
    const result = plan('sage', '@wrongstack/sage');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('[.] bun --bun run vitest run packages/sage/');
  });

  it('includes dedicated environments for frontend, dashboard and color tests', () => {
    const result = plan('cli', 'tui', 'webui');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      '[.] bun --bun run vitest run packages/cli/',
      '[packages/cli] bun --bun run vitest run --config vitest.hqdash.config.ts',
      '[.] bun --bun run vitest run packages/tui/',
      '[packages/tui] bun --bun run vitest run --config vitest.status-bar-sgr.config.ts',
      '[packages/webui] bun --bun run vitest run --config vitest.config.ts',
    ]);
  });

  it('rejects missing or unknown selectors before starting any suite', () => {
    for (const args of [[], ['missing-package'], ['../core']]) {
      const result = plan(...args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    }
  });
});
