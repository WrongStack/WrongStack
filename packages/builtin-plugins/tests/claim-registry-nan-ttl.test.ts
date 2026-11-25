import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it } from 'vitest';
import { recordStartedReview } from '../src/review-claim-registry.js';

describe('review-claim-registry non-finite TTL fallback (F1858)', () => {
  it('falls back to default TTL so claim expiry is always a finite number', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claim-registry-ttl-'));
    try {
      const bus = {} as EventBus;
      const cwd = path.join(tmpDir, 'repo');

      for (const [idx, badTtl] of [Number.NaN, 0, -100, Number.POSITIVE_INFINITY].entries()) {
        const storeDir = path.join(tmpDir, `s-${idx}`);
        await fs.mkdir(storeDir, { recursive: true });
        await recordStartedReview(
          bus,
          { cwd, files: [{ path: `src/f${idx}.ts`, content: `const v = ${idx};` }] },
          { storeDir, ttlMs: badTtl, maxLedgerLines: Number.NaN },
        );
        const raw = await fs.readFile(path.join(storeDir, 'review-claims.jsonl'), 'utf8');
        const parsed = JSON.parse(raw.trim()) as { ts: number; exp: unknown };
        expect(typeof parsed.exp).toBe('number');
        expect(Number.isFinite(parsed.exp)).toBe(true);
        expect(parsed.exp as number).toBeGreaterThan(parsed.ts);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
