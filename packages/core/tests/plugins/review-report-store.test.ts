/**
 * Tests for the Chimera Review Report Store.
 *
 * Covers: persist, lifecycle transitions, note events, query/filter,
 * compaction, and the report integration hook.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlReportStore } from '../../src/plugins/review-report-store.js';
import {
  InvalidReportTransitionError,
  validateReportTransition,
} from '../../src/plugins/review-report-types.js';
import {
  resolveChimeraConfig,
  type ChimeraReviewCompletePayload,
} from '../../src/plugins/chimera-plugin.js';
import {
  persistReviewReport,
  syncReportCompletion,
  syncReportReopen,
} from '../../src/plugins/review-report-integration.js';
import { executeFindingCommand } from '../../src/plugins/review-finding-commands.js';
import { JsonlFindingStore } from '../../src/plugins/review-finding-store.js';
import { integrateFindings } from '../../src/plugins/review-finding-integration.js';

let dir: string;

function makePayload(
  opts: {
    reviewText?: string;
    status?: string;
    cascadeDepth?: number;
    cascadeOn?: 'off' | 'critical' | 'high';
  } = {},
): ChimeraReviewCompletePayload {
  return {
    bundle: {
      config: resolveChimeraConfig({}, 'test-provider', 'test-model'),
      cwd: dir,
      files: [{ path: 'src/app.ts', status: 'modified' as const, content: 'x' }],
      ...(opts.cascadeDepth !== undefined ? { cascadeDepth: opts.cascadeDepth } : {}),
      ...(opts.cascadeOn !== undefined ? { cascadeOn: opts.cascadeOn } : {}),
    },
    reviewText: opts.reviewText ?? '',
    status: opts.status ?? 'success',
    cwd: dir,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-store-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// ── Type / state machine tests ────────────────────────────────────

describe('validateReportTransition', () => {
  it('allows open → actioned', () => {
    expect(() => validateReportTransition('open', 'actioned')).not.toThrow();
  });

  it('allows open → completed (direct close)', () => {
    expect(() => validateReportTransition('open', 'completed')).not.toThrow();
  });

  it('allows open → skipped', () => {
    expect(() => validateReportTransition('open', 'skipped')).not.toThrow();
  });

  it('allows actioned → completed', () => {
    expect(() => validateReportTransition('actioned', 'completed')).not.toThrow();
  });

  it('allows completed → open (reopen)', () => {
    expect(() => validateReportTransition('completed', 'open')).not.toThrow();
  });

  it('allows skipped → open (reopen)', () => {
    expect(() => validateReportTransition('skipped', 'open')).not.toThrow();
  });

  it('rejects completed → actioned', () => {
    expect(() => validateReportTransition('completed', 'actioned')).toThrow(
      InvalidReportTransitionError,
    );
  });

  it('rejects skipped → completed', () => {
    expect(() => validateReportTransition('skipped', 'completed')).toThrow(
      InvalidReportTransitionError,
    );
  });

  it('treats same-status as idempotent', () => {
    expect(() => validateReportTransition('open', 'open')).not.toThrow();
    expect(() => validateReportTransition('completed', 'completed')).not.toThrow();
  });
});

// ── Store: persist ────────────────────────────────────────────────

describe('JsonlReportStore.persist', () => {
  it('creates a new report record with lifecycle "open"', async () => {
    const store = new JsonlReportStore(dir);
    const report = await store.persist({
      id: 'r1',
      sessionId: 'sess-1',
      agentId: 'chimera-review',
      reviewerModel: 'gpt-5',
      source: 'chimera',
      reviewStatus: 'success',
      files: [{ path: 'src/a.ts', status: 'modified' }],
      counts: { critical: 1, high: 2, medium: 0, low: 0 },
      totalFindings: 3,
      unparseableCount: 0,
      rawText: '### Critical (1)\n1. src/a.ts:1 — bug',
    });

    expect(report.id).toBe('r1');
    expect(report.lifecycle).toBe('open');
    expect(report.reviewedAt).toBeTruthy();
    expect(report.counts).toEqual({ critical: 1, high: 2, medium: 0, low: 0 });
    expect(report.rawText).toContain('### Critical');
  });

  it('writes a created lifecycle event', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist({
      id: 'r2',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: '',
    });

    const events = await store.getEvents('r2');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('created');
    expect(events[0]!.fromLifecycle).toBeNull();
    expect(events[0]!.toLifecycle).toBe('open');
  });

  it('updates counts/rawText on re-persist without duplicating created event', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist({
      id: 'r3',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: 'old',
    });

    await store.persist({
      id: 'r3',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 1, high: 0, medium: 0, low: 0 },
      totalFindings: 1,
      unparseableCount: 0,
      rawText: 'new text',
    });

    const fetched = await store.get('r3');
    expect(fetched!.counts.critical).toBe(1);
    expect(fetched!.rawText).toBe('new text');

    // Only one created event.
    const events = await store.getEvents('r3');
    const createdEvents = events.filter((e) => e.eventType === 'created');
    expect(createdEvents).toHaveLength(1);
  });

  it('persists and updates cascade evidence across fresh store reads', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist({
      id: 'evidence-1',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'cascade',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      totalFindings: 1,
      unparseableCount: 0,
      rawText: 'review',
      evidenceStatus: 'missing',
      evidenceChecks: [],
    });

    const checks = [
      {
        name: 'typecheck' as const,
        command: 'pnpm typecheck',
        claimedExitCode: 0,
        actualExitCode: 0,
        ok: true,
      },
    ];
    await store.updateEvidence('evidence-1', 'verified', checks);

    const reread = await new JsonlReportStore(dir).get('evidence-1');
    expect(reread?.evidenceStatus).toBe('verified');
    expect(reread?.evidenceChecks).toEqual(checks);
  });

  it('persists cascadeDepth when provided', async () => {
    const store = new JsonlReportStore(dir);
    const report = await store.persist({
      id: 'r4',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'cascade',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: '',
      cascadeDepth: 2,
    });
    expect(report.cascadeDepth).toBe(2);
  });
});

// ── Store: lifecycle transitions ──────────────────────────────────

describe('JsonlReportStore.transition', () => {
  it('transitions open → completed and records event', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist({
      id: 't1',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: '',
    });

    const updated = await store.transition(
      't1',
      'completed',
      { id: 'leader', kind: 'operator' },
      { reason: 'All fixed' },
    );
    expect(updated.lifecycle).toBe('completed');

    const fetched = await store.get('t1');
    expect(fetched!.lifecycle).toBe('completed');

    const events = await store.getEvents('t1');
    const completed = events.find((e) => e.eventType === 'completed');
    expect(completed).toBeDefined();
    expect(completed!.fromLifecycle).toBe('open');
    expect(completed!.toLifecycle).toBe('completed');
    expect(completed!.reason).toBe('All fixed');
  });

  it('throws on invalid transition', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist({
      id: 't2',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: '',
    });
    await store.transition('t2', 'completed', { id: 'op', kind: 'operator' });

    await expect(
      store.transition('t2', 'actioned', { id: 'op', kind: 'operator' }),
    ).rejects.toThrow(InvalidReportTransitionError);
  });

  it('allows reopen from completed → open', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist({
      id: 't3',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: '',
    });
    await store.transition('t3', 'completed', { id: 'op', kind: 'operator' });
    const reopened = await store.transition(
      't3',
      'open',
      { id: 'op', kind: 'operator' },
      { reason: 'Resurfaced' },
    );
    expect(reopened.lifecycle).toBe('open');
  });

  it('throws when report not found', async () => {
    const store = new JsonlReportStore(dir);
    await expect(
      store.transition('nonexistent', 'completed', { id: 'op', kind: 'operator' }),
    ).rejects.toThrow();
  });
});

// ── Store: addNote ────────────────────────────────────────────────

describe('JsonlReportStore.addNote', () => {
  it('records a note event without changing lifecycle', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist({
      id: 'n1',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: '',
    });

    await store.addNote('n1', { id: 'leader', kind: 'operator' }, 'Reviewing tomorrow');

    const fetched = await store.get('n1');
    expect(fetched!.lifecycle).toBe('open'); // unchanged

    const events = await store.getEvents('n1');
    const note = events.find((e) => e.eventType === 'note_added');
    expect(note).toBeDefined();
    expect(note!.reason).toBe('Reviewing tomorrow');
    expect(note!.fromLifecycle).toBe('open');
    expect(note!.toLifecycle).toBe('open');
  });
});

// ── Store: list + filter ──────────────────────────────────────────

describe('JsonlReportStore.list', () => {
  beforeEach(async () => {
    const store = new JsonlReportStore(dir);
    for (const [id, source, lifecycle] of [
      ['l1', 'chimera', 'open'],
      ['l2', 'auto', 'completed'],
      ['l3', 'cascade', 'open'],
      ['l4', 'chimera', 'skipped'],
    ] as const) {
      await store.persist({
        id,
        sessionId: 's',
        agentId: 'a',
        reviewerModel: 'm',
        source,
        reviewStatus: 'success',
        files: [],
        counts: { critical: 0, high: 0, medium: 0, low: 0 },
        totalFindings: 0,
        unparseableCount: 0,
        rawText: '',
      });
      if (lifecycle !== 'open') {
        await store.transition(id, lifecycle, { id: 'op', kind: 'operator' });
      }
    }
  });

  it('lists all reports sorted newest-first', async () => {
    const store = new JsonlReportStore(dir);
    const all = await store.list({ limit: 100 });
    expect(all).toHaveLength(4);
    // Verify newest-first ordering
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.reviewedAt <= all[i - 1]!.reviewedAt).toBe(true);
    }
  });

  it('filters by status', async () => {
    const store = new JsonlReportStore(dir);
    const open = await store.list({ statuses: ['open'], limit: 100 });
    expect(open).toHaveLength(2);
    expect(open.every((r) => r.lifecycle === 'open')).toBe(true);

    const completed = await store.list({ statuses: ['completed'], limit: 100 });
    expect(completed).toHaveLength(1);
    expect(completed[0]!.id).toBe('l2');
  });

  it('filters by source', async () => {
    const store = new JsonlReportStore(dir);
    const chimera = await store.list({ sources: ['chimera'], limit: 100 });
    expect(chimera).toHaveLength(2);
    expect(chimera.every((r) => r.source === 'chimera')).toBe(true);
  });

  it('respects limit', async () => {
    const store = new JsonlReportStore(dir);
    const limited = await store.list({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});

// ── Store: compaction ─────────────────────────────────────────────

describe('JsonlReportStore.compact', () => {
  it('removes terminal reports older than maxAge', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist({
      id: 'c1',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: '',
    });
    await store.transition('c1', 'completed', { id: 'op', kind: 'operator' });

    // Compact with maxAge=0 → everything terminal is removed
    const result = await store.compact({ maxAgeMs: 0 });
    expect(result.removed).toBe(1);

    const fetched = await store.get('c1');
    expect(fetched).toBeNull();
  });

  it('does not remove open reports regardless of age', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist({
      id: 'c2',
      sessionId: 's',
      agentId: 'a',
      reviewerModel: 'm',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
      totalFindings: 0,
      unparseableCount: 0,
      rawText: '',
    });

    const result = await store.compact({ maxAgeMs: 0 });
    expect(result.removed).toBe(0);

    const fetched = await store.get('c2');
    expect(fetched).not.toBeNull();
  });
});

// ── Integration: persistReviewReport ──────────────────────────────

describe('persistReviewReport', () => {
  it('parses review text and persists structured metadata', async () => {
    const reportText = [
      '### Critical (1)',
      '1. [BUG] src/app.ts:42 — Null dereference',
      '',
      '### High (1)',
      '1. src/db.ts:15 — Unclosed connection',
    ].join('\n');

    const result = await persistReviewReport(makePayload({ reviewText: reportText }), 'int-1', dir);

    expect(result.reportId).toBe('int-1');
    expect(result.created).toBe(true);
    expect(result.totalFindings).toBe(2);

    const store = new JsonlReportStore(dir);
    const report = await store.get('int-1');
    expect(report).not.toBeNull();
    expect(report!.counts).toEqual({ critical: 1, high: 1, medium: 0, low: 0 });
    expect(report!.totalFindings).toBe(2);
    expect(report!.rawText).toBe(reportText);
    expect(report!.reviewStatus).toBe('success');
    expect(report!.reviewerModel).toBe('test-model');
    expect(report!.files).toEqual([{ path: 'src/app.ts', status: 'modified' }]);
  });

  it('persists failed review with zero findings', async () => {
    const result = await persistReviewReport(
      makePayload({ reviewText: '', status: 'failed' }),
      'int-2',
      dir,
    );

    expect(result.totalFindings).toBe(0);

    const store = new JsonlReportStore(dir);
    const report = await store.get('int-2');
    expect(report!.reviewStatus).toBe('failed');
    expect(report!.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(report!.lifecycle).toBe('open');
  });

  it('keeps an unparseable non-clean review open for leader disposition', async () => {
    await persistReviewReport(
      makePayload({ reviewText: '### High (1)\nThis item does not match the finding format.' }),
      'int-unparseable',
      dir,
    );

    const store = new JsonlReportStore(dir);
    const report = await store.get('int-unparseable');
    expect(report!.totalFindings).toBe(0);
    expect(report!.unparseableCount).toBe(1);
    expect(report!.lifecycle).toBe('open');
  });

  it('classifies source as cascade when cascadeDepth > 0', async () => {
    await persistReviewReport(makePayload({ reviewText: '', cascadeDepth: 1 }), 'int-3', dir);

    const store = new JsonlReportStore(dir);
    const report = await store.get('int-3');
    expect(report!.source).toBe('cascade');
    expect(report!.cascadeDepth).toBe(1);
  });

  it('classifies source as auto when cascadeOn is active', async () => {
    await persistReviewReport(makePayload({ reviewText: '', cascadeOn: 'high' }), 'int-4', dir);

    const store = new JsonlReportStore(dir);
    const report = await store.get('int-4');
    expect(report!.source).toBe('auto');
  });

  it('classifies source as chimera by default', async () => {
    await persistReviewReport(makePayload({ reviewText: '' }), 'int-5', dir);

    const store = new JsonlReportStore(dir);
    const report = await store.get('int-5');
    expect(report!.source).toBe('chimera');
  });
});

// ── Slash commands ────────────────────────────────────────────────

describe('/review report commands', () => {
  beforeEach(async () => {
    const reportText = [
      '### Critical (1)',
      '1. [BUG] src/app.ts:42 — Null dereference',
      '   → Add null guard',
      '',
      '### High (1)',
      '1. src/db.ts:15 — Unclosed connection',
    ].join('\n');
    await persistReviewReport(makePayload({ reviewText: reportText }), 'cmd-1', dir);
  });

  it('/review reports lists reports', async () => {
    const output = await executeFindingCommand(['reports'], { projectDir: dir });
    expect(output).toContain('cmd-1'.substring(0, 8));
    expect(output).toContain('open');
    expect(output).toContain('chimera');
  });

  it('/review reports --status filters by lifecycle', async () => {
    // Transition to completed
    const store = new JsonlReportStore(dir);
    await store.transition('cmd-1', 'completed', { id: 'op', kind: 'operator' });

    const openOutput = await executeFindingCommand(['reports', '--status', 'open'], {
      projectDir: dir,
    });
    expect(openOutput).toContain('No reports found');

    const completedOutput = await executeFindingCommand(['reports', '--status', 'completed'], {
      projectDir: dir,
    });
    expect(completedOutput).toContain('completed');
  });

  it('/review report <id> shows full report with raw text', async () => {
    const output = await executeFindingCommand(['report', 'cmd-1'], { projectDir: dir });
    expect(output).toContain('Review Report');
    expect(output).toContain('Null dereference');
    expect(output).toContain('Critical: 1');
    expect(output).toContain('High: 1');
    expect(output).toContain('Lifecycle events');
    expect(output).toContain('created');
    expect(output).toContain('Raw report text');
    expect(output).toContain('Add null guard');
  });

  it('/review report <short-id> resolves via prefix match', async () => {
    const output = await executeFindingCommand(['report', 'cmd-1'], { projectDir: dir });
    expect(output).not.toContain('Report not found');
  });

  it('/review report <bad-id> returns not found', async () => {
    const output = await executeFindingCommand(['report', 'nonexistent-id'], { projectDir: dir });
    expect(output).toContain('Report not found');
  });

  it('/review reports with empty store returns no reports message', async () => {
    // Fresh dir with no reports
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'report-empty-'));
    try {
      const output = await executeFindingCommand(['reports'], { projectDir: emptyDir });
      expect(output).toContain('No reports found');
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('help text includes report commands', async () => {
    const output = await executeFindingCommand([], { projectDir: dir });
    expect(output).toContain('/review reports');
    expect(output).toContain('/review report <id>');
    expect(output).toContain('review-reports.jsonl');
  });
});

// ── Auto-completion: syncReportCompletion ─────────────────────────

describe('syncReportCompletion', () => {
  /** Helper: persist a report + its findings with a shared reportId. */
  async function setupReport(
    reportId: string,
    findings: { severity: string; file: string; line: number; title: string }[],
  ): Promise<void> {
    const reportText =
      findings.length > 0
        ? findings
            .map(
              (f, i) =>
                `${i === 0 ? `### ${f.severity.charAt(0).toUpperCase() + f.severity.slice(1)} (${findings.filter((x) => x.severity === f.severity).length})\n` : ''}${i + 1}. ${f.file}:${f.line} — ${f.title}`,
            )
            .join('\n')
        : '';

    // Persist report first, then findings (matching chimera-plugin order).
    await persistReviewReport(makePayload({ reviewText: reportText }), reportId, dir);
    await integrateFindings(makePayload({ reviewText: reportText }), dir, reportId);
  }

  it('completes report when all findings are resolved', async () => {
    await setupReport('auto-1', [
      { severity: 'critical', file: 'src/a.ts', line: 1, title: 'Bug one' },
      { severity: 'high', file: 'src/b.ts', line: 2, title: 'Bug two' },
    ]);

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'auto-1', limit: 100 });
    expect(findings).toHaveLength(2);

    // Resolve both
    for (const f of findings) {
      await findingStore.transition(
        f.id,
        'resolved',
        { id: 'operator', kind: 'operator' },
        { outcome: 'fixed' },
      );
    }

    const result = await syncReportCompletion('auto-1', dir, { id: 'operator', kind: 'operator' });
    expect(result.completed).toBe(true);
    expect(result.totalFindings).toBe(2);
    expect(result.remaining).toBe(0);

    const reportStore = new JsonlReportStore(dir);
    const report = await reportStore.get('auto-1');
    expect(report!.lifecycle).toBe('completed');
  });

  it('does NOT complete when some findings are still open (partial)', async () => {
    await setupReport('auto-2', [
      { severity: 'critical', file: 'src/a.ts', line: 1, title: 'Bug one' },
      { severity: 'high', file: 'src/b.ts', line: 2, title: 'Bug two' },
      { severity: 'medium', file: 'src/c.ts', line: 3, title: 'Bug three' },
    ]);

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'auto-2', limit: 100 });

    // Resolve only the first two; leave the third open
    await findingStore.transition(
      findings[0]!.id,
      'resolved',
      { id: 'op', kind: 'operator' },
      { outcome: 'fixed' },
    );
    await findingStore.transition(findings[1]!.id, 'ignored', { id: 'op', kind: 'operator' });

    const result = await syncReportCompletion('auto-2', dir, { id: 'operator', kind: 'operator' });
    expect(result.completed).toBe(false);
    expect(result.totalFindings).toBe(3);
    expect(result.remaining).toBe(1);

    const reportStore = new JsonlReportStore(dir);
    const report = await reportStore.get('auto-2');
    expect(report!.lifecycle).toBe('open');
  });

  it('completes when findings are a mix of resolved and ignored', async () => {
    await setupReport('auto-3', [
      { severity: 'high', file: 'src/a.ts', line: 1, title: 'Bug one' },
      { severity: 'medium', file: 'src/b.ts', line: 2, title: 'Bug two' },
    ]);

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'auto-3', limit: 100 });

    await findingStore.transition(
      findings[0]!.id,
      'resolved',
      { id: 'op', kind: 'operator' },
      { outcome: 'fixed' },
    );
    await findingStore.transition(findings[1]!.id, 'ignored', { id: 'op', kind: 'operator' });

    const result = await syncReportCompletion('auto-3', dir, { id: 'operator', kind: 'operator' });
    expect(result.completed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('reopens report when a finding is reopened from resolved', async () => {
    await setupReport('auto-4', [
      { severity: 'high', file: 'src/a.ts', line: 1, title: 'Bug one' },
    ]);

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'auto-4', limit: 100 });

    // Resolve → auto-complete
    await findingStore.transition(
      findings[0]!.id,
      'resolved',
      { id: 'op', kind: 'operator' },
      { outcome: 'fixed' },
    );
    await syncReportCompletion('auto-4', dir, { id: 'op', kind: 'operator' });

    const reportStore = new JsonlReportStore(dir);
    let report = await reportStore.get('auto-4');
    expect(report!.lifecycle).toBe('completed');

    // Reopen the finding → sync should reopen the report
    await findingStore.transition(findings[0]!.id, 'active', { id: 'op', kind: 'operator' });
    // syncReportCompletion doesn't auto-reopen (only auto-completes), but a reopened
    // report means the next completion check will find remaining > 0.
    // Verify the report can be manually reopened then re-completed.
    await reportStore.transition(
      'auto-4',
      'open',
      { id: 'op', kind: 'operator' },
      { reason: 'Finding reopened' },
    );

    const result = await syncReportCompletion('auto-4', dir, { id: 'op', kind: 'operator' });
    expect(result.completed).toBe(false);
    expect(result.remaining).toBe(1);

    report = await reportStore.get('auto-4');
    expect(report!.lifecycle).toBe('open');
  });

  it('auto-completes a successful all-clear report with zero findings', async () => {
    await persistReviewReport(
      makePayload({ reviewText: '## 🦂 Chimera Review — all clear ✅\n\nNo issues found.' }),
      'auto-5',
      dir,
    );

    const result = await syncReportCompletion('auto-5', dir, { id: 'operator', kind: 'operator' });
    expect(result.completed).toBe(false);
    expect(result.totalFindings).toBe(0);

    const reportStore = new JsonlReportStore(dir);
    const report = await reportStore.get('auto-5');
    expect(report!.lifecycle).toBe('completed');
  });

  it('returns not-found for unknown reportId', async () => {
    const result = await syncReportCompletion('nonexistent', dir, {
      id: 'operator',
      kind: 'operator',
    });
    expect(result.completed).toBe(false);
    expect(result.totalFindings).toBe(0);
  });

  it('is idempotent on already-completed report', async () => {
    await setupReport('auto-7', [
      { severity: 'high', file: 'src/a.ts', line: 1, title: 'Bug one' },
    ]);

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'auto-7', limit: 100 });
    await findingStore.transition(
      findings[0]!.id,
      'resolved',
      { id: 'op', kind: 'operator' },
      { outcome: 'fixed' },
    );

    // First call completes it
    await syncReportCompletion('auto-7', dir, { id: 'op', kind: 'operator' });
    // Second call is a no-op
    const result = await syncReportCompletion('auto-7', dir, { id: 'op', kind: 'operator' });
    expect(result.completed).toBe(false); // already completed, no new transition
  });
});

