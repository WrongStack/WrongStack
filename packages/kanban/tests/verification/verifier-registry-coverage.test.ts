/**
 * Comprehensive coverage for:
 * - VerifierRegistry: registration, resolution, escalation, evidence validation
 * - TestPlugin: test runner verification with pass/fail/skip/error paths
 * - GitDiffPlugin: git diff verification with expectedFiles, min/max changes
 */
import { describe, expect, it } from 'vitest';
import { VerifierRegistry } from '../../src/verification/verifier-registry.js';
import { TestPlugin } from '../../src/verification/plugins/test.js';
import { GitDiffPlugin } from '../../src/verification/plugins/git-diff.js';
import { MetricPlugin } from '../../src/verification/plugins/metric.js';
import type { KanbanCheck, KanbanTask } from '../../src/types.js';
import type { VerificationContext } from '../../src/verification/verification-context.js';
import type { VerifierPlugin } from '../../src/verification/verifier-plugin.js';

function makeCheck(overrides: Partial<KanbanCheck> = {}): KanbanCheck {
  return {
    id: 'check-1',
    description: 'Test check',
    type: 'test' as KanbanCheck['type'],
    status: 'pending',
    ...overrides,
  } as KanbanCheck;
}

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    projectRoot: '/fake',
    board: {} as any,
    task: {} as KanbanTask,
    requireBackingEvidence: false,
    ...overrides,
  } as unknown as VerificationContext;
}

function testResult(
  testPattern: string,
  overrides: Partial<{
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
    failureOutput: string;
  }> = {},
) {
  return {
    testPattern,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    failureOutput: '',
    ...overrides,
  };
}

function gitStatus(
  overrides: Partial<{
    clean: boolean;
    untracked: number;
    unstaged: number;
    staged: number;
    files: string[];
    error: string | undefined;
  }> = {},
) {
  return {
    clean: false,
    untracked: 0,
    unstaged: 0,
    staged: 0,
    files: [],
    ...overrides,
  };
}

// ─── VerifierRegistry ───────────────────────────────────────────────────────

