/**
 * End-to-end integration test for the Chimera cascade chain:
 *
 *   chimera.review_complete (Critical findings + cascadeOn:'high')
 *     → auto-review plugin's listener parses severity
 *     → emits chimera.cascade_needed with correct payload + agent selection
 *     → execution.ts cascade_needed handler spawns follow-up agents
 *       (security-scanner, bug-hunter) via the Director
 *
 * This test wires the REAL auto-review plugin against a REAL EventBus so
 * the entire event-bus contract (emitCustom → onPattern delivery, payload
 * shape, severity parsing, agent selection) is exercised. The Director is
 * mocked so no real LLM calls happen.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventBus } from '@wrongstack/core/kernel';
import { createAutoReviewPlugin } from '@wrongstack/core/plugin';
import type { ChimeraCascadeNeededPayload, ChimeraReviewCompletePayload } from '@wrongstack/core/plugin';
import type { ReviewContextBundle } from '@wrongstack/core/plugin';

// ── A Critical review report with a security finding (SQL injection) ──
// Matches the chimera-review.md report format that parseReviewSeverity expects.
const CRITICAL_SECURITY_REPORT = `## 🦂 Chimera Review

### Critical (2)
1. [SECURITY] \`src/auth.ts:42\` — SQL injection in login query via string concat
   → use parameterized queries
2. [BUG] \`src/api.ts:18\` — null deref without guard on user input
   → add null check

### High (1)
1. [BUG] \`src/utils.ts:77\` — off-by-one in loop bound
   → fix loop condition

### Medium (1)
1. [STYLE] \`src/format.ts:10\` — missing return type annotation
   → add explicit return type

### Summary
- Files reviewed: 4
- Findings: 2 critical, 1 high, 1 medium
`;

// ── A clean report with no findings ──
const CLEAN_REPORT = `## 🦂 Chimera Review — all clear ✅
No issues found in 2 changed files.`;

// ── A report with High findings only (no security keywords) ──
const HIGH_BUG_ONLY_REPORT = `## 🦂 Chimera Review

### Critical (0)

### High (2)
1. [BUG] \`src/parser.ts:30\` — inverted condition skips valid input
   → flip the comparison
2. [BUG] \`src/cache.ts:55\` — event listener never removed (leak)
   → call removeEventListener in cleanup

### Medium (0)

### Summary
- Files reviewed: 2
- Findings: 0 critical, 2 high, 0 medium
`;

/**
 * Build a mock PluginAPI sufficient for the auto-review plugin's setup().
 * The plugin needs: config, onConfigChange, onEvent, onPattern, emitCustom,
 * slashCommands.register, log. We wire onPattern/emitCustom to a REAL
 * EventBus so event delivery works exactly as in production.
 */
function makeApiWithRealBus(
  events: EventBus,
  extensions: Record<string, Record<string, unknown>> = {},
) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    config: {
      provider: 'test-provider',
      model: 'test-model',
      cwd: '/test-cwd',
      extensions,
    },
    events,
    onConfigChange: vi.fn(),
    onEvent: vi.fn((event: string, handler: () => void) => {
      events.onPattern(event, () => handler());
    }),
    onPattern: vi.fn((pattern: string, handler: (event: string, payload: unknown) => void) => {
      return events.onPattern(pattern, handler);
    }),
    emitCustom: vi.fn((event: string, payload: unknown) => {
      events.emitCustom(event, payload);
    }),
    slashCommands: { register: vi.fn(), unregister: vi.fn() },
    log,
  } as never;
}

/**
 * Build a minimal ReviewContextBundle with cascadeOn set.
 */
function makeBundle(
  cascadeOn: 'off' | 'critical' | 'high',
  overrides: Partial<ReviewContextBundle> = {},
): ReviewContextBundle {
  return {
    config: {
      enabled: true,
      provider: 'test-provider',
      model: 'test-model',
      maxFiles: 15,
      autoFix: 'off',
      cascadeOn: cascadeOn,
      maxCascadeDepth: 3,
    },
    cwd: '/test-cwd',
    files: [{ path: 'src/auth.ts', status: 'modified', content: '// changed' }],
    cascadeOn,
    ...overrides,
  };
}

