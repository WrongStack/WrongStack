import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../../../scripts/check-browser-runtime.mjs', import.meta.url),
);

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('browser runtime doctor script', () => {
  it('documents its package-manager-independent repair flags', () => {
    const result = run('--help');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--install');
    expect(result.stdout).toContain('--with-deps');
    expect(result.stdout).toContain('--smoke');
  });

  it('rejects unknown options before loading Playwright', () => {
    const result = run('--unsupported');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown option: --unsupported');
  });

  it('requires installation mode for system dependency repair', () => {
    const result = run('--with-deps');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--with-deps requires --install');
  });
});
