import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireReviewFindingsToChronicle } from '../src/review-adapter.js';
import type { ChronicleEventSink } from '../src/sink.js';
import type { ChronicleEventInput } from '../src/types.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a valid chimera.review_complete payload for testing. */
function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    bundle: {
      config: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        maxFiles: 15,
        autoFix: 'off',
        cascadeOn: 'off',
        maxCascadeDepth: 2,
        enabled: true,
      },
      cwd: '/test/project',
      files: [{ path: 'src/auth.ts', status: 'modified' }],
      fileProvenance: [{ path: 'src/auth.ts', agentId: 'test-agent' }],
      kanbanCard: { id: 'task-42', title: 'Fix auth', description: '', successCriteria: [] },
    },
    reviewText: `### Critical (1)
1. [BUG] src/auth.ts:42 — Null dereference on user.name
   → Add a guard: if (!user) throw new NotFoundError()

### High (2)
1. [BUG] src/api.ts:10 — Missing input validation on user input
   → Validate request body before processing
2. [SECURITY] src/config.ts:5 — Hardcoded secret key
   → Move to environment variable

### Medium (1)
1. [CODE] src/utils.ts:100 — Unused helper function
   → Remove or mark as deprecated

Duration: 12s`,
    status: 'success',
    cwd: '/test/project',
    sessionId: 'sess-123',
    ...overrides,
  };
}

