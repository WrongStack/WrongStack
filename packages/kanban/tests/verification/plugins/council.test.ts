/**
 * Tests for CouncilVerifierPlugin — escalation verifier contract.
 *
 * Coverage targets:
 * - id and kind accessors
 * - canHandle('council') returns true
 * - canHandle(other types) returns false
 * - verify returns a structured KanbanVerificationCheckResult
 * - verify result includes status, evidence, description
 */
import { describe, expect, it } from 'vitest';
import { CouncilVerifierPlugin } from '../../../src/verification/plugins/council.js';
import type { KanbanCheck } from '../../../src/types.js';
import type { VerificationContext } from '../../../src/verification/verification-context.js';

describe('CouncilVerifierPlugin', () => {
  const plugin = new CouncilVerifierPlugin();

  it('has the correct id', () => {
    expect(plugin.id).toBe('council');
  });

  it('has kind "escalation"', () => {
    expect(plugin.kind).toBe('escalation');
  });

  describe('canHandle', () => {
    it('returns true for "council" check type', () => {
      expect(plugin.canHandle('council')).toBe(true);
    });

    it('returns false for other check types', () => {
      expect(plugin.canHandle('file_exists')).toBe(false);
      expect(plugin.canHandle('test')).toBe(false);
      expect(plugin.canHandle('agent')).toBe(false);
      expect(plugin.canHandle('')).toBe(false);
      expect(plugin.canHandle('command')).toBe(false);
    });
  });

  describe('verify', () => {
    const mockCheck: KanbanCheck = {
      id: 'council-check-1',
      type: 'council',
      description: 'Verify architectural consistency',
    } as unknown as KanbanCheck;

    const mockContext = {
      projectRoot: '/fake/project',
      board: {} as any,
      task: {} as any,
      requireBackingEvidence: true,
    } as VerificationContext;

    it('returns a structured result with checkId', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toHaveProperty('checkId', 'council-check-1');
    });

    it('returns a result with status and evidence fields', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('evidence');
      expect(result).toHaveProperty('description');
    });

    it('returns a structured result (not thrown)', async () => {
      const result = await plugin.verify(mockCheck, mockContext);
      expect(result).toBeDefined();
    });
  });
});

describe('CouncilVerifierPlugin — dispatched', () => {
  const check: KanbanCheck = {
    id: 'council-check-2',
    type: 'council',
    description: 'The retry path is bounded',
  } as unknown as KanbanCheck;

  function contextWith(
    diff: Array<{ path: string; operation: string; linesAdded: number; linesRemoved: number }>,
  ): VerificationContext {
    return {
      projectRoot: '/fake/project',
      board: {} as never,
      task: { title: 'Bound the retry loop' } as never,
      requireBackingEvidence: true,
      diffSince: async () => diff,
    } as unknown as VerificationContext;
  }

  const oneFile = [{ path: 'src/retry.ts', operation: 'modify', linesAdded: 12, linesRemoved: 3 }];

  it('passes with diff-backed refs when the panel says the criterion is met', async () => {
    const plugin = new CouncilVerifierPlugin({
      runner: {
        ask: async () => ({ status: 'decided', optionId: 'criterion_met', resolution: 'majority' }),
      },
    });

    const result = await plugin.verify(check, contextWith(oneFile));

    expect(result.status).toBe('passed');
    expect(result.backingRefs).toEqual([
      { kind: 'diff', path: 'src/retry.ts', summary: 'modify with +12/-3 lines' },
    ]);
    expect(result.evidence).toMatchObject({ dispatched: true, resolution: 'majority' });
  });

  it('refuses to pass a verdict that no observed change backs', async () => {
    // "Proof, not opinion": the panel may judge evidence, never substitute
    // for it. A pass over an empty diff is exactly the bare verdict this
    // subsystem exists to reject.
    const plugin = new CouncilVerifierPlugin({
      runner: { ask: async () => ({ status: 'decided', optionId: 'criterion_met' }) },
    });

    const result = await plugin.verify(check, contextWith([]));

    expect(result.status).toBe('failed');
    expect(result.error).toContain('no file changes back the verdict');
  });

  it('fails the check when the panel votes the criterion not met', async () => {
    const plugin = new CouncilVerifierPlugin({
      runner: {
        ask: async () => ({
          status: 'decided',
          optionId: 'criterion_not_met',
          reason: 'The bound is never applied on the timeout path.',
        }),
      },
    });

    const result = await plugin.verify(check, contextWith(oneFile));

    expect(result.status).toBe('failed');
    expect(result.error).toBe('The bound is never applied on the timeout path.');
  });

  it('fails the check on a veto/denial', async () => {
    const plugin = new CouncilVerifierPlugin({
      runner: { ask: async () => ({ status: 'denied', resolution: 'veto' }) },
    });

    const result = await plugin.verify(check, contextWith(oneFile));

    expect(result.status).toBe('failed');
  });

  it('reports an undecided panel as an error, not a skip', async () => {
    // A skip means nobody dispatched the check. An escalation that ran and
    // could not decide is a different outcome and must not read as the former.
    const plugin = new CouncilVerifierPlugin({
      runner: { ask: async () => ({ status: 'abstained', reason: 'quorum not met' }) },
    });

    const result = await plugin.verify(check, contextWith(oneFile));

    expect(result.status).toBe('error');
    expect(result.error).toContain('quorum not met');
  });

  it('reports a dispatch throw as an error instead of propagating it', async () => {
    const plugin = new CouncilVerifierPlugin({
      runner: {
        ask: async () => {
          throw new Error('all providers exhausted');
        },
      },
    });

    const result = await plugin.verify(check, contextWith(oneFile));

    expect(result.status).toBe('error');
    expect(result.error).toContain('all providers exhausted');
  });

  it('survives a diff failure by treating the panel as unevidenced', async () => {
    const plugin = new CouncilVerifierPlugin({
      runner: { ask: async () => ({ status: 'decided', optionId: 'criterion_met' }) },
    });
    const context = {
      projectRoot: '/fake/project',
      board: {} as never,
      task: { title: 't' } as never,
      diffSince: async () => {
        throw new Error('git unavailable');
      },
    } as unknown as VerificationContext;

    const result = await plugin.verify(check, context);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('no file changes back the verdict');
  });

  it('quotes the observed diff to the panel as untrusted evidence', async () => {
    let seen: { question: string; context?: string | undefined } | undefined;
    const plugin = new CouncilVerifierPlugin({
      runner: {
        ask: async (input) => {
          seen = input;
          return { status: 'decided', optionId: 'criterion_met' };
        },
      },
      profile: 'risk-review',
    });

    await plugin.verify(check, contextWith(oneFile));

    expect(seen?.question).toContain('The retry path is bounded');
    expect(seen?.context).toContain('src/retry.ts');
    expect(seen?.context).toContain('Bound the retry loop');
  });

  it('still reports un-dispatched when constructed without a runner', async () => {
    const result = await new CouncilVerifierPlugin().verify(check, contextWith(oneFile));

    expect(result.status).toBe('skipped');
    expect(result.error).toBe('Council escalation not yet dispatched.');
  });
});