describe('VerifierRegistry', () => {
  it('registers and retrieves plugins', () => {
    const reg = new VerifierRegistry();
    const plugin = new MetricPlugin();
    reg.register(plugin);
    expect(reg.get('metric')).toBe(plugin);
    expect(reg.list()).toContain('metric');
  });

  it('register is chainable', () => {
    const reg = new VerifierRegistry();
    const result = reg.register(new MetricPlugin()).register(new TestPlugin());
    expect(result).toBe(reg);
    expect(reg.list().length).toBe(2);
  });

  it('overwrites existing registration with same id', () => {
    const reg = new VerifierRegistry();
    const p1 = new MetricPlugin();
    const p2 = new MetricPlugin();
    reg.register(p1);
    reg.register(p2);
    expect(reg.get('metric')).toBe(p2);
    // Should not add duplicate in resolutionOrder
    expect(reg.list().filter((id) => id === 'metric').length).toBe(1);
  });

  it('unregisters a plugin by id', () => {
    const reg = new VerifierRegistry();
    reg.register(new MetricPlugin());
    expect(reg.unregister('metric')).toBe(true);
    expect(reg.get('metric')).toBeUndefined();
    expect(reg.list()).not.toContain('metric');
  });

  it('unregister returns false for non-existent id', () => {
    const reg = new VerifierRegistry();
    expect(reg.unregister('nonexistent')).toBe(false);
  });

  it('list returns all registered plugin ids', () => {
    const reg = new VerifierRegistry();
    reg.register(new MetricPlugin()).register(new TestPlugin()).register(new GitDiffPlugin());
    expect(reg.list().length).toBe(3);
  });

  it('get returns undefined for unregistered id', () => {
    const reg = new VerifierRegistry();
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('verify returns skipped for unknown check type', async () => {
    const reg = new VerifierRegistry();
    const result = await reg.verify(
      makeCheck({ type: 'unknown_type' as KanbanCheck['type'] }),
      makeContext(),
    );
    expect(result.status).toBe('skipped');
    expect(result.error).toContain('No verifier plugin');
  });

  it('verify passes through manually passed status for unknown type', async () => {
    const reg = new VerifierRegistry();
    const result = await reg.verify(
      makeCheck({
        type: 'unknown_type' as KanbanCheck['type'],
        status: 'passed',
        checkedBy: 'reviewer',
      }),
      makeContext(),
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.manual).toBe(true);
    expect(result.evidence.checkedBy).toBe('reviewer');
  });

  it('verify passes through manually failed status for unknown type', async () => {
    const reg = new VerifierRegistry();
    const result = await reg.verify(
      makeCheck({ type: 'unknown_type' as KanbanCheck['type'], status: 'failed' }),
      makeContext(),
    );
    expect(result.status).toBe('failed');
    expect(result.evidence.manual).toBe(true);
  });

  it('verify includes checkedAt in evidence for manual results', async () => {
    const reg = new VerifierRegistry();
    const result = await reg.verify(
      makeCheck({
        type: 'unknown_type' as KanbanCheck['type'],
        status: 'passed',
        checkedAt: '2026-01-01',
      }),
      makeContext(),
    );
    expect(result.evidence.checkedAt).toBe('2026-01-01');
  });

  it('verify resolves by check type when plugin is registered', async () => {
    const reg = new VerifierRegistry();
    reg.register(new MetricPlugin());
    const ctx = makeContext({
      task: {
        goalMetrics: [{ id: 'm1', name: 'cov', status: 'pending', target: 80, current: 90 }],
      } as KanbanTask,
    });
    const result = await reg.verify(makeCheck({ type: 'metric' as KanbanCheck['type'] }), ctx);
    expect(result.status).toBe('passed');
  });

  it('verify escalation=agent routes to agent plugin', async () => {
    const reg = new VerifierRegistry();
    // Register a mock escalation plugin
    const mockAgentPlugin: VerifierPlugin = {
      id: 'agent',
      kind: 'escalation',
      canHandle: (t) => t === 'agent',
      verify: async () => ({
        checkId: 'check-1',
        description: 'agent check',
        type: 'agent' as KanbanCheck['type'],
        status: 'passed',
        evidence: { agent: true },
        backingRefs: [{ kind: 'file', path: 'src/file.ts', summary: 'test file' }],
      }),
    };
    reg.register(mockAgentPlugin);
    const result = await reg.verify(
      makeCheck({
        type: 'test' as KanbanCheck['type'],
        escalation: 'agent' as KanbanCheck['escalation'],
      }),
      makeContext(),
    );
    expect(result.status).toBe('passed');
  });

  it('verify escalation=council uses stricter evidence rules', async () => {
    const reg = new VerifierRegistry();
    // Register a mock escalation plugin with weak evidence
    const mockCouncilPlugin: VerifierPlugin = {
      id: 'council',
      kind: 'escalation',
      canHandle: (t) => t === 'council',
      verify: async () => ({
        checkId: 'check-1',
        description: 'council check',
        type: 'council' as KanbanCheck['type'],
        status: 'passed',
        evidence: {},
      }),
    };
    reg.register(mockCouncilPlugin);
    const result = await reg.verify(
      makeCheck({
        type: 'test' as KanbanCheck['type'],
        escalation: 'council' as KanbanCheck['escalation'],
      }),
      makeContext(),
    );
    // Should be rejected because no backingRefs
    expect(result.status).toBe('failed');
    expect(result.error).toContain('rejected');
  });

  it('verify escalation=agent with insufficient evidence fails', async () => {
    const reg = new VerifierRegistry();
    const mockAgentPlugin: VerifierPlugin = {
      id: 'agent',
      kind: 'escalation',
      canHandle: (t) => t === 'agent',
      verify: async () => ({
        checkId: 'check-1',
        description: 'agent check',
        type: 'agent' as KanbanCheck['type'],
        status: 'passed',
        evidence: {},
      }),
    };
    reg.register(mockAgentPlugin);
    const result = await reg.verify(
      makeCheck({
        type: 'test' as KanbanCheck['type'],
        escalation: 'agent' as KanbanCheck['escalation'],
      }),
      makeContext(),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('rejected');
  });
});

// ─── TestPlugin ─────────────────────────────────────────────────────────────

describe('TestPlugin comprehensive', () => {
  const plugin = new TestPlugin();

  it('returns error when pattern is empty', async () => {
    const result = await plugin.verify(
      makeCheck({ type: 'test', description: '', notes: '' }),
      makeContext(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('requires a test pattern');
  });

  it('returns passed when all tests pass', async () => {
    const ctx = makeContext({
      runTest: async (pattern) => testResult(pattern, { passed: 10, durationMs: 500 }),
    });
    const result = await plugin.verify(makeCheck({ type: 'test', description: 'run tests' }), ctx);
    expect(result.status).toBe('passed');
    expect(result.evidence.passed).toBe(10);
    expect(result.error).toBeUndefined();
  });

  it('returns failed when some tests fail', async () => {
    const ctx = makeContext({
      runTest: async (pattern) =>
        testResult(pattern, {
          passed: 5,
          failed: 3,
          durationMs: 500,
          failureOutput: 'AssertionError',
        }),
    });
    const result = await plugin.verify(makeCheck({ type: 'test', description: 'run tests' }), ctx);
    expect(result.status).toBe('failed');
    expect(result.evidence.failed).toBe(3);
    expect(result.error).toContain('3 test(s) failed');
  });

  it('parses expected pass count from description', async () => {
    const ctx = makeContext({
      runTest: async (pattern) => testResult(pattern, { passed: 3, durationMs: 500 }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'test', description: 'expect 10+ pass' }),
      ctx,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Expected 10 passes');
  });

  it('uses notes for pattern when description is empty', async () => {
    let capturedPattern = '';
    const ctx = makeContext({
      runTest: async (p: string) => {
        capturedPattern = p;
        return testResult(p, { passed: 1, durationMs: 100 });
      },
    });
    await plugin.verify(makeCheck({ type: 'test', description: '', notes: 'test/*.test.ts' }), ctx);
    expect(capturedPattern).toBe('test/*.test.ts');
  });

  it('returns skipped count in evidence', async () => {
    const ctx = makeContext({
      runTest: async (pattern) => testResult(pattern, { passed: 5, skipped: 2, durationMs: 500 }),
    });
    const result = await plugin.verify(makeCheck({ type: 'test', description: 'run tests' }), ctx);
    expect(result.evidence.skipped).toBe(2);
  });
});

// ─── GitDiffPlugin ──────────────────────────────────────────────────────────

describe('GitDiffPlugin comprehensive', () => {
  const plugin = new GitDiffPlugin();

  it('returns passed when diff matches expectations', async () => {
    const ctx = makeContext({
      diffSince: async () => [
        { path: 'src/foo.ts', operation: 'modify', linesAdded: 10, linesRemoved: 5 },
      ],
      gitStatus: async () => gitStatus({ unstaged: 1 }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'git_diff', description: 'check diff', notes: '{}' }),
      ctx,
    );
    expect(result.status).toBe('passed');
    expect(result.evidence.filesChanged).toBe(1);
    expect(result.evidence.modified).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it('returns failed when no changes detected', async () => {
    const ctx = makeContext({
      diffSince: async () => [],
      gitStatus: async () => gitStatus({ clean: true }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'git_diff', description: 'check diff' }),
      ctx,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('No file changes');
  });

  it('returns failed when git status has error', async () => {
    const ctx = makeContext({
      diffSince: async () => [],
      gitStatus: async () => gitStatus({ error: 'Not a git repo' }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'git_diff', description: 'check diff' }),
      ctx,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Not a git repo');
  });

  it('checks expected files from config JSON', async () => {
    const ctx = makeContext({
      diffSince: async () => [
        { path: 'src/existing.ts', operation: 'modify', linesAdded: 5, linesRemoved: 2 },
      ],
      gitStatus: async () => gitStatus({ unstaged: 1 }),
    });
    const result = await plugin.verify(
      makeCheck({
        type: 'git_diff',
        description: 'check diff',
        notes: JSON.stringify({ expectedFiles: ['src/missing.ts'] }),
      }),
      ctx,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('src/missing.ts');
  });

  it('checks minChanges constraint', async () => {
    const ctx = makeContext({
      diffSince: async () => [
        { path: 'src/foo.ts', operation: 'modify', linesAdded: 2, linesRemoved: 1 },
      ],
      gitStatus: async () => gitStatus({ unstaged: 1 }),
    });
    const result = await plugin.verify(
      makeCheck({
        type: 'git_diff',
        description: 'check diff',
        notes: JSON.stringify({ minChanges: 10 }),
      }),
      ctx,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('at least 10');
  });

  it('checks maxChanges constraint', async () => {
    const ctx = makeContext({
      diffSince: async () => [
        { path: 'src/foo.ts', operation: 'modify', linesAdded: 100, linesRemoved: 50 },
      ],
      gitStatus: async () => gitStatus({ unstaged: 1 }),
    });
    const result = await plugin.verify(
      makeCheck({
        type: 'git_diff',
        description: 'check diff',
        notes: JSON.stringify({ maxChanges: 10 }),
      }),
      ctx,
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('at most 10');
  });

  it('handles non-JSON notes gracefully', async () => {
    const ctx = makeContext({
      diffSince: async () => [
        { path: 'src/foo.ts', operation: 'modify', linesAdded: 5, linesRemoved: 2 },
      ],
      gitStatus: async () => gitStatus({ unstaged: 1 }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'git_diff', description: 'check diff', notes: 'not json' }),
      ctx,
    );
    expect(result.status).toBe('passed');
  });

  it('counts create/modify/delete operations separately', async () => {
    const ctx = makeContext({
      diffSince: async () => [
        { path: 'a.ts', operation: 'create', linesAdded: 10, linesRemoved: 0 },
        { path: 'b.ts', operation: 'modify', linesAdded: 5, linesRemoved: 3 },
        { path: 'c.ts', operation: 'delete', linesAdded: 0, linesRemoved: 20 },
      ],
      gitStatus: async () => gitStatus({ unstaged: 3 }),
    });
    const result = await plugin.verify(
      makeCheck({ type: 'git_diff', description: 'check diff' }),
      ctx,
    );
    expect(result.evidence.added).toBe(1);
    expect(result.evidence.modified).toBe(1);
    expect(result.evidence.deleted).toBe(1);
  });
});
