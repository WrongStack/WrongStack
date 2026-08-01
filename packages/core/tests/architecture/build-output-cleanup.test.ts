import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanBuildOutput } from '../../../../scripts/lib/build-output-cleanup.mjs';

const transientError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

describe('cleanBuildOutput', () => {
  it('removes an ordinary build directory recursively', () => {
    const outputPath = join(tmpdir(), `wrongstack-build-clean-${process.pid}-${Date.now()}`);
    mkdirSync(outputPath, { recursive: true });
    writeFileSync(join(outputPath, 'stale.js'), 'stale');

    expect(cleanBuildOutput(outputPath)).toBe('removed');
    expect(existsSync(outputPath)).toBe(false);
  });

  it('reuses a verified empty directory after a transient Windows removal error', () => {
    const error = transientError('EPERM');
    const removeSync = () => {
      throw error;
    };

    expect(cleanBuildOutput('dist', { removeSync, listSync: () => [] })).toBe('retained-empty');
  });

  it('preserves the original removal error when stale output remains', () => {
    const error = transientError('EBUSY');
    const removeSync = () => {
      throw error;
    };

    expect(() => cleanBuildOutput('dist', { removeSync, listSync: () => ['stale.js'] })).toThrow(
      error,
    );
  });
});