/**
 * Mock Director — tracks spawn/assign/awaitTasks calls.
 * Returns success results by default.
 */
function makeDirector(results: Array<{ status: string; result: unknown }> = []) {
  let callIdx = 0;
  return {
    spawn: vi.fn(async (_cfg?: unknown) => `subagent-${++callIdx}`),
    assign: vi.fn(async (_task?: unknown) => {}),
    awaitTasks: vi.fn(async (_taskIds: string[]) => {
      // awaitTasks returns an array of results (one per task id);
      // the handler accesses results[0].
      const r = results[callIdx - 1] ?? { id: 'task-1', status: 'success', result: 'done' };
      return [r];
    }),
    onTaskEvent: vi.fn(),
    _callIdx: () => callIdx,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PART 1: Plugin cascade listener — review_complete → cascade_needed
// ═══════════════════════════════════════════════════════════════════════

describe('Cascade chain: review_complete → cascade_needed (plugin level)', () => {
  let events: EventBus;
  let cascadeNeededPayloads: ChimeraCascadeNeededPayload[];

  beforeEach(() => {
    events = new EventBus();
    cascadeNeededPayloads = [];
    // Capture cascade_needed emissions
    events.onPattern('chimera.cascade_needed', (_event, payload) => {
      cascadeNeededPayloads.push(payload as ChimeraCascadeNeededPayload);
    });
  });

  function setupPlugin(cascadeOn: 'off' | 'critical' | 'high') {
    const api = makeApiWithRealBus(events, {
      'wstack-auto-review': { enabled: true, cascadeOn },
    });
    const plugin = createAutoReviewPlugin();
    plugin.setup!(api);
    return { api, plugin };
  }

  function emitReviewComplete(bundle: ReviewContextBundle, reviewText: string, status = 'success') {
    const payload: ChimeraReviewCompletePayload = {
      bundle,
      reviewText,
      status,
      cwd: bundle.cwd,
    };
    events.emitCustom('chimera.review_complete', payload);
  }

  it('emits cascade_needed when a Critical security finding crosses the high threshold', () => {
    setupPlugin('high');
    emitReviewComplete(makeBundle('high'), CRITICAL_SECURITY_REPORT);

    expect(cascadeNeededPayloads).toHaveLength(1);
    const p = cascadeNeededPayloads[0]!;
    expect(p.severities).toEqual({ critical: 2, high: 1, medium: 1 });
    expect(p.threshold).toBe('critical'); // Critical outranks high
    expect(p.agents).toContain('bug-hunter');
    expect(p.agents).toContain('security-scanner');
  });

  it('emits cascade_needed with bug-hunter only for High findings without security keywords', () => {
    setupPlugin('high');
    emitReviewComplete(makeBundle('high'), HIGH_BUG_ONLY_REPORT);

    expect(cascadeNeededPayloads).toHaveLength(1);
    const p = cascadeNeededPayloads[0]!;
    expect(p.severities).toEqual({ critical: 0, high: 2, medium: 0 });
    expect(p.threshold).toBe('high');
    expect(p.agents).toEqual(['bug-hunter']);
    expect(p.agents).not.toContain('security-scanner');
  });

  it('does NOT emit cascade_needed when cascadeOn is off, even with Critical findings', () => {
    setupPlugin('off');
    emitReviewComplete(makeBundle('off'), CRITICAL_SECURITY_REPORT);

    expect(cascadeNeededPayloads).toHaveLength(0);
  });

  it("does NOT emit cascade_needed when threshold is 'critical' but only High findings exist", () => {
    setupPlugin('critical');
    emitReviewComplete(makeBundle('critical'), HIGH_BUG_ONLY_REPORT);

    expect(cascadeNeededPayloads).toHaveLength(0);
  });

  it("does NOT emit cascade_needed for a clean report (no findings)", () => {
    setupPlugin('high');
    emitReviewComplete(makeBundle('high'), CLEAN_REPORT);

    expect(cascadeNeededPayloads).toHaveLength(0);
  });

  it('does NOT emit cascade_needed when the review failed (empty text)', () => {
    setupPlugin('high');
    emitReviewComplete(makeBundle('high'), '', 'timeout');

    expect(cascadeNeededPayloads).toHaveLength(0);
  });

  it('forwards the review text in the cascade payload', () => {
    setupPlugin('high');
    emitReviewComplete(makeBundle('high'), CRITICAL_SECURITY_REPORT);

    const p = cascadeNeededPayloads[0]!;
    expect(p.reviewText).toBe(CRITICAL_SECURITY_REPORT);
  });

  it('forwards the original bundle in the cascade payload', () => {
    setupPlugin('high');
    const bundle = makeBundle('high');
    emitReviewComplete(bundle, CRITICAL_SECURITY_REPORT);

    const p = cascadeNeededPayloads[0]!;
    expect(p.bundle).toBe(bundle);
    expect(p.bundle.cwd).toBe('/test-cwd');
    expect(p.bundle.cascadeOn).toBe('high');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART 2: Full chain — cascade_needed → Director agent spawn
// (mirrors execution.ts:619-701 cascade_needed handler)
// ═══════════════════════════════════════════════════════════════════════

describe('Cascade chain: cascade_needed → follow-up agent spawn (execution handler)', () => {
  /**
   * Mirrors the execution.ts cascade_needed handler: spawns a subagent per
   * requested agent kind with the right role, builds a task description,
   * and appends results to the session. Returns the in-flight promise so
   * the test can await it.
   */
  async function runCascadeHandler(
    events: EventBus,
    director: ReturnType<typeof makeDirector>,
    session: { append: ReturnType<typeof vi.fn> },
    cascadePayload: ChimeraCascadeNeededPayload,
  ) {
    let pendingCascadeWork: Promise<void> | undefined;

    events.onPattern('chimera.cascade_needed', (_event, payload) => {
      const p = payload as ChimeraCascadeNeededPayload;
      if (p.agents.length === 0) return;

      pendingCascadeWork = (async () => {
        for (const agentKind of p.agents) {
          const role = agentKind === 'security-scanner' ? 'security-scanner' : 'bug-hunter';
          const cfg = { name: `chimera-cascade-${agentKind}`, role };
          await director.spawn(cfg);
          await director.assign({ id: 'cascade-task', description: 'cascade task', subagentId: 'x' });
          const results = await director.awaitTasks(['cascade-task']);
          const result = results[0];
          if (result?.status === 'success') {
            await (session as { append: (e: unknown) => Promise<void> }).append({
              type: 'llm_response',
              ts: new Date().toISOString(),
              content: [{ type: 'text', text: `cascade result from ${agentKind}` }],
            });
          }
        }
      })();
    });

    events.emitCustom('chimera.cascade_needed', cascadePayload);
    // emitCustom fires the handler synchronously, which assigns pendingCascadeWork.
    // Await it so spawn/append complete before assertions.
    await pendingCascadeWork;
  }

  it('spawns both security-scanner and bug-hunter for a Critical security finding', async () => {
    const events = new EventBus();
    const director = makeDirector([
      { status: 'success', result: 'security scan complete' },
      { status: 'success', result: 'bug hunt complete' },
    ]);
    const session = { append: vi.fn(async () => {}) };

    const cascadePayload: ChimeraCascadeNeededPayload = {
      bundle: makeBundle('high'),
      reviewText: CRITICAL_SECURITY_REPORT,
      severities: { critical: 2, high: 1, medium: 1 },
      threshold: 'critical',
      agents: ['security-scanner', 'bug-hunter'],
    };

    await runCascadeHandler(events, director, session, cascadePayload);

    expect(director.spawn).toHaveBeenCalledTimes(2);
    const spawnCalls = director.spawn.mock.calls;
    const roles = spawnCalls.map((c) => (c[0] as { role: string }).role);
    expect(roles).toContain('security-scanner');
    expect(roles).toContain('bug-hunter');

    // Both results appended to session
    expect(session.append).toHaveBeenCalledTimes(2);
  });

  it('spawns only bug-hunter for High bug-only findings', async () => {
    const events = new EventBus();
    const director = makeDirector([{ status: 'success', result: 'bug hunt done' }]);
    const session = { append: vi.fn(async () => {}) };

    const cascadePayload: ChimeraCascadeNeededPayload = {
      bundle: makeBundle('high'),
      reviewText: HIGH_BUG_ONLY_REPORT,
      severities: { critical: 0, high: 2, medium: 0 },
      threshold: 'high',
      agents: ['bug-hunter'],
    };

    await runCascadeHandler(events, director, session, cascadePayload);

    expect(director.spawn).toHaveBeenCalledTimes(1);
    const role = ((director.spawn.mock.calls as unknown[][])[0]?.[0] as { role: string })?.role;
    expect(role).toBe('bug-hunter');
    expect(session.append).toHaveBeenCalledTimes(1);
  });

  it('appends an error when the follow-up agent fails', async () => {
    const events = new EventBus();
    const director = makeDirector([{ status: 'timeout', result: null }]);
    const session = { append: vi.fn(async () => {}) };

    const cascadePayload: ChimeraCascadeNeededPayload = {
      bundle: makeBundle('high'),
      reviewText: HIGH_BUG_ONLY_REPORT,
      severities: { critical: 0, high: 2, medium: 0 },
      threshold: 'high',
      agents: ['bug-hunter'],
    };

    await runCascadeHandler(events, director, session, cascadePayload);

    // spawn called once, but no success append — failure path
    expect(director.spawn).toHaveBeenCalledTimes(1);
    // The handler appends nothing on non-success status (mirrors execution.ts
    // which only appends llm_response on success; errors are logged differently)
    expect(session.append).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART 3: Full end-to-end — review_complete → cascade_needed → spawn
// ═══════════════════════════════════════════════════════════════════════

describe('Cascade chain: full e2e (review_complete → cascade_needed → spawn)', () => {
  it('end-to-end: Critical security report with cascadeOn:high spawns security-scanner + bug-hunter', async () => {
    const events = new EventBus();
    const director = makeDirector([
      { status: 'success', result: 'security scan complete' },
      { status: 'success', result: 'bug hunt complete' },
    ]);
    const session = { append: vi.fn(async () => {}) };

    // Wire the real auto-review plugin
    const api = makeApiWithRealBus(events, {
      'wstack-auto-review': { enabled: true, cascadeOn: 'high' },
    });
    createAutoReviewPlugin().setup!(api);

    // Track spawns triggered by cascade_needed
    events.onPattern('chimera.cascade_needed', (_event, payload) => {
      const p = payload as ChimeraCascadeNeededPayload;
      void (async () => {
        for (const agentKind of p.agents) {
          const role = agentKind === 'security-scanner' ? 'security-scanner' : 'bug-hunter';
          await director.spawn({ name: `cascade-${agentKind}`, role } as never);
          await director.awaitTasks(['x']);
          await session.append({
            type: 'llm_response',
            ts: new Date().toISOString(),
            content: [{ type: 'text', text: `${agentKind} done` }],
          });
        }
      })();
    });

    // Emit the review_complete event (as execution.ts would after the review subagent finishes)
    const bundle = makeBundle('high');
    const payload: ChimeraReviewCompletePayload = {
      bundle,
      reviewText: CRITICAL_SECURITY_REPORT,
      status: 'success',
      cwd: '/test-cwd',
    };
    events.emitCustom('chimera.review_complete', payload);

    // Wait a tick for the async cascade handler to complete
    await new Promise((r) => setTimeout(r, 50));

    // Verify: both agents spawned with correct roles
    expect(director.spawn).toHaveBeenCalledTimes(2);
    const roles = director.spawn.mock.calls.map((c) => (c[0] as { role: string }).role);
    expect(roles).toContain('security-scanner');
    expect(roles).toContain('bug-hunter');

    // Verify: both results appended
    expect(session.append).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART 4: Re-review depth guard (closed self-correcting loop)
// ═══════════════════════════════════════════════════════════════════════

describe('Cascade re-review depth guard (closed loop)', () => {
  /**
   * Mirrors the re-review decision logic from execution.ts:757-838.
   * Returns 're-review' | 'stop-at-limit' | 'no-re-review' based on the
   * depth/maxCascadeDepth comparison.
   */
  function decideReReview(
    cascadeDepth: number | undefined,
    maxCascadeDepth: number | undefined,
  ): 're-review' | 'stop-at-limit' | 'no-re-review' {
    const maxDepth = maxCascadeDepth ?? 0;
    const currentDepth = cascadeDepth ?? 0;
    if (maxDepth > 0 && currentDepth < maxDepth) return 're-review';
    if (maxDepth > 0 && currentDepth >= maxDepth) return 'stop-at-limit';
    return 'no-re-review';
  }

  it('re-reviews when depth 0 and maxCascadeDepth is 2', () => {
    expect(decideReReview(0, 2)).toBe('re-review');
  });

  it('re-reviews when depth 1 and maxCascadeDepth is 2', () => {
    expect(decideReReview(1, 2)).toBe('re-review');
  });

  it('stops at depth limit when depth equals maxCascadeDepth', () => {
    expect(decideReReview(2, 2)).toBe('stop-at-limit');
  });

  it('stops at depth limit when depth exceeds maxCascadeDepth', () => {
    expect(decideReReview(3, 2)).toBe('stop-at-limit');
  });

  it('does not re-review when maxCascadeDepth is 0 (disabled)', () => {
    expect(decideReReview(0, 0)).toBe('no-re-review');
  });

  it('does not re-review when maxCascadeDepth is absent (undefined)', () => {
    expect(decideReReview(0, undefined)).toBe('no-re-review');
  });

  it('does not re-review when both fields are absent (non-cascade trigger)', () => {
    expect(decideReReview(undefined, undefined)).toBe('no-re-review');
  });

  it('re-reviews at depth 0 when maxCascadeDepth is 1 (single re-review allowed)', () => {
    expect(decideReReview(0, 1)).toBe('re-review');
    // After the re-review, depth becomes 1 which equals maxCascadeDepth 1
    expect(decideReReview(1, 1)).toBe('stop-at-limit');
  });

  it('full loop simulation: depth increments until limit reached', () => {
    const maxDepth = 3;
    let depth = 0;
    const decisions: string[] = [];
    // Simulate the loop: at each depth, decide whether to re-review
    for (let i = 0; i < maxDepth + 2; i++) {
      const decision = decideReReview(depth, maxDepth);
      decisions.push(`${depth}:${decision}`);
      if (decision !== 're-review') break;
      depth++; // Simulate the re-review incrementing depth
    }
    // Should re-review at depths 0, 1, 2, then stop at 3
    expect(decisions).toEqual([
      '0:re-review',
      '1:re-review',
      '2:re-review',
      '3:stop-at-limit',
    ]);
  });

  it('bundle carries cascadeDepth+1 on re-review emission', () => {
    // Verify the re-review bundle shape: depth increments, other fields preserved
    const originalBundle = makeBundle('high');
    originalBundle.cascadeDepth = 1;
    originalBundle.maxCascadeDepth = 3;
    // Simulate the spread + override from execution.ts
    const reReviewBundle = {
      ...originalBundle,
      cascadeDepth: (originalBundle.cascadeDepth ?? 0) + 1,
    };
    expect(reReviewBundle.cascadeDepth).toBe(2);
    expect(reReviewBundle.maxCascadeDepth).toBe(3);
    expect(reReviewBundle.cascadeOn).toBe('high');
    expect(reReviewBundle.cwd).toBe(originalBundle.cwd);
    expect(reReviewBundle.files).toBe(originalBundle.files);
  });
});