// ── Auto-completion via slash commands ────────────────────────────

describe('/review finding <id> resolve|ignore with auto-completion', () => {
  it('auto-completes report when last finding is resolved via command', async () => {
    const text = ['### Critical (1)', '1. [BUG] src/app.ts:42 — Null dereference'].join('\n');

    await persistReviewReport(makePayload({ reviewText: text }), 'cmd-auto-1', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'cmd-auto-1');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'cmd-auto-1', limit: 100 });
    expect(findings).toHaveLength(1);

    const output = await executeFindingCommand(['finding', findings[0]!.id, 'resolve'], {
      projectDir: dir,
    });

    expect(output).toContain('marked as **resolved**');
    expect(output).toContain('auto-completed');
    expect(output).toContain('cmd-auto-1');
  });

  it('shows remaining count when partial resolve via command', async () => {
    const text = [
      '### Critical (1)',
      '1. [BUG] src/a.ts:1 — Bug one',
      '',
      '### High (1)',
      '1. src/b.ts:2 — Bug two',
    ].join('\n');

    await persistReviewReport(makePayload({ reviewText: text }), 'cmd-auto-2', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'cmd-auto-2');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'cmd-auto-2', limit: 100 });
    expect(findings).toHaveLength(2);

    // Resolve only the first — report should stay open
    const output = await executeFindingCommand(['finding', findings[0]!.id, 'resolve'], {
      projectDir: dir,
    });

    expect(output).toContain('marked as **resolved**');
    expect(output).toContain('still open');

    const reportStore = new JsonlReportStore(dir);
    const report = await reportStore.get('cmd-auto-2');
    expect(report!.lifecycle).toBe('open');
  });

  it('handles finding not found gracefully', async () => {
    const output = await executeFindingCommand(['finding', 'nonexistent-id', 'resolve'], {
      projectDir: dir,
    });
    expect(output).toContain('Finding not found');
  });
});

