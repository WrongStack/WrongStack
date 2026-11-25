import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCPTaskJournal } from '../src/task-journal.js';

describe('MCPTaskJournal.update validation (F1828)', () => {
  it('rejects non-integer retryAfter values without corrupting the durable journal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-journal-update-val-'));
    try {
      const journal = new MCPTaskJournal(dir);
      const owner = { sessionId: 'sess-1', agentId: 'agent-1' };
      const binding = 'c'.repeat(64);
      const token = randomUUID();
      const nowIso = new Date().toISOString();

      const receipt = await journal.create(
        owner,
        'demo-server',
        'run_job',
        binding,
        {
          taskId: 'task-1',
          status: 'working',
          createdAt: nowIso,
          lastUpdatedAt: nowIso,
          ttlMs: 60_000,
        },
        token,
      );

      const validRetry = Date.now() + 5_000;
      await journal.update(receipt.id, token, { retryAfter: validRetry });

      await expect(journal.update(receipt.id, token, { retryAfter: Number.NaN })).rejects.toThrow(
        'Malformed MCP task retry time',
      );
      await expect(
        journal.update(receipt.id, token, { retryAfter: Number.POSITIVE_INFINITY }),
      ).rejects.toThrow('Malformed MCP task retry time');
      await expect(journal.update(receipt.id, token, { retryAfter: 123.45 })).rejects.toThrow(
        'Malformed MCP task retry time',
      );

      const list = await journal.list(owner);
      expect(list).toHaveLength(1);
      expect(list[0]?.retryAfter).toBe(validRetry);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
