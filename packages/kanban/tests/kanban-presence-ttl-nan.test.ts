import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { touchKanbanPresence } from '../src/manager/presence.js';

describe('touchKanbanPresence non-finite ttlMs guard', () => {
  it('falls back to default TTL when ttlMs is NaN', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ws-f2065-test-'));
    try {
      await expect(
        touchKanbanPresence(dir, 'default', {
          sessionId: 's1',
          agentId: 'a1',
          ttlMs: Number.NaN,
        }),
      ).resolves.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
