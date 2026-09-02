/**
 * Tests for buildVerificationReport and renderVerificationReportMarkdown.
 *
 * Coverage targets:
 * - buildVerificationReport returns a complete report with correct verdict
 * - verifies all verdict paths: passed, failed, needs_human, incomplete
 * - markdown renderer produces correct output for each status
 * - file scope, subtasks, and attachments are rendered
 */
import { describe, expect, it } from 'vitest';
import {
  buildVerificationReport,
  renderVerificationReportMarkdown,
} from '../../src/verification/verification-report.js';
import type { KanbanVerificationCheckResult } from '../../src/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

function passedCheck(id: string, description = 'Check passed'): KanbanVerificationCheckResult {
  return {
    checkId: id,
    description,
    type: 'test',
    status: 'passed',
    evidence: { passed: true },
  };
}

function failedCheck(id: string, description = 'Check failed'): KanbanVerificationCheckResult {
  return {
    checkId: id,
    description,
    type: 'test',
    status: 'failed',
    evidence: { passed: false },
    error: 'Expected X but got Y',
  };
}

function skippedCheck(id: string, description = 'Check skipped'): KanbanVerificationCheckResult {
  return {
    checkId: id,
    description,
    type: 'manual',
    status: 'skipped',
    evidence: {},
    error: 'No verifier plugin registered for check type "manual".',
  };
}

function erroredCheck(id: string, description = 'Check error'): KanbanVerificationCheckResult {
  return {
    checkId: id,
    description,
    type: 'command',
    status: 'error',
    evidence: {},
    error: 'Command timed out',
  };
}

function checkWithBackingRefs(id: string, description: string): KanbanVerificationCheckResult {
  return {
    checkId: id,
    description,
    type: 'agent',
    status: 'passed',
    evidence: { agent: 'test' },
    backingRefs: [
      { kind: 'file', path: 'src/foo.ts', summary: 'Added 3 files' },
      { kind: 'test', path: 'test/foo.test.ts', summary: '12 tests, all passing' },
    ],
  };
}

function checkWithEvidence(
  id: string,
  type: string,
  evidence: Record<string, unknown>,
): KanbanVerificationCheckResult {
  return {
    checkId: id,
    description: `Check ${id}`,
    type: type as KanbanVerificationCheckResult['type'],
    status: 'passed',
    evidence,
  };
}

// ── buildVerificationReport ───────────────────────────────────────────────