// ── Auto-reopen: syncReportReopen ──────────────────────────────────

describe('syncReportReopen', () => {
  /** Helper: persist a report + its findings with a shared reportId. */
  async function setupReport(
    reportId: string,
    findings: { severity: string; file: string; line: number; title: string }[],
  ): Promise<void> {
    const reportText =
      findings.length > 0
        ? findings
            .map(
              (f, i) =>
                `${i === 0 ? `### ${f.severity.charAt(0).toUpperCase() + f.severity.slice(1)} (${findings.filter((x) => x.severity === f.severity).length})\n` : ''}${i + 1}. ${f.file}:${f.line} — ${f.title}`,
            )
            .join('\n')
        : '';

    await persistReviewReport(makePayload({ reviewText: reportText }), reportId, dir);
    await integrateFindings(makePayload({ reviewText: reportText }), dir, reportId);
  }

  it('reopens a completed report when a finding is reopened', async () => {
    await setupReport('reopen-1', [
      { severity: 'high', file: 'src/a.ts', line: 1, title: 'Bug one' },
    ]);

    const findingStore = new JsonlFindingStore(dir);
    const reportStore = new JsonlReportStore(dir);
    const findings = await findingStore.list({ reportId: 'reopen-1', limit: 100 });

    // Resolve → auto-complete
    await findingStore.transition(
      findings[0]!.id,
      'resolved',
      { id: 'op', kind: 'operator' },
      { outcome: 'fixed' },
    );
    await syncReportCompletion('reopen-1', dir, { id: 'op', kind: 'operator' });
    expect((await reportStore.get('reopen-1'))!.lifecycle).toBe('completed');

    // Reopen the finding → syncReportReopen should reopen the report
    await findingStore.transition(findings[0]!.id, 'active', { id: 'op', kind: 'operator' });
    const result = await syncReportReopen('reopen-1', dir, { id: 'op', kind: 'operator' });

    expect(result.reopened).toBe(true);
    expect(result.previousLifecycle).toBe('completed');

    const report = await reportStore.get('reopen-1');
    expect(report!.lifecycle).toBe('open');
  });

  it('reopens a skipped report when a finding is reopened', async () => {
    await setupReport('reopen-2', [
      { severity: 'high', file: 'src/a.ts', line: 1, title: 'Bug one' },
    ]);

    const reportStore = new JsonlReportStore(dir);

    // Skip the report directly from open (don't resolve findings first)
    await reportStore.transition(
      'reopen-2',
      'skipped',
      { id: 'op', kind: 'operator' },
      { reason: 'deferred' },
    );

    // Reopen the finding (it was never resolved, so this tests the reopen
    // on a finding that's already active — the key is the report was skipped)
    const result = await syncReportReopen('reopen-2', dir, { id: 'op', kind: 'operator' });

    expect(result.reopened).toBe(true);
    expect(result.previousLifecycle).toBe('skipped');
    expect((await reportStore.get('reopen-2'))!.lifecycle).toBe('open');
  });

  it('is a no-op when report is already open', async () => {
    await setupReport('reopen-3', [
      { severity: 'high', file: 'src/a.ts', line: 1, title: 'Bug one' },
    ]);

    const result = await syncReportReopen('reopen-3', dir, { id: 'op', kind: 'operator' });
    expect(result.reopened).toBe(false);
    expect(result.previousLifecycle).toBe('open');
  });

  it('is a no-op when report is actioned', async () => {
    await setupReport('reopen-4', [
      { severity: 'high', file: 'src/a.ts', line: 1, title: 'Bug one' },
    ]);

    const reportStore = new JsonlReportStore(dir);
    await reportStore.transition('reopen-4', 'actioned', { id: 'op', kind: 'operator' });

    const result = await syncReportReopen('reopen-4', dir, { id: 'op', kind: 'operator' });
    expect(result.reopened).toBe(false);
    expect(result.previousLifecycle).toBe('actioned');
  });

  it('returns not-found for unknown reportId', async () => {
    const result = await syncReportReopen('nonexistent', dir, { id: 'op', kind: 'operator' });
    expect(result.reopened).toBe(false);
    expect(result.previousLifecycle).toBe('not_found');
  });

  it('passes through a custom reason', async () => {
    await setupReport('reopen-6', [
      { severity: 'high', file: 'src/a.ts', line: 1, title: 'Bug one' },
    ]);

    const reportStore = new JsonlReportStore(dir);
    await reportStore.transition('reopen-6', 'completed', { id: 'op', kind: 'operator' });

    await syncReportReopen('reopen-6', dir, { id: 'op', kind: 'operator' }, 'Custom reopen reason');

    const events = await reportStore.getEvents('reopen-6');
    const reopenEvent = events.find((e) => e.eventType === 'reopened');
    expect(reopenEvent).toBeDefined();
    expect(reopenEvent!.reason).toBe('Custom reopen reason');
  });
});

