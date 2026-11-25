import { describe, expect, it } from 'vitest';
import { withDaemonVersion } from '../src/runtime-version.js';

describe('withDaemonVersion whitespace handling (F1985)', () => {
  it('treats whitespace-only daemonVersion as unknown legacy and trims valid versions', () => {
    const blank = withDaemonVersion({ status: 'healthy', detail: 'OK.' }, '   ', '1.0.0');
    expect(blank.daemonVersion).toBeUndefined();
    expect(blank.detail).toContain('unknown (legacy)');

    const padded = withDaemonVersion({ status: 'healthy', detail: 'OK.' }, ' 1.0.0 ', '1.0.0');
    expect(padded.daemonVersion).toBe('1.0.0');
    expect(padded.versionMismatch).toBeUndefined();
  });
});