describe('buildVerificationReport', () => {
  it('returns passed when all checks pass', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1'), passedCheck('c2')],
    });

    expect(report.verdict).toBe('passed');
    expect(report.taskId).toBe('t1');
    expect(report.taskTitle).toBe('Test task');
    expect(report.boardId).toBe('b1');
    expect(report.checks).toHaveLength(2);
    expect(report.attachments).toEqual([]);
    expect(report.startedAt).toBeTruthy();
    expect(report.completedAt).toBeTruthy();
  });

  it('returns failed when any check fails', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1'), failedCheck('c2')],
    });

    expect(report.verdict).toBe('failed');
  });

  it('returns failed when multiple checks fail', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [failedCheck('c1'), failedCheck('c2'), passedCheck('c3')],
    });

    expect(report.verdict).toBe('failed');
  });

  it('returns needs_human when any check errors', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1'), erroredCheck('c2')],
    });

    expect(report.verdict).toBe('needs_human');
  });

  it('returns needs_human when only error checks exist', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [erroredCheck('c1')],
    });

    expect(report.verdict).toBe('needs_human');
  });

  it('legacy contract: returns passed when all checks are skipped', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [skippedCheck('c1'), skippedCheck('c2')],
    });

    expect(report.verdict).toBe('passed');
  });

  it('returns passed when checks are mix of passed and skipped', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1'), skippedCheck('c2')],
    });

    expect(report.verdict).toBe('passed');
  });

  it('returns incomplete when subtasks exist but not all are completed', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
      subtasks: {
        total: 3,
        completed: 1,
        failed: 0,
        children: [
          { taskId: 'st1', title: 'Sub 1', verdict: 'passed' },
          { taskId: 'st2', title: 'Sub 2', verdict: 'incomplete' },
          { taskId: 'st3', title: 'Sub 3', verdict: 'passed' },
        ],
      },
    });

    expect(report.verdict).toBe('incomplete');
  });

  it('a failed subtask fails the parent even when every check passed', () => {
    // This used to be pinned as a "legacy contract" returning 'passed':
    // `subtasks.failed` was written and never read, so a parent whose
    // children failed — even ALL of them — verified green.
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
      subtasks: {
        total: 3,
        completed: 2,
        failed: 1,
        children: [
          { taskId: 'st1', title: 'Sub 1', verdict: 'passed' },
          { taskId: 'st2', title: 'Sub 2', verdict: 'failed' },
          { taskId: 'st3', title: 'Sub 3', verdict: 'passed' },
        ],
      },
    });

    expect(report.verdict).toBe('failed');
  });

  it('all children failed can never verify as passed', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
      subtasks: {
        total: 2,
        completed: 0,
        failed: 2,
        children: [
          { taskId: 'st1', title: 'Sub 1', verdict: 'failed' },
          { taskId: 'st2', title: 'Sub 2', verdict: 'failed' },
        ],
      },
    });

    expect(report.verdict).toBe('failed');
  });

  it('returns failed when both failed checks and incomplete subtasks exist', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [failedCheck('c1')],
      subtasks: {
        total: 2,
        completed: 0,
        failed: 0,
        children: [{ taskId: 'st1', title: 'Sub 1', verdict: 'incomplete' }],
      },
    });

    // hasFailed takes priority
    expect(report.verdict).toBe('failed');
  });

  it('passes through attachments', () => {
    const attachments = [
      { kind: 'test_output' as const, label: 'Test output', content: 'Failure details' },
    ];
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
      attachments,
    });

    expect(report.attachments).toEqual(attachments);
  });

  it('attachments default to empty array', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
    });

    expect(report.attachments).toEqual([]);
  });

  it('passes through fileScope', () => {
    const fileScope = {
      expectedChanges: 2,
      actualChanges: 2,
      scopeMatches: true,
      files: [
        { path: 'src/foo.ts', operation: 'modify' as const, expected: true, linesChanged: 47 },
      ],
    };
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
      fileScope,
    });

    expect(report.fileScope).toEqual(fileScope);
  });

  it('fails the verdict when file-scope does not match', () => {
    // scopeMatches === false means the worker changed files outside its
    // declared expectedFileChanges set, or failed to change an expected file.
    // That is a real defect regardless of whether the acceptance criteria
    // happened to pass: the card's stated file contract was not honoured.
    // Previously scopeMatches was rendered in the Markdown report but never
    // consulted by the verdict, so a task could score `passed` while touching
    // unrelated files.
    const fileScope = {
      expectedChanges: 1,
      actualChanges: 2,
      scopeMatches: false,
      files: [
        { path: 'src/foo.ts', operation: 'modify' as const, expected: true, linesChanged: 47 },
        {
          path: 'src/unexpected.ts',
          operation: 'create' as const,
          expected: false,
          linesChanged: 12,
        },
      ],
    };
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
      fileScope,
    });

    expect(report.verdict).toBe('failed');
    expect(report.fileScope).toEqual(fileScope);
  });

  it('keeps the verdict passed when file-scope matches and checks pass', () => {
    const fileScope = {
      expectedChanges: 1,
      actualChanges: 1,
      scopeMatches: true,
      files: [
        { path: 'src/foo.ts', operation: 'modify' as const, expected: true, linesChanged: 47 },
      ],
    };
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
      fileScope,
    });

    expect(report.verdict).toBe('passed');
  });

  it('binds attempt/leaseId/taskRevision/baseline when provided', () => {
    // These optional fields tie a verification report to the specific attempt,
    // lease, board revision, and git baseline it was produced against — so a
    // reviewer can tell apart "re-verified attempt 3" from a first attempt,
    // and so a later task edit cannot silently re-frame an old verdict.
    const baseline = {
      id: 'snap-1',
      commitHash: 'abc123',
      treeHash: 'def456',
      capturedAt: '2026-01-01T00:00:00Z',
    };
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
      attempt: 3,
      leaseId: 'lease-9',
      taskRevision: 7,
      baseline,
    });

    expect(report.attempt).toBe(3);
    expect(report.leaseId).toBe('lease-9');
    expect(report.taskRevision).toBe(7);
    expect(report.baseline).toEqual(baseline);
  });

  it('omits attempt/leaseId/taskRevision/baseline when not provided', () => {
    // Backwards-compatibility: older callers that don't supply these fields
    // get a report that looks exactly like before.
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
    });

    expect(report.attempt).toBeUndefined();
    expect(report.leaseId).toBeUndefined();
    expect(report.taskRevision).toBeUndefined();
    expect(report.baseline).toBeUndefined();
  });

  it('passes through subtasks', () => {
    const subtasks = {
      total: 1,
      completed: 1,
      failed: 0,
      children: [{ taskId: 'st1', title: 'Sub 1', verdict: 'passed' as const }],
    };
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
      subtasks,
    });

    expect(report.subtasks).toEqual(subtasks);
  });

  it('includes markdownSummary in the report', () => {
    const report = buildVerificationReport({
      taskId: 't1',
      taskTitle: 'Test task',
      boardId: 'b1',
      checks: [passedCheck('c1')],
    });

    expect(report.markdownSummary).toBeTruthy();
    expect(report.markdownSummary).toContain('Test task');
    expect(report.markdownSummary).toContain('PASSED');
  });
});

// ── renderVerificationReportMarkdown ──────────────────────────────────────

