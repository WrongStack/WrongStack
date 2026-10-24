import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryPort } from '@wrongstack/contracts/types';
import { SAGE_SURFACE_CAPABILITY } from '@wrongstack/sage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAGE_SWEEP_MARKER_FILENAME, sweepStaleSageMirrors } from '../src/sage-event-mirror.js';
import type { VectorMemoryStore } from '../src/store.js';

const epoch = Date.parse('2026-01-01T00:00:00.000Z');
const port = (getSage: () => Promise<unknown>): MemoryPort =>
  ({
    getCapability: (cap: { id: string }) =>
      cap.id === SAGE_SURFACE_CAPABILITY.id ? { getSage } : undefined,
  }) as unknown as MemoryPort;

afterEach(() => vi.useRealTimers());

describe('stale SAGE sweep marker ownership', () => {
  it.each([0, 1])('retains a replacement owner with timestamp delta %s', async (delta) => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const directory = mkdtempSync(join(tmpdir(), 'wrongstack-sweep-claim-test-'));
    const markerPath = join(directory, SAGE_SWEEP_MARKER_FILENAME);
    const oldEntered = Promise.withResolvers<void>();
    const oldRelease = Promise.withResolvers<void>();
    const newEntered = Promise.withResolvers<void>();
    const newRelease = Promise.withResolvers<void>();
    let oldLists = 0;
    const oldStore = {
      directory,
      list: () => {
        if (++oldLists > 1) throw new Error('stale list failed');
        return Array.from({ length: 500 }, (_, i) => ({
          id: `old-${i}`,
          updatedAt: new Date(epoch).toISOString(),
          metadata: i === 0 ? { sageId: 'old' } : {},
        }));
      },
    } as unknown as VectorMemoryStore;
    const newStore = {
      directory,
      list: () => [
        { id: 'new', updatedAt: new Date(epoch).toISOString(), metadata: { sageId: 'new' } },
      ],
    } as unknown as VectorMemoryStore;
    let oldWork: ReturnType<typeof sweepStaleSageMirrors> | undefined;
    let newWork: ReturnType<typeof sweepStaleSageMirrors> | undefined;
    try {
      oldWork = sweepStaleSageMirrors({
        store: oldStore,
        memoryStore: port(async () => {
          oldEntered.resolve();
          await oldRelease.promise;
          return { scope: 'project', status: 'active' };
        }),
        force: true,
      });
      await oldEntered.promise;
      vi.setSystemTime(epoch + delta);
      newWork = sweepStaleSageMirrors({
        store: newStore,
        memoryStore: port(async () => {
          newEntered.resolve();
          await newRelease.promise;
          return { scope: 'project', status: 'active' };
        }),
        force: true,
      });
      await newEntered.promise;
      const claimed = readFileSync(markerPath, 'utf8');
      oldRelease.resolve();
      await expect(oldWork).resolves.toMatchObject({ swept: false, reason: 'stale list failed' });
      expect(readFileSync(markerPath, 'utf8')).toBe(claimed);
      await expect(
        sweepStaleSageMirrors({
          store: { directory, list: () => [] } as unknown as VectorMemoryStore,
          memoryStore: port(async () => null),
        }),
      ).resolves.toEqual({ swept: false, reason: 'throttled' });
      newRelease.resolve();
      await expect(newWork).resolves.toMatchObject({ swept: true });
    } finally {
      oldRelease.resolve();
      newRelease.resolve();
      await Promise.allSettled([oldWork, newWork]);
    }
  });

  it('removes its own failed claim', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wrongstack-sweep-own-failure-'));
    const store = {
      directory,
      list: () => {
        throw new Error('own failure');
      },
    } as unknown as VectorMemoryStore;
    await expect(
      sweepStaleSageMirrors({ store, memoryStore: port(async () => null) }),
    ).resolves.toMatchObject({ swept: false, reason: 'own failure' });
    expect(existsSync(join(directory, SAGE_SWEEP_MARKER_FILENAME))).toBe(false);
  });

  it('continues throttling from historical timestamp-only markers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const directory = mkdtempSync(join(tmpdir(), 'wrongstack-sweep-old-marker-'));
    writeFileSync(
      join(directory, SAGE_SWEEP_MARKER_FILENAME),
      JSON.stringify({ at: new Date(epoch).toISOString() }),
    );
    await expect(
      sweepStaleSageMirrors({
        store: { directory, list: () => [] } as unknown as VectorMemoryStore,
        memoryStore: port(async () => null),
      }),
    ).resolves.toEqual({ swept: false, reason: 'throttled' });
  });
});
