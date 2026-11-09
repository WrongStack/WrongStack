/**
 * System One criterion verifier: decisive verdicts only, never re-judges a
 * status a person set, and leaves the escalation open (skipped, not failed)
 * whenever it cannot decide.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KanbanCheck } from '../../../src/types.js';
import { createDefaultRegistry } from '../../../src/verification/plugins/index.js';
import { setKanbanCriterionJudge } from '../../../src/verification/plugins/system-one.js';
import type { VerificationContext } from '../../../src/verification/verification-context.js';

const check = (overrides: Partial<KanbanCheck> = {}): KanbanCheck =>
  ({
    id: 'c1',
    description: 'Adds a --json flag to the status command',
    type: 'agent',
    status: 'pending',
    ...overrides,
  }) as KanbanCheck;

const context = (files: string[]): VerificationContext =>
  ({
    diffSince: vi.fn(async () =>
      files.map((path) => ({ path, operation: 'modify', linesAdded: 3, linesRemoved: 1 })),
    ),
    gitStatus: vi.fn(async () => ({
      clean: files.length === 0,
      files,
      untracked: 0,
      unstaged: 0,
      staged: 0,
    })),
    gitDiffForFiles: vi.fn(async () => '+  .option("--json")'),
  }) as unknown as VerificationContext;

afterEach(() => setKanbanCriterionJudge(undefined));

describe('SystemOneVerifierPlugin', () => {
  it('is inert without an installed judge', async () => {
    const result = await createDefaultRegistry().verify(check(), context(['src/status.ts']));
    expect(result.status).toBe('skipped');
    expect(result.error).toContain('No verifier plugin');
  });

  it('passes a clearly met criterion with diff evidence', async () => {
    setKanbanCriterionJudge(() => async () => ({ probability: 0.97, model: 'jev-test' }));
    const result = await createDefaultRegistry().verify(check(), context(['src/status.ts']));
    expect(result.status).toBe('passed');
    expect(result.backingRefs?.[0]?.path).toBe('src/status.ts');
  });

  it('fails a criterion the diff clearly does not meet', async () => {
    setKanbanCriterionJudge(() => async () => ({ probability: 0.02 }));
    const result = await createDefaultRegistry().verify(check(), context(['src/status.ts']));
    expect(result.status).toBe('failed');
  });

  it('stays open when undecided, failing or without changes', async () => {
    setKanbanCriterionJudge(() => async () => ({ probability: 0.5 }));
    expect((await createDefaultRegistry().verify(check(), context(['a.ts']))).status).toBe(
      'skipped',
    );
    setKanbanCriterionJudge(() => async () => undefined);
    expect((await createDefaultRegistry().verify(check(), context(['a.ts']))).status).toBe(
      'skipped',
    );
    setKanbanCriterionJudge(() => async () => ({ probability: 0.99 }));
    expect((await createDefaultRegistry().verify(check(), context([]))).status).toBe('skipped');
  });

  it.each([1.5, -0.1, Number.POSITIVE_INFINITY, Number.NaN])(
    'leaves invalid probability %s open rather than issuing a verdict',
    async (probability) => {
      setKanbanCriterionJudge(() => async () => ({ probability }));
      const result = await createDefaultRegistry().verify(check(), context(['a.ts']));
      expect(result.status).toBe('skipped');
      expect(result.backingRefs).toBeUndefined();
    },
  );

  it.each([
    [0, 'failed'],
    [1, 'passed'],
  ] as const)('accepts boundary probability %s', async (probability, status) => {
    setKanbanCriterionJudge(() => async () => ({ probability }));
    expect((await createDefaultRegistry().verify(check(), context(['a.ts']))).status).toBe(status);
  });

  it('does not re-judge a preset status or invent verification from it', async () => {
    const judge = vi.fn(async () => ({ probability: 0.01 }));
    setKanbanCriterionJudge(() => judge);
    const result = await createDefaultRegistry().verify(
      check({ status: 'passed', checkedBy: 'human' }),
      context(['a.ts']),
    );
    expect(result.status).toBe('skipped');
    expect(judge).not.toHaveBeenCalled();
  });

  it('re-runs a previous automated verdict against current evidence', async () => {
    const judge = vi.fn(async () => ({ probability: 0.99 }));
    setKanbanCriterionJudge(() => judge);
    const result = await createDefaultRegistry().verify(
      check({ status: 'passed', checkedBy: 'agent' }),
      context(['a.ts']),
    );
    expect(result.status).toBe('passed');
    expect(judge).toHaveBeenCalledTimes(1);
    expect(result.backingRefs?.[0]?.path).toBe('a.ts');
  });
});
