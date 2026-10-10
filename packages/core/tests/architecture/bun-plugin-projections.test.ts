import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('plugin projections under Bun', () => {
  it('formats with the local Biome binary when Bun provides npm_execpath', () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const result = spawnSync(process.execPath, ['scripts/generate-plugin-projections.mjs'], {
      cwd: root,
      env: { ...process.env, npm_execpath: process.execPath },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Plugin projections match the typed manifest.');
  }, 25_000);
});
