import { describe, expect, it } from 'vitest';
import { deferShutdownForRemoteWork, drainRemoteWork } from '../src/acp-leader/remote-work.js';

describe('drainRemoteWork timeout cap (F2241)', () => {
  it('caps oversized timeoutMs to 32-bit setTimeout max instead of resolving immediately', async () => {
    const release = deferShutdownForRemoteWork();
    const start = Date.now();
    setTimeout(release, 60);
    await drainRemoteWork(1e15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});