// ── Auto-reopen via slash commands ────────────────────────────────

describe('/review finding <id> reopen with auto-reopen', () => {
  it('auto-reopens completed report when finding is reopened via command', async () => {
    const text = ['### Critical (1)', '1. [BUG] src/app.ts:42 — Null dereference'].join('\n');

    await persistReviewReport(makePayload({ reviewText: text }), 'cmd-reopen-1', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'cmd-reopen-1');

    const findingStore = new JsonlFindingStore(dir);
    const reportStore = new JsonlReportStore(dir);
    const findings = await findingStore.list({ reportId: 'cmd-reopen-1', limit: 100 });

    // Resolve → auto-complete
    const resolveOutput = await executeFindingCommand(['finding', findings[0]!.id, 'resolve'], {
      projectDir: dir,
    });
    expect(resolveOutput).toContain('auto-completed');
    expect((await reportStore.get('cmd-reopen-1'))!.lifecycle).toBe('completed');

    // Now reopen via command
    const reopenOutput = await executeFindingCommand(['finding', findings[0]!.id, 'reopen'], {
      projectDir: dir,
    });

    expect(reopenOutput).toContain('reopened as **active**');
    expect(reopenOutput).toContain('auto-reopened');
    expect(reopenOutput).toContain('cmd-reopen-1');

    const report = await reportStore.get('cmd-reopen-1');
    expect(report!.lifecycle).toBe('open');
  });

  it('reopen on already-open report shows no auto-reopen message', async () => {
    const text = ['### Critical (1)', '1. [BUG] src/app.ts:42 — Null dereference'].join('\n');

    await persistReviewReport(makePayload({ reviewText: text }), 'cmd-reopen-2', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'cmd-reopen-2');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'cmd-reopen-2', limit: 100 });

    // Report starts as open — reopening finding should not show auto-reopen
    const output = await executeFindingCommand(['finding', findings[0]!.id, 'reopen'], {
      projectDir: dir,
    });

    expect(output).toContain('reopened as **active**');
    expect(output).not.toContain('auto-reopened');
  });

  it('rejects --outcome on reopen', async () => {
    const text = ['### Critical (1)', '1. [BUG] src/app.ts:42 — Null dereference'].join('\n');

    await persistReviewReport(makePayload({ reviewText: text }), 'cmd-reopen-3', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'cmd-reopen-3');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'cmd-reopen-3', limit: 100 });

    const output = await executeFindingCommand(
      ['finding', findings[0]!.id, 'reopen', '--outcome', 'fixed'],
      { projectDir: dir },
    );
    expect(output).toContain('--outcome');
    expect(output).toContain('resolve');
  });
});

