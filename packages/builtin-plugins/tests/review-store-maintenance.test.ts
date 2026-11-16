import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FINDING_IGNORED_RETENTION_MS,
  FINDING_RESOLVED_RETENTION_MS,
  JsonlFindingStore,
} from '../src/review-finding-store.js';
import type { ChimeraFinding } from '../src/review-finding-types.js';
import { JsonlReportStore } from '../src/review-report-store.js';
import {
  maybeCompactReviewStores,
  REVIEW_FINDING_NON_TERMINAL_RETENTION_MS,
  REVIEW_STORE_MAINTENANCE_FILE,
  REVIEW_STORE_NON_TERMINAL_RETENTION_MS,
  resolveFindingNonTerminalRetentionMs,
  resolveNonTerminalRetentionMs,
} from '../src/review-store-maintenance.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-store-maintenance-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('review store maintenance', () => {
  it('skips small stores without creating maintenance state', async () => {
    const result = await maybeCompactReviewStores(dir);

    expect(result).toMatchObject({ compacted: false, reason: 'below_threshold', totalBytes: 0 });
    await expect(fs.stat(path.join(dir, REVIEW_STORE_MAINTENANCE_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('compacts above the threshold and throttles subsequent rewrites', async () => {
    const reportStore = new JsonlReportStore(dir);
    await reportStore.persist({
      id: 'report-1',
      sessionId: 'session-1',
      agentId: 'chimera',
      reviewerModel: 'reviewer',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: 'all clear',
    });

    const first = await maybeCompactReviewStores(dir, {
      thresholdBytes: 0,
      intervalMs: 60_000,
      now: Date.parse('2026-08-02T00:00:00.000Z'),
    });
    const second = await maybeCompactReviewStores(dir, {
      thresholdBytes: 0,
      intervalMs: 60_000,
      now: Date.parse('2026-08-02T00:00:01.000Z'),
    });

    expect(first).toMatchObject({ compacted: true, reason: 'compacted' });
    expect(second).toMatchObject({ compacted: false, reason: 'interval' });
    expect(await reportStore.get('report-1')).not.toBeNull();
  });

  it('serializes concurrent finding upserts before deduplication', async () => {
    const store = new JsonlFindingStore(dir);
    const finding = makeFinding();

    const [first, second] = await Promise.all([
      store.upsert([finding], context('report-1')),
      store.upsert([{ ...finding, id: 'finding-2' }], context('report-2')),
    ]);

    expect(first.created + second.created).toBe(1);
    expect(first.relinked + second.relinked).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it('evicts non-terminal reports past the cap and leaves terminal rows untouched', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist(reportInput('open-old'));
    await store.persist(reportInput('terminal-old'));
    await store.transition('terminal-old', 'completed', { id: 'op', kind: 'operator' });

    // A cap of -1 makes every non-terminal row age-eligible, so this pins the
    // one invariant that matters: the bounded path must never reach a terminal
    // row. `persist` stamps reviewedAt with no clock seam, so an aggressive cap
    // proves the boundary instead of an aged fixture.
    const result = await maybeCompactReviewStores(dir, {
      thresholdBytes: 0,
      intervalMs: 60_000,
      now: Date.now(),
      nonTerminalRetentionMs: -1,
    });

    expect(result).toMatchObject({
      compacted: true,
      reason: 'compacted',
      // Terminal retention (90 days) was not reached by either row, so the
      // terminal counter stays at zero while the sweep reports one.
      removedReports: 0,
      removedOpenReports: 1,
    });
    expect(await store.get('open-old')).toBeNull();

    const terminal = await store.get('terminal-old');
    expect(terminal).not.toBeNull();
    expect(terminal?.lifecycle).toBe('completed');

    // The durable marker records the split, so an operator can tell which kind
    // of row a maintenance pass removed.
    const raw = await fs.readFile(store.storePath, 'utf8');
    const marker = raw
      .trim()
      .split(/\r?\n/)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .find((o) => o['__reportCompact'] === 1);
    expect(marker).toMatchObject({ removedReports: 0, removedNonTerminalReports: 1 });
  });

  it('keeps non-terminal rows under the default cap and honors the opt-out', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist(reportInput('open-fresh'));

    // The default cap is 180 days, so a just-written open report survives:
    // turning the path on must not mass-delete live review history.
    const byDefault = await maybeCompactReviewStores(dir, {
      thresholdBytes: 0,
      intervalMs: 60_000,
      now: Date.now(),
    });
    expect(byDefault).toMatchObject({ removedReports: 0, removedOpenReports: 0 });
    expect(await store.get('open-fresh')).not.toBeNull();

    // Infinity restores the historical retain-forever behavior for these rows.
    const disabled = await maybeCompactReviewStores(dir, {
      thresholdBytes: 0,
      intervalMs: 0,
      now: Date.now() + 1,
      nonTerminalRetentionMs: Number.POSITIVE_INFINITY,
    });
    expect(disabled).toMatchObject({ compacted: true, removedOpenReports: 0 });
    expect(await store.get('open-fresh')).not.toBeNull();
  });

  it('maps openRetentionDays to the cap without touching terminal retention', () => {
    const DAY = 86_400_000;
    // Unset → shipped default.
    expect(resolveNonTerminalRetentionMs({})).toBe(REVIEW_STORE_NON_TERMINAL_RETENTION_MS);
    expect(resolveNonTerminalRetentionMs({ openRetentionDays: undefined })).toBe(
      REVIEW_STORE_NON_TERMINAL_RETENTION_MS,
    );
    // Positive whole days → that window.
    expect(resolveNonTerminalRetentionMs({ openRetentionDays: 30 })).toBe(30 * DAY);
    expect(resolveNonTerminalRetentionMs({ openRetentionDays: 180 })).toBe(180 * DAY);
    // 0 is the operator-facing "off" value, matching the WebUI 0 = unlimited
    // convention — it must disable, not evict everything.
    expect(resolveNonTerminalRetentionMs({ openRetentionDays: 0 })).toBe(Number.POSITIVE_INFINITY);
    // Malformed config values fall back to the default instead of wiping history.
    for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveNonTerminalRetentionMs({ openRetentionDays: bad })).toBe(
        REVIEW_STORE_NON_TERMINAL_RETENTION_MS,
      );
    }
    // The millisecond form still wins, so programmatic callers are unaffected.
    expect(
      resolveNonTerminalRetentionMs({ nonTerminalRetentionMs: 1234, openRetentionDays: 30 }),
    ).toBe(1234);
    expect(resolveNonTerminalRetentionMs({ nonTerminalRetentionMs: 0 })).toBe(0);
  });

  it('maps activeRetentionDays for findings and defaults above both terminal windows', () => {
    const DAY = 86_400_000;
    // The shipped default must outlive the longest terminal finding window, or
    // an untriaged finding would expire before a resolved one.
    expect(REVIEW_FINDING_NON_TERMINAL_RETENTION_MS).toBeGreaterThan(FINDING_RESOLVED_RETENTION_MS);
    expect(REVIEW_FINDING_NON_TERMINAL_RETENTION_MS).toBeGreaterThan(FINDING_IGNORED_RETENTION_MS);
    expect(resolveFindingNonTerminalRetentionMs({})).toBe(REVIEW_FINDING_NON_TERMINAL_RETENTION_MS);
    expect(resolveFindingNonTerminalRetentionMs({ activeRetentionDays: 30 })).toBe(30 * DAY);
    // Same `0` = off convention as the report cap.
    expect(resolveFindingNonTerminalRetentionMs({ activeRetentionDays: 0 })).toBe(
      Number.POSITIVE_INFINITY,
    );
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveFindingNonTerminalRetentionMs({ activeRetentionDays: bad })).toBe(
        REVIEW_FINDING_NON_TERMINAL_RETENTION_MS,
      );
    }
    expect(
      resolveFindingNonTerminalRetentionMs({
        nonTerminalFindingsRetentionMs: 1234,
        activeRetentionDays: 30,
      }),
    ).toBe(1234);
  });

  it('honors openRetentionDays: 0 end-to-end and keeps non-terminal rows', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist(reportInput('open-config-off'));

    const result = await maybeCompactReviewStores(dir, {
      thresholdBytes: 0,
      intervalMs: 60_000,
      now: Date.now(),
      openRetentionDays: 0,
    });

    expect(result).toMatchObject({ compacted: true, removedOpenReports: 0 });
    expect(await store.get('open-config-off')).not.toBeNull();
  });

  it('evicts aged non-terminal rows at the operator day caps and spares younger ones', async () => {
    // End-to-end through the real maintenance entry: config-shaped day values
    // -> capFromDays -> both stores' compact() -> atomic rewrite.
    const reports = new JsonlReportStore(dir);
    const findings = new JsonlFindingStore(dir);
    const aged = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

    await reports.persist(reportInput('cap-report-100d'));
    await reports.persist(reportInput('cap-report-40d'));
    // `persist()` stamps reviewedAt with no clock seam, so the age is applied to
    // the record on disk — the exact field compact() measures age from.
    await backdateReport(reports.storePath, 'cap-report-100d', 100);
    await backdateReport(reports.storePath, 'cap-report-40d', 40);

    // Findings accept a caller-supplied createdAt, so these need no rewrite.
    await findings.upsert(
      [{ ...makeFinding(), id: 'cap-finding-50d', fingerprint: 'fp-cap-50d', createdAt: aged(50) }],
      context('cap-report-100d'),
    );
    await findings.upsert(
      [{ ...makeFinding(), id: 'cap-finding-40d', fingerprint: 'fp-cap-40d', createdAt: aged(40) }],
      context('cap-report-40d'),
    );

    const result = await maybeCompactReviewStores(dir, {
      thresholdBytes: 0,
      intervalMs: 60_000,
      now: Date.now(),
      openRetentionDays: 45,
      activeRetentionDays: 45,
    });

    expect(result).toMatchObject({
      compacted: true,
      reason: 'compacted',
      // Terminal retention never fired: no row here is completed/skipped.
      removedReports: 0,
      removedFindings: 0,
      removedOpenReports: 1,
      removedActiveFindings: 1,
    });

    expect(await reports.get('cap-report-100d')).toBeNull();
    expect(await findings.get('cap-finding-50d')).toBeNull();
    // The 40d survivors pin the boundary — they are older than a fresh row on
    // purpose, so this is not merely "recent rows survive".
    expect(await reports.get('cap-report-40d')).not.toBeNull();
    expect(await findings.get('cap-finding-40d')).not.toBeNull();
  });

  it('strips UTF-8 BOM from .review-store-maintenance.json so interval throttling holds (F489)', async () => {
    const { REVIEW_STORE_MAINTENANCE_FILE } = await import('../src/review-store-maintenance.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-maint-bom-'));
    try {
      const nowMs = Date.now();
      await fs.writeFile(
        path.join(dir, REVIEW_STORE_MAINTENANCE_FILE),
        `\uFEFF${JSON.stringify({ compactedAt: new Date(nowMs - 1_000).toISOString(), totalBytesBefore: 100 })}`,
        'utf8',
      );
      const res = await maybeCompactReviewStores(dir, { thresholdBytes: 0, now: nowMs });
      expect(res.reason).toBe('interval');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Shift a persisted report's `reviewedAt` back in time. `JsonlReportStore.persist()`
 * hardcodes `reviewedAt: new Date().toISOString()` with no clock seam, so this is
 * the only way to build an aged report fixture. It rewrites that one field on the
 * target id's record line and returns every other line byte-identical.
 */
async function backdateReport(storePath: string, id: string, daysAgo: number): Promise<void> {
  const reviewedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const lines = (await fs.readFile(storePath, 'utf8')).split('\n');
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    let record: { __report?: number; data?: { id?: string; reviewedAt?: string } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      return line;
    }
    if (record.__report === 1 && record.data?.id === id) {
      record.data!.reviewedAt = reviewedAt;
      return JSON.stringify(record);
    }
    return line;
  });
  await fs.writeFile(storePath, next.join('\n'), 'utf8');
}

function reportInput(id: string) {
  return {
    id,
    sessionId: 'session-1',
    agentId: 'chimera',
    reviewerModel: 'reviewer',
    source: 'chimera' as const,
    reviewStatus: 'success' as const,
    files: [],
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    totalFindings: 0,
    unparseableCount: 0,
    rawText: 'report body',
  };
}

function context(reportId: string) {
  return {
    sessionId: 'session-1',
    reportId,
    agentId: 'chimera',
    model: 'reviewer',
  };
}

function makeFinding(): ChimeraFinding {
  return {
    id: 'finding-1',
    fingerprint: 'same-fingerprint',
    title: 'Issue',
    description: 'Details',
    severity: 'high',
    source: 'chimera',
    status: 'active',
    location: { file: 'src/file.ts', line: 1 },
    suggestedFix: 'Fix it',
    originReport: {
      reportId: 'report-1',
      sessionId: 'session-1',
      agentId: 'chimera',
      reviewerModel: 'reviewer',
    },
    createdAt: '2026-08-02T00:00:00.000Z',
  };
}
