import { describe, expect, it } from 'vitest';
import { createBrainPersistenceQueue } from '../src/execution/brain-persistence.js';

describe('createBrainPersistenceQueue null-prototype rejection handling (F2227)', () => {
  it('converts null-prototype rejections into { ok: false, error } without throwing', async () => {
    const persist = createBrainPersistenceQueue(async () => {
      throw Object.create(null);
    });
    const res = await persist({} as unknown as Parameters<typeof persist>[0]);
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    expect(res.error?.length).toBeGreaterThan(0);
  });
});