// ── /review report <id> complete|skip|action ──────────────────────

describe('/review report <id> complete|skip|action', () => {
  beforeEach(async () => {
    // Create a couple of reports for the tests.
    await persistReviewReport(
      makePayload({ reviewText: '### High (1)\n1. src/a.ts:1 — Bug' }),
      'rpt-1',
      dir,
    );
    await persistReviewReport(makePayload({ reviewText: '', status: 'failed' }), 'rpt-2', dir);
  });

  it('completes an open report', async () => {
    const output = await executeFindingCommand(['report', 'rpt-1', 'complete'], {
      projectDir: dir,
    });
    expect(output).toContain('completed');

    const store = new JsonlReportStore(dir);
    const report = await store.get('rpt-1');
    expect(report!.lifecycle).toBe('completed');
  });

  it('skips an open report', async () => {
    const output = await executeFindingCommand(['report', 'rpt-1', 'skip'], { projectDir: dir });
    expect(output).toContain('skipped');

    const store = new JsonlReportStore(dir);
    const report = await store.get('rpt-1');
    expect(report!.lifecycle).toBe('skipped');
  });

  it('actions an open report', async () => {
    const output = await executeFindingCommand(['report', 'rpt-1', 'action'], { projectDir: dir });
    expect(output).toContain('actioned');

    const store = new JsonlReportStore(dir);
    const report = await store.get('rpt-1');
    expect(report!.lifecycle).toBe('actioned');
  });

  it('passes --reason to the lifecycle event', async () => {
    await executeFindingCommand(
      ['report', 'rpt-2', 'skip', '--reason', 'Deferred to next sprint'],
      { projectDir: dir },
    );

    const store = new JsonlReportStore(dir);
    const events = await store.getEvents('rpt-2');
    const skipEvent = events.find((e) => e.eventType === 'skipped');
    expect(skipEvent).toBeDefined();
    expect(skipEvent!.reason).toBe('Deferred to next sprint');
  });

  it('completes an actioned report', async () => {
    const store = new JsonlReportStore(dir);
    await store.transition('rpt-1', 'actioned', { id: 'op', kind: 'operator' });

    const output = await executeFindingCommand(['report', 'rpt-1', 'complete'], {
      projectDir: dir,
    });
    expect(output).toContain('completed');
    expect((await store.get('rpt-1'))!.lifecycle).toBe('completed');
  });

  it('rejects invalid transition gracefully', async () => {
    const store = new JsonlReportStore(dir);
    await store.transition('rpt-1', 'completed', { id: 'op', kind: 'operator' });

    // completed → actioned is not allowed
    const output = await executeFindingCommand(['report', 'rpt-1', 'action'], { projectDir: dir });
    expect(output).toContain('Could not transition');
  });

  it('returns not-found for unknown report ID', async () => {
    const output = await executeFindingCommand(['report', 'nonexistent-id', 'complete'], {
      projectDir: dir,
    });
    expect(output).toContain('Report not found');
  });

  it('resolves short-ID prefix', async () => {
    const output = await executeFindingCommand(['report', 'rpt-1', 'complete'], {
      projectDir: dir,
    });
    expect(output).toContain('completed');
    expect(output).toContain('rpt-1');
  });

  it('help text includes report transition commands', async () => {
    const output = await executeFindingCommand([], { projectDir: dir });
    expect(output).toContain('/review report <id> complete');
    expect(output).toContain('/review report <id> skip');
    expect(output).toContain('/review report <id> action');
  });
});

