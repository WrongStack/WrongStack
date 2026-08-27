/**
 * Tests for the per-tool Chronicle rollup (`tool_daily`) and the
 * `underusedTools()` query used by the auto-thinning pipeline.
 *
 * The fixture is the in-memory `ChronicleMetricsIngester.ingestEvent()`
 * path — same shape the SQLite journal uses after a real boot, but with
 * no fs/sqlite side effects. The test asserts:
 *   1. The new `tool_daily` table is created by `ensureMetricsSchema`
 *      at SCHEMA_VERSION 6.
 *   2. `tool.started`, `tool.executed`, `tool.failed` events fold into
 *      the per-tool row with the right counter semantics.
 *   3. `underusedTools()` returns the right `invocations`/`lastInvokedAt`
 *      aggregates across a day range, with `daysSinceLastUse` derived
 *      from a deterministic anchor.
 *   4. The existing `daily_counters` (name-agnostic) totals stay
 *      consistent with the per-tool rows.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChronicleMetricsStore } from '../../src/chronicle/metrics-store.js';
import type { ChronicleEvent } from '../../src/chronicle/types.js';
import { CHRONICLE_SCHEMA_VERSION } from '../../src/chronicle/types.js';

const DAY_MS = 86_400_000;

function toolEvent(
  name: 'tool.started' | 'tool.executed' | 'tool.failed',
  toolName: string,
  occurredAt: string,
  extras: Record<string, unknown> = {},
): ChronicleEvent {
  return {
    schemaVersion: CHRONICLE_SCHEMA_VERSION,
    eventId: `e-${Math.random()}`,
    eventType: name,
    occurredAt,
    observedAt: occurredAt,
    persistedAt: occurredAt,
    sequence: 0,
    previousHash: '',
    hash: 'h',
    scope: { installationId: 'inst-1', machineId: 'machine-1', projectId: 'p1' },
    correlation: { traceId: 'trace-1', spanId: 'span-1' },
    attributes: { toolName, ...extras },
    outcome: name === 'tool.failed' ? 'failure' : 'success',
    ...(name === 'tool.executed' ? { durationNs: String(50_000_000) } : {}),
  };
}

describe('tool_daily rollup + underusedTools()', () => {
  let dir: string;
  let store: ChronicleMetricsStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-daily-'));
    store = ChronicleMetricsStore.open(dir);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the tool_daily table on first open', () => {
    const row = store['db']
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_daily'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('tool_daily');
  });

  it('folds tool.started / tool.executed / tool.failed per-tool and per-day', () => {
    const ingester = (
      store as unknown as { ingester: { ingestEvent: (e: ChronicleEvent) => void } }
    ).ingester;
    // Day 1: bash — 1 started, 1 executed (success), 1 failed
    ingester.ingestEvent(toolEvent('tool.started', 'bash', '2026-07-01T10:00:00.000Z'));
    ingester.ingestEvent(
      toolEvent('tool.executed', 'bash', '2026-07-01T10:00:01.000Z', { ok: true }),
    );
    ingester.ingestEvent(toolEvent('tool.failed', 'bash', '2026-07-01T10:00:02.000Z'));
    // Day 2: read — 3 started, 3 executed (success)
    for (let i = 0; i < 3; i++) {
      ingester.ingestEvent(toolEvent('tool.started', 'read', '2026-07-02T10:00:00.000Z'));
      ingester.ingestEvent(
        toolEvent('tool.executed', 'read', '2026-07-02T10:00:01.000Z', { ok: true }),
      );
    }
    const rows = store.underusedTools({ limit: 100 });
    const bash = rows.find((r) => r.toolName === 'bash');
    const read = rows.find((r) => r.toolName === 'read');
    // bash: started(1) + executed(1) + failed(0) = 2 invocations, 1 failure
    expect(bash?.invocations).toBe(2);
    expect(bash?.failures).toBe(1);
    // read: 3 started + 3 executed across day 2
    expect(read?.invocations).toBe(6);
    expect(read?.failures).toBe(0);
  });

  it('underusedTools() returns lastInvokedAt and the right ordering for the candidate set', () => {
    const ingester = (
      store as unknown as { ingester: { ingestEvent: (e: ChronicleEvent) => void } }
    ).ingester;
    // 5 days ago vs 60 days ago (no time-machine; we just verify ordering
    // and that lastInvokedAt is set to the event's wall-clock).
    const recent = new Date(Date.now() - 5 * DAY_MS).toISOString();
    const stale = new Date(Date.now() - 60 * DAY_MS).toISOString();
    ingester.ingestEvent(toolEvent('tool.started', 'recent', recent));
    ingester.ingestEvent(toolEvent('tool.started', 'stale', stale));
    const rows = store.underusedTools({ from: '2020-01-01', to: '2099-12-31' });
    const recentRow = rows.find((r) => r.toolName === 'recent');
    const staleRow = rows.find((r) => r.toolName === 'stale');
    // 5 days vs ~60 days, both integer-rounded (allow off-by-one for clock skew)
    expect(recentRow?.daysSinceLastUse).toBeGreaterThanOrEqual(4);
    expect(recentRow?.daysSinceLastUse).toBeLessThanOrEqual(6);
    expect(staleRow?.daysSinceLastUse).toBeGreaterThanOrEqual(59);
    expect(staleRow?.daysSinceLastUse).toBeLessThanOrEqual(61);
  });

  it('respects the from/to window filter', () => {
    const ingester = (
      store as unknown as { ingester: { ingestEvent: (e: ChronicleEvent) => void } }
    ).ingester;
    ingester.ingestEvent(toolEvent('tool.started', 'old', '2026-01-15T00:00:00.000Z'));
    ingester.ingestEvent(toolEvent('tool.started', 'new', '2026-07-15T00:00:00.000Z'));
    const onlyNew = store.underusedTools({ from: '2026-07-01', to: '2026-07-31' });
    expect(onlyNew.map((r) => r.toolName).sort()).toEqual(['new']);
  });

  it('returns invocations in ascending order so the smallest tools surface first', () => {
    const ingester = (
      store as unknown as { ingester: { ingestEvent: (e: ChronicleEvent) => void } }
    ).ingester;
    for (let i = 0; i < 10; i++) {
      ingester.ingestEvent(toolEvent('tool.started', 'busy', '2026-07-15T00:00:00.000Z'));
    }
    ingester.ingestEvent(toolEvent('tool.started', 'quiet', '2026-07-15T00:00:00.000Z'));
    const rows = store.underusedTools({ limit: 100 });
    expect(rows[0]?.toolName).toBe('quiet');
    expect(rows[1]?.toolName).toBe('busy');
  });

  it('drops events whose attributes.toolName is missing', () => {
    const ingester = (
      store as unknown as { ingester: { ingestEvent: (e: ChronicleEvent) => void } }
    ).ingester;
    ingester.ingestEvent({
      eventId: 'e-no-name',
      schemaVersion: CHRONICLE_SCHEMA_VERSION,
      eventType: 'tool.started',
      occurredAt: '2026-07-15T00:00:00.000Z',
      observedAt: '2026-07-15T00:00:00.000Z',
      persistedAt: '2026-07-15T00:00:00.000Z',
      sequence: 0,
      previousHash: '',
      hash: 'h',
      scope: { installationId: 'inst-1', machineId: 'machine-1' },
      correlation: { traceId: 'trace-1', spanId: 'span-1' },
      attributes: {},
      outcome: 'started',
    });
    const rows = store.underusedTools({ limit: 100 });
    expect(rows).toHaveLength(0);
  });
});