describe('renderVerificationReportMarkdown', () => {
  it('renders a passed report with check details', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Fix login',
      taskId: 't1',
      verdict: 'passed',
      checks: [passedCheck('c1', 'Verify login form')],
    });

    expect(md).toContain('Fix login');
    expect(md).toContain('PASSED');
    expect(md).toContain('✅');
    expect(md).toContain('Verify login form');
    expect(md).toContain('passed');
    expect(md).toContain('1 passed');
  });

  it('renders a failed report with error details', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Fix login',
      taskId: 't1',
      verdict: 'failed',
      checks: [failedCheck('c1', 'Verify login form')],
    });

    expect(md).toContain('FAILED');
    expect(md).toContain('❌');
    expect(md).toContain('Expected X but got Y');
    expect(md).toContain('0 passed, 1 failed');
  });

  it('renders needs_human with warning icon', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Fix login',
      taskId: 't1',
      verdict: 'needs_human',
      checks: [erroredCheck('c1')],
    });

    expect(md).toContain('NEEDS_HUMAN');
    expect(md).toContain('⚠️');
    expect(md).toContain('Command timed out');
    expect(md).toContain('0 passed, 0 failed, 0 skipped, 1 errors');
  });

  it('renders incomplete with cycle icon', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Fix login',
      taskId: 't1',
      verdict: 'incomplete',
      checks: [],
    });

    expect(md).toContain('INCOMPLETE');
    expect(md).toContain('🔄');
  });

  it('renders file scope section', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Fix login',
      taskId: 't1',
      verdict: 'passed',
      checks: [passedCheck('c1')],
      fileScope: {
        expectedChanges: 3,
        actualChanges: 3,
        scopeMatches: true,
        files: [
          { path: 'src/auth.ts', operation: 'modify', expected: true, linesChanged: 47 },
          { path: 'src/login.tsx', operation: 'create', expected: true, linesChanged: 120 },
        ],
      },
    });

    expect(md).toContain('File Scope');
    expect(md).toContain('src/auth.ts');
    expect(md).toContain('modify');
    expect(md).toContain('src/login.tsx');
    expect(md).toContain('create');
  });

  it('renders file scope with unexpected files', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Fix login',
      taskId: 't1',
      verdict: 'failed',
      checks: [],
      fileScope: {
        expectedChanges: 1,
        actualChanges: 2,
        scopeMatches: false,
        files: [
          { path: 'src/auth.ts', operation: 'modify', expected: true, linesChanged: 47 },
          { path: 'unexpected.ts', operation: 'create', expected: false, linesChanged: 10 },
        ],
      },
    });

    expect(md).toContain('unexpected');
    expect(md).toContain('unexpected.ts');
  });

  it('renders subtask section', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Fix login',
      taskId: 't1',
      verdict: 'passed',
      checks: [passedCheck('c1')],
      subtasks: {
        total: 2,
        completed: 2,
        failed: 0,
        children: [
          { taskId: 'st1', title: 'Sub 1', verdict: 'passed' },
          { taskId: 'st2', title: 'Sub 2', verdict: 'passed' },
        ],
      },
    });

    expect(md).toContain('Subtask Status');
    expect(md).toContain('**2**/2 completed');
    expect(md).toContain('Sub 1');
    expect(md).toContain('Sub 2');
  });

  it('renders subtasks with failed verdicts', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Fix login',
      taskId: 't1',
      verdict: 'failed',
      checks: [],
      subtasks: {
        total: 1,
        completed: 0,
        failed: 1,
        children: [{ taskId: 'st1', title: 'Failed sub', verdict: 'failed' }],
      },
    });

    expect(md).toContain('**0**/1 completed, **1** failed');
    expect(md).toContain('Failed sub');
    expect(md).toContain('❌');
  });

  it('renders backing refs for escalation checks', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Agent task',
      taskId: 't1',
      verdict: 'passed',
      checks: [checkWithBackingRefs('c1', 'Agent review')],
    });

    expect(md).toContain('Proof References');
    expect(md).toContain('[file]');
    expect(md).toContain('src/foo.ts');
    expect(md).toContain('[test]');
    expect(md).toContain('test/foo.test.ts');
  });

  it('renders evidence entries', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Test',
      taskId: 't1',
      verdict: 'passed',
      checks: [checkWithEvidence('c1', 'test', { passed: 5, failed: 0 })],
    });

    expect(md).toContain('Evidence');
    expect(md).toContain('passed');
    expect(md).toContain('5');
    expect(md).toContain('0');
  });

  it('renders error on checks', () => {
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Test',
      taskId: 't1',
      verdict: 'failed',
      checks: [failedCheck('c1', 'Failed check')],
    });

    expect(md).toContain('Error');
    expect(md).toContain('Expected X but got Y');
  });

  it('truncates long evidence strings', () => {
    const longStr = 'x'.repeat(500);
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Test',
      taskId: 't1',
      verdict: 'passed',
      checks: [checkWithEvidence('c1', 'command', { stdout: longStr })],
    });

    // Should be truncated
    expect(md).not.toContain(longStr);
  });

  it('summarizes long evidence arrays', () => {
    const longArray = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const md = renderVerificationReportMarkdown({
      taskTitle: 'Test',
      taskId: 't1',
      verdict: 'passed',
      checks: [checkWithEvidence('c1', 'git_diff', { diffStats: longArray })],
    });

    expect(md).toContain('[20 items]');
  });
});