describe('wireReviewFindingsToChronicle', () => {
  let appended: ChronicleEventInput[];
  let journal: {
    append: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    stats: ReturnType<typeof vi.fn>;
  };
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    appended = [];
    journal = {
      append: vi.fn((input: ChronicleEventInput) => {
        appended.push(input);
        return Promise.resolve({
          ...input,
          schemaVersion: 1,
          eventId: 'evt-1',
          observedAt: '',
          persistedAt: '',
          sequence: 0,
          previousHash: '',
          hash: '',
        });
      }),
      flush: vi.fn().mockResolvedValue(undefined),
      stats: vi.fn().mockReturnValue({ pendingEvents: 0, rejectedEvents: 0 }),
    };
  });

  afterEach(() => {
    unsubscribe?.();
  });

  /** Wire the adapter and return a function to trigger the handler. */
  function wireAndCapture(): (payload: Record<string, unknown>) => void {
    let handler: ((event: unknown, payload: unknown) => void) | undefined;
    const events = {
      onPattern: vi.fn((_pattern: string, h: (event: unknown, payload: unknown) => void) => {
        handler = h;
        unsubscribe = vi.fn();
        return unsubscribe;
      }),
    };
    wireReviewFindingsToChronicle({
      events,
      // `vi.fn()` widens the mock's call signature, so the object does not
      // structurally satisfy the sink; the bodies above return the right shape.
      journal: journal as unknown as ChronicleEventSink,
      context: {
        scope: { installationId: 'inst-1', machineId: 'm-1', projectId: 'proj-1' },
        correlation: { traceId: 'trace-1', spanId: 'span-1' },
      },
      onPersistError: vi.fn(),
    });
    return (payload: Record<string, unknown>) => {
      handler?.('chimera.review_complete', payload);
    };
  }

  // ── Normal review ─────────────────────────────────────────────

  it('emits one finding event per parseable item and one summary', () => {
    const trigger = wireAndCapture();
    trigger(makePayload());

    // 4 findings (Critical:1, High:2, Medium:1) + 1 summary = 5 events
    expect(appended.length).toBe(5);

    // Check finding events
    const findings = appended.filter((e) => e.eventType.startsWith('finding.'));
    expect(findings).toHaveLength(4);

    const critical = findings.find((e) => e.eventType === 'finding.critical');
    expect(critical).toBeDefined();
    expect(critical!.attributes).toMatchObject({
      severity: 'critical',
      file: 'src/auth.ts',
      line: 42,
      source: 'chimera',
    });
    expect(critical!.resource).toMatchObject({ kind: 'file', path: 'src/auth.ts', lineStart: 42 });
    expect(critical!.scope).toMatchObject({
      sessionId: 'sess-123',
      agentId: 'test-agent',
      taskId: 'task-42',
    });

    const highFinding = findings.find(
      (e) =>
        e.eventType === 'finding.high' &&
        (e.attributes as Record<string, unknown>).file === 'src/api.ts',
    );
    expect(highFinding).toBeDefined();
    expect(highFinding!.attributes).toMatchObject({ line: 10, file: 'src/api.ts' });

    // Check summary event
    const summary = appended.find((e) => e.eventType === 'review.completed');
    expect(summary).toBeDefined();
    expect(summary!.attributes).toMatchObject({
      totalFindings: 4,
      severityCounts: { critical: 1, high: 2, medium: 1, low: 0 },
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      cascadeDepth: 0,
    });
  });

  // ── Empty review text ─────────────────────────────────────────

  it('emits no events for empty review text', () => {
    const trigger = wireAndCapture();
    trigger(makePayload({ reviewText: '' }));

    expect(appended).toHaveLength(0);
  });

  it('emits no events for whitespace-only review text', () => {
    const trigger = wireAndCapture();
    trigger(makePayload({ reviewText: '   \n  \n  ' }));

    expect(appended).toHaveLength(0);
  });

  // ── Failed review ─────────────────────────────────────────────

  it('emits no events when status is not success', () => {
    const trigger = wireAndCapture();
    trigger(makePayload({ status: 'failed' }));

    expect(appended).toHaveLength(0);
  });

  it('emits no events when status is undefined', () => {
    const trigger = wireAndCapture();
    trigger(makePayload({ status: undefined }));

    expect(appended).toHaveLength(0);
  });

  // ── Null / undefined payload ──────────────────────────────────

  it('tolerates null payload gracefully', () => {
    const trigger = wireAndCapture();
    trigger(null as unknown as Record<string, unknown>);

    expect(appended).toHaveLength(0);
  });

  it('tolerates undefined payload gracefully', () => {
    const trigger = wireAndCapture();
    trigger(undefined as unknown as Record<string, unknown>);

    expect(appended).toHaveLength(0);
  });

  it('tolerates payload without reviewText', () => {
    const trigger = wireAndCapture();
    trigger({ status: 'success', bundle: { config: {} } });

    expect(appended).toHaveLength(0);
  });

  // ── Unparseable / malformed findings ──────────────────────────

  it('skips unparseable items but still emits parseable ones', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### Critical (2)
1. [BUG] src/auth.ts:42 — Null dereference
   → Add guard
garbage line that doesn't match any pattern
2. [BUG] valid.ts:10 — Second finding
blah blah nonsense

### High (1)
1. [BUG] src/api.ts:5 — Valid high finding`,
      }),
    );

    // 3 parseable findings (critical:2 from items 1 and 2, high:1) + 1 summary = 4 events
    expect(appended.length).toBe(4);

    const findings = appended.filter((e) => e.eventType.startsWith('finding.'));
    expect(findings).toHaveLength(3);

    // The garbage lines should have been ignored but the valid items still parsed
    const criticalFindings = findings.filter((e) => e.eventType === 'finding.critical');
    expect(criticalFindings).toHaveLength(2);
    expect(criticalFindings[0]!.attributes).toMatchObject({ file: 'src/auth.ts', line: 42 });
    expect(criticalFindings[1]!.attributes).toMatchObject({ file: 'valid.ts', line: 10 });
  });

  // ── No file:line references ───────────────────────────────────

  it('handles findings without file:line references', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### Low (1)
1. [STYLE] — General code style inconsistency noticed`,
      }),
    );

    // 1 finding + 1 summary = 2 events
    expect(appended.length).toBe(2);
    const finding = appended.find((e) => e.eventType === 'finding.low');
    expect(finding).toBeDefined();
    // No resource when there's no file reference
    expect(finding!.resource).toBeUndefined();
  });

  // ── Path reference fallback ───────────────────────────────────

  it('extracts file from path patterns with space before description', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### High (1)
1. [BUG] src/helper.ts:25 - Potential overflow in calculation`,
      }),
    );

    const finding = appended.find((e) => e.eventType.startsWith('finding.'));
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({ file: 'src/helper.ts', line: 25 });
  });

  // ── Multiple severity sections ────────────────────────────────

  it('handles all severity levels', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### critical (1)
1. [BUG] — Critical issue

### HIGH (1)
1. [BUG] src/auth.ts:5 - High issue

### Medium (1)
1. [BUG] — Medium issue

### LOW (1)
1. [BUG] - Low issue`,
      }),
    );

    const eventTypes = appended
      .filter((e) => e.eventType.startsWith('finding.'))
      .map((e) => e.eventType)
      .sort();
    expect(eventTypes).toEqual([
      'finding.critical',
      'finding.high',
      'finding.low',
      'finding.medium',
    ]);
  });

  // ── Cascade depth propagation ─────────────────────────────────

  it('propagates cascade depth into finding attributes', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        bundle: {
          config: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            maxFiles: 15,
            autoFix: 'off',
            cascadeOn: 'high',
            maxCascadeDepth: 2,
            enabled: true,
          },
          cwd: '/test/project',
          files: [],
          cascadeDepth: 2,
          maxCascadeDepth: 2,
        },
        reviewText: `### Critical (1)\n1. [BUG] x.ts:1 — Finding at depth 2`,
      }),
    );

    const finding = appended.find((e) => e.eventType.startsWith('finding.'));
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({ cascadeDepth: 2 });
  });

  // ── No agentId in fileProvenance ──────────────────────────────

  it('handles missing fileProvenance gracefully', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        bundle: {
          config: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            maxFiles: 15,
            autoFix: 'off',
            cascadeOn: 'off',
            maxCascadeDepth: 2,
            enabled: true,
          },
          cwd: '/test/project',
          files: [{ path: 'src/auth.ts', status: 'modified' }],
          fileProvenance: [],
        },
        reviewText: `### High (1)\n1. [BUG] x.ts:5 — Missing check`,
      }),
    );

    const finding = appended.find((e) => e.eventType.startsWith('finding.'));
    expect(finding).toBeDefined();
    // agentId should be absent from scope since fileProvenance is empty
    expect(finding!.scope).not.toHaveProperty('agentId');
  });

  // ── OnPersistError called on journal failure ──────────────────

  it('calls onPersistError when journal.append rejects', async () => {
    const onPersistError = vi.fn();
    const failJournal = {
      append: vi.fn().mockRejectedValue(new Error('disk full')),
      flush: vi.fn(),
      stats: vi.fn(),
    };
    let handler: ((event: unknown, payload: unknown) => void) | undefined;
    const events = {
      onPattern: vi.fn((_pattern: string, h: (event: unknown, payload: unknown) => void) => {
        handler = h;
        unsubscribe = vi.fn();
        return unsubscribe;
      }),
    };
    wireReviewFindingsToChronicle({
      events,
      journal: failJournal,
      context: {
        scope: { installationId: 'i', machineId: 'm' },
        correlation: { traceId: 't', spanId: 's' },
      },
      onPersistError,
    });
    handler!('chimera.review_complete', makePayload());

    // Give the rejected promise time to call onPersistError
    await new Promise((r) => setTimeout(r, 10));
    expect(onPersistError).toHaveBeenCalled();
  });

  // ── Canonical parser parity ───────────────────────────────────

  it('parses items without — separator via PATH_REF fallback', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### High (1)
1. [BUG] src/helper.ts:25 error text without separator`,
      }),
    );

    const finding = appended.find((e) => e.eventType.startsWith('finding.'));
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({ file: 'src/helper.ts', line: 25 });
    expect((finding!.attributes as Record<string, unknown>).title).toContain('separator');
  });

  it('handles file paths containing hyphens', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### Critical (1)
1. [BUG] src/my-file.ts:5 — Null deref in edge case`,
      }),
    );

    const finding = appended.find((e) => e.eventType === 'finding.critical');
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({ file: 'src/my-file.ts', line: 5 });
  });

  it('handles descriptions containing colons', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### Medium (1)
1. [BUG] src/file.ts:10 — error: something failed`,
      }),
    );

    const finding = appended.find((e) => e.eventType.startsWith('finding.'));
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({ file: 'src/file.ts', line: 10 });
    expect((finding!.attributes as Record<string, unknown>).title).toContain('error');
  });

  it('handles item with file:line and no trailing description separator', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### Low (1)
1. [BUG] src/file.ts:15 A description without dash`,
      }),
    );

    const finding = appended.find((e) => e.eventType.startsWith('finding.'));
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({ file: 'src/file.ts', line: 15 });
  });

  it('handles item with file path but no line number', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### High (1)
1. [BUG] src/file.ts — Description without line number`,
      }),
    );

    const finding = appended.find((e) => e.eventType.startsWith('finding.'));
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({ file: 'src/file.ts' });
    expect((finding!.attributes as Record<string, unknown>).line).toBeUndefined();
  });

  // ── Backticked citations (canonical documented format) ───────────
  //
  // `packages/core/instructions/llm/chimera-review.md` tells the reviewer to
  // cite findings as `1. [BUG] `path/file.ts:42` — description`. The canonical
  // markdown parser (review-finding-parser.ts) unwraps that backtick pair;
  // this adapter deliberately does not import it, so it must do the same.
  // Regression: the backticks landed in `file`/`resource.path` and the `:42`
  // was never parsed into a line number, so a "findings in file X" Chronicle
  // query could not match and the resource id was keyed on garbage.
  it('extracts file path and line from a backticked citation', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### Critical (1)
1. [BUG] \`packages/core/src/foo.ts:42\` — Null deref on user.name`,
      }),
    );

    const finding = appended.find((e) => e.eventType === 'finding.critical');
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({
      file: 'packages/core/src/foo.ts',
      line: 42,
    });
    expect(finding!.resource).toMatchObject({
      kind: 'file',
      path: 'packages/core/src/foo.ts',
      lineStart: 42,
    });
    // The title must be the real description, not the citation text.
    expect((finding!.attributes as Record<string, unknown>).title).toBe('Null deref on user.name');
  });

  it('control: un-backticked citation of the same finding parses identically', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### Critical (1)
1. [BUG] packages/core/src/foo.ts:42 — Null deref on user.name`,
      }),
    );

    const finding = appended.find((e) => e.eventType === 'finding.critical');
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({
      file: 'packages/core/src/foo.ts',
      line: 42,
    });
    expect(finding!.resource?.path).toBe('packages/core/src/foo.ts');
  });

  it('preserves backticks that are not a citation', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        reviewText: `### Medium (1)
1. [CODE] src/file.ts:10 — the \`notACitation\` token stays verbatim`,
      }),
    );

    const finding = appended.find((e) => e.eventType.startsWith('finding.'));
    expect(finding).toBeDefined();
    expect(finding!.attributes).toMatchObject({ file: 'src/file.ts', line: 10 });
    // A non-citation backtick construct must survive into the title/description.
    const title = String((finding!.attributes as Record<string, unknown>).title);
    expect(title).toContain('`notACitation`');
  });

  it('consumes pre-verified parsedReport, drops failed verifications, and records token usage & scope telemetry on review.completed', () => {
    const trigger = wireAndCapture();
    trigger(
      makePayload({
        bundle: {
          config: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            maxFiles: 15,
            autoFix: 'off',
            cascadeOn: 'off',
            maxCascadeDepth: 2,
            enabled: true,
          },
          cwd: '/test/project',
          headSha: 'deadbeef1234',
          skippedFiles: [{ path: 'bun.lock', reason: 'ignored_non_source' }],
          files: [{ path: 'src/auth.ts', status: 'modified', isIncrementalDelta: true }],
        },
        reviewText: '## 🦂 Chimera Review — all clear ✅',
        parsedReport: {
          unparseableCount: 0,
          findings: [
            {
              id: 'f-verified',
              fingerprint: 'fp-v',
              severity: 'high',
              source: 'chimera',
              location: { file: 'src/auth.ts', line: 12 },
              title: 'Verified bug',
              description: 'Real defect',
              verification: { status: 'verified', reason: 'anchor_found' },
              createdAt: new Date().toISOString(),
              status: 'active',
              originReport: {
                reportId: 'r-1',
                sessionId: 'sess-123',
                agentId: 'chimera-review',
                reviewerModel: 'claude-sonnet-4-6',
              },
            },
            {
              id: 'f-dropped',
              fingerprint: 'fp-d',
              severity: 'critical',
              source: 'chimera',
              location: { file: 'src/ghost.ts', line: 99 },
              title: 'Hallucinated citation',
              description: 'Should be dropped',
              verification: { status: 'failed', reason: 'file_missing' },
              createdAt: new Date().toISOString(),
              status: 'active',
              originReport: {
                reportId: 'r-1',
                sessionId: 'sess-123',
                agentId: 'chimera-review',
                reviewerModel: 'claude-sonnet-4-6',
              },
            },
          ],
        },
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 900,
          totalTokens: 1500,
          costUsd: 0.0042,
          iterations: 2,
          toolCalls: 1,
        },
      }),
    );

    const findingEvents = appended.filter((e) => e.eventType.startsWith('finding.'));
    expect(findingEvents).toHaveLength(1);
    expect(findingEvents[0]!.eventType).toBe('finding.high');

    const summary = appended.find((e) => e.eventType === 'review.completed');
    expect(summary).toBeDefined();
    expect(summary!.attributes).toMatchObject({
      totalFindings: 1,
      headSha: 'deadbeef1234',
      skippedFileCount: 1,
      isIncremental: true,
      usage: expect.objectContaining({
        totalTokens: 1500,
        cacheReadTokens: 900,
        costUsd: 0.0042,
      }),
    });
  });
});