// ── /review finding <id> triage + resolution persistence ──────────

describe('/review finding <id> triage', () => {
  it('triages an active finding', async () => {
    const text = '### High (1)\n1. src/app.ts:42 — Bug one';
    await persistReviewReport(makePayload({ reviewText: text }), 'tri-1', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'tri-1');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'tri-1', limit: 100 });

    const output = await executeFindingCommand(['finding', findings[0]!.id, 'triage'], {
      projectDir: dir,
    });

    expect(output).toContain('triaged');

    const updated = await findingStore.get(findings[0]!.id);
    expect(updated!.status).toBe('triaged');
  });

  it('triage with --reason stamps the lifecycle event', async () => {
    const text = '### High (1)\n1. src/app.ts:42 — Bug one';
    await persistReviewReport(makePayload({ reviewText: text }), 'tri-2', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'tri-2');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'tri-2', limit: 100 });

    await executeFindingCommand(
      ['finding', findings[0]!.id, 'triage', '--reason', 'Confirmed repro'],
      { projectDir: dir },
    );

    const events = await findingStore.getEvents(findings[0]!.id);
    const triageEvent = events.find((e) => e.eventType === 'triaged');
    expect(triageEvent).toBeDefined();
    expect(triageEvent!.reason).toBe('Confirmed repro');
  });

  it('rejects --outcome on triage', async () => {
    const text = '### High (1)\n1. src/app.ts:42 — Bug one';
    await persistReviewReport(makePayload({ reviewText: text }), 'tri-3', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'tri-3');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'tri-3', limit: 100 });

    const output = await executeFindingCommand(
      ['finding', findings[0]!.id, 'triage', '--outcome', 'fixed'],
      { projectDir: dir },
    );
    expect(output).toContain('--outcome');
    expect(output).toContain('resolve');
  });

  it('does NOT auto-complete the report after triage (triaged is non-terminal)', async () => {
    const text = '### High (1)\n1. src/app.ts:42 — Bug one';
    await persistReviewReport(makePayload({ reviewText: text }), 'tri-4', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'tri-4');

    const findingStore = new JsonlFindingStore(dir);
    const reportStore = new JsonlReportStore(dir);
    const findings = await findingStore.list({ reportId: 'tri-4', limit: 100 });

    const output = await executeFindingCommand(['finding', findings[0]!.id, 'triage'], {
      projectDir: dir,
    });

    expect(output).not.toContain('auto-completed');
    expect((await reportStore.get('tri-4'))!.lifecycle).toBe('open');
  });

  it('help text includes triage command', async () => {
    const output = await executeFindingCommand([], { projectDir: dir });
    expect(output).toContain('/review finding <id> triage');
  });
});

