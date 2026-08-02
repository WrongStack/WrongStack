/**
 * Tests for cli-update-notice.ts — update notice printing.
 */
import { describe, expect, it, vi } from 'vitest';

// Mock update-check at top level to avoid nested mock warning
vi.mock('../src/update-check.js', () => ({
  checkForUpdate: vi.fn().mockRejectedValue(new Error('network error')),
}));

describe('printUpdateNotice', () => {
  it('returns undefined when no info and check throws', async () => {
    const { printUpdateNotice } = await import('../src/cli-update-notice.js');
    const result = await printUpdateNotice();
    expect(result).toBeUndefined();
  });

  it('returns info when initialUpdateInfo is outdated', async () => {
    const { printUpdateNotice } = await import('../src/cli-update-notice.js');
    const info = { outdated: true, current: '1.0.0', latest: '1.1.0', checkFailed: false };
    const result = await printUpdateNotice(info);
    expect(result).toBe(info);
    expect(result?.outdated).toBe(true);
  });

  it('returns info when initialUpdateInfo is not outdated', async () => {
    const { printUpdateNotice } = await import('../src/cli-update-notice.js');
    const info = { outdated: false, current: '1.0.0', latest: '1.0.0', checkFailed: false };
    const result = await printUpdateNotice(info);
    expect(result).toBe(info);
  });
});