// ── Resolution field persistence (regression) ─────────────────────

describe('resolution field persists across reads', () => {
  it('resolution outcome survives store re-read after transition', async () => {
    const text = '### Critical (1)\n1. src/app.ts:42 — Null dereference';
    await persistReviewReport(makePayload({ reviewText: text }), 'res-1', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'res-1');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'res-1', limit: 100 });

    // Resolve with a specific outcome
    await findingStore.transition(
      findings[0]!.id,
      'resolved',
      { id: 'operator', kind: 'operator' },
      { outcome: 'wontfix', reason: 'Not reproducible' },
    );

    // Re-read from disk — resolution must survive
    const freshStore = new JsonlFindingStore(dir);
    const reread = await freshStore.get(findings[0]!.id);

    expect(reread!.status).toBe('resolved');
    expect(reread!.resolution).toBeDefined();
    expect(reread!.resolution!.outcome).toBe('wontfix');
    expect(reread!.resolution!.resolvedBy).toBe('operator');
    expect(reread!.resolution!.notes).toBe('Not reproducible');
  });

  it('resolution persists after resolve via slash command', async () => {
    const text = '### High (1)\n1. src/app.ts:42 — Bug';
    await persistReviewReport(makePayload({ reviewText: text }), 'res-2', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'res-2');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'res-2', limit: 100 });

    await executeFindingCommand(
      ['finding', findings[0]!.id, 'resolve', '--outcome', 'duplicate', '--reason', 'Same as #123'],
      { projectDir: dir },
    );

    // Re-read from a fresh store instance
    const freshStore = new JsonlFindingStore(dir);
    const reread = await freshStore.get(findings[0]!.id);

    expect(reread!.status).toBe('resolved');
    expect(reread!.resolution).toBeDefined();
    expect(reread!.resolution!.outcome).toBe('duplicate');
    expect(reread!.resolution!.notes).toBe('Same as #123');
  });
});

// ── /review finding <id> start ────────────────────────────────────

describe('/review finding <id> start', () => {
  it('starts a triaged finding (triaged → in_progress)', async () => {
    const text = '### High (1)\n1. src/app.ts:42 — Bug one';
    await persistReviewReport(makePayload({ reviewText: text }), 'start-1', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'start-1');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'start-1', limit: 100 });

    // Triage first, then start
    await findingStore.transition(findings[0]!.id, 'triaged', { id: 'operator', kind: 'operator' });

    const output = await executeFindingCommand(['finding', findings[0]!.id, 'start'], {
      projectDir: dir,
    });

    expect(output).toContain('in_progress');

    const updated = await findingStore.get(findings[0]!.id);
    expect(updated!.status).toBe('in_progress');
  });

  it('start with --reason stamps the lifecycle event', async () => {
    const text = '### High (1)\n1. src/app.ts:42 — Bug one';
    await persistReviewReport(makePayload({ reviewText: text }), 'start-2', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'start-2');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'start-2', limit: 100 });

    await findingStore.transition(findings[0]!.id, 'triaged', { id: 'operator', kind: 'operator' });

    await executeFindingCommand(
      ['finding', findings[0]!.id, 'start', '--reason', 'Picking up for fix'],
      { projectDir: dir },
    );

    const events = await findingStore.getEvents(findings[0]!.id);
    const startEvent = events.find((e) => e.eventType === 'started');
    expect(startEvent).toBeDefined();
    expect(startEvent!.reason).toBe('Picking up for fix');
  });

  it('rejects --outcome on start', async () => {
    const text = '### High (1)\n1. src/app.ts:42 — Bug one';
    await persistReviewReport(makePayload({ reviewText: text }), 'start-3', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'start-3');

    const findingStore = new JsonlFindingStore(dir);
    const findings = await findingStore.list({ reportId: 'start-3', limit: 100 });

    const output = await executeFindingCommand(
      ['finding', findings[0]!.id, 'start', '--outcome', 'fixed'],
      { projectDir: dir },
    );
    expect(output).toContain('--outcome');
    expect(output).toContain('resolve');
  });

  it('does NOT auto-complete the report after start (in_progress is non-terminal)', async () => {
    const text = '### High (1)\n1. src/app.ts:42 — Bug one';
    await persistReviewReport(makePayload({ reviewText: text }), 'start-4', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'start-4');

    const findingStore = new JsonlFindingStore(dir);
    const reportStore = new JsonlReportStore(dir);
    const findings = await findingStore.list({ reportId: 'start-4', limit: 100 });

    await findingStore.transition(findings[0]!.id, 'triaged', { id: 'operator', kind: 'operator' });

    const output = await executeFindingCommand(['finding', findings[0]!.id, 'start'], {
      projectDir: dir,
    });

    expect(output).not.toContain('auto-completed');
    expect((await reportStore.get('start-4'))!.lifecycle).toBe('open');
  });

  it('help text includes start command', async () => {
    const output = await executeFindingCommand([], { projectDir: dir });
    expect(output).toContain('/review finding <id> start');
  });

  it('full lifecycle: triage → start → resolve auto-completes report', async () => {
    const text = '### Critical (1)\n1. src/app.ts:42 — Null dereference';
    await persistReviewReport(makePayload({ reviewText: text }), 'start-5', dir);
    await integrateFindings(makePayload({ reviewText: text }), dir, 'start-5');

    const findingStore = new JsonlFindingStore(dir);
    const reportStore = new JsonlReportStore(dir);
    const findings = await findingStore.list({ reportId: 'start-5', limit: 100 });
    const fid = findings[0]!.id;

    // Full lifecycle: active → triaged → in_progress → resolved
    await executeFindingCommand(['finding', fid, 'triage'], { projectDir: dir });
    expect((await findingStore.get(fid))!.status).toBe('triaged');

    await executeFindingCommand(['finding', fid, 'start'], { projectDir: dir });
    expect((await findingStore.get(fid))!.status).toBe('in_progress');

    const output = await executeFindingCommand(['finding', fid, 'resolve'], { projectDir: dir });
    expect(output).toContain('auto-completed');
    expect((await findingStore.get(fid))!.status).toBe('resolved');
    expect((await reportStore.get('start-5'))!.lifecycle).toBe('completed');
  });
});

// ── /review report <id> note ──────────────────────────────────────

describe('/review report <id> note', () => {
  beforeEach(async () => {
    await persistReviewReport(
      makePayload({ reviewText: '### High (1)\n1. src/a.ts:1 — Bug' }),
      'note-1',
      dir,
    );
  });

  it('adds a note without changing lifecycle status', async () => {
    const output = await executeFindingCommand(
      ['report', 'note-1', 'note', 'Reviewing with the team tomorrow'],
      { projectDir: dir },
    );
    expect(output).toContain('Note added');

    const store = new JsonlReportStore(dir);
    const report = await store.get('note-1');
    expect(report!.lifecycle).toBe('open');

    const events = await store.getEvents('note-1');
    const noteEvent = events.find((e) => e.eventType === 'note_added');
    expect(noteEvent).toBeDefined();
    expect(noteEvent!.reason).toBe('Reviewing with the team tomorrow');
    expect(noteEvent!.fromLifecycle).toBe('open');
    expect(noteEvent!.toLifecycle).toBe('open');
  });

  it('joins multi-word notes', async () => {
    const output = await executeFindingCommand(
      ['report', 'note-1', 'note', 'This', 'is', 'a', 'multi-word', 'note'],
      { projectDir: dir },
    );
    expect(output).toContain('Note added');

    const store = new JsonlReportStore(dir);
    const events = await store.getEvents('note-1');
    const noteEvent = events.find((e) => e.eventType === 'note_added');
    expect(noteEvent!.reason).toBe('This is a multi-word note');
  });

  it('returns usage message for empty note', async () => {
    const output = await executeFindingCommand(['report', 'note-1', 'note'], { projectDir: dir });
    expect(output).toContain('Usage: /review report <id> note');
  });

  it('returns usage message for whitespace-only note', async () => {
    const output = await executeFindingCommand(['report', 'note-1', 'note', '   '], {
      projectDir: dir,
    });
    expect(output).toContain('Usage: /review report <id> note');
  });

  it('returns not-found for unknown report ID', async () => {
    const output = await executeFindingCommand(
      ['report', 'nonexistent-id', 'note', 'Some message'],
      { projectDir: dir },
    );
    expect(output).toContain('Report not found');
  });

  it('note shows in /review report <id> lifecycle events', async () => {
    await executeFindingCommand(['report', 'note-1', 'note', 'Deferred to next release'], {
      projectDir: dir,
    });

    const output = await executeFindingCommand(['report', 'note-1'], { projectDir: dir });
    expect(output).toContain('note_added');
    expect(output).toContain('Deferred to next release');
  });

  it('help text includes note command', async () => {
    const output = await executeFindingCommand([], { projectDir: dir });
    expect(output).toContain('/review report <id> note');
  });
});
