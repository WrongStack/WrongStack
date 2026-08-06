import { readPendingNextSteps } from '@wrongstack/core/agent';
import { describe, expect, it } from 'vitest';
import { nextStepsTool } from '../src/next-steps-tool.js';

/**
 * The tool's whole job is to park a normalized list in the turn slot. The
 * normalization rules live in core (`next-steps-slot.ts`) so both writers share
 * them; these tests pin the tool's contract on top of that.
 */

function ctx(): { meta: Record<string, unknown> } {
  return { meta: {} };
}

function run(input: unknown, c = ctx()) {
  // The tool only touches `ctx.meta`; the rest of Context is irrelevant here.
  return nextStepsTool.execute(input as never, c as never);
}

describe('nextStepsTool', () => {
  it('parks the steps and reports how many were accepted', async () => {
    const c = ctx();
    const out = await run({ steps: [{ text: 'Run the tests' }, { text: 'Update the docs' }] }, c);

    expect(out).toEqual({ accepted: 2, auto: false });
    expect(readPendingNextSteps(c as never)).toEqual([
      { text: 'Run the tests' },
      { text: 'Update the docs' },
    ]);
  });

  it('honors auto on the first item', async () => {
    const c = ctx();
    const out = await run({ steps: [{ text: 'Run the tests', auto: true }] }, c);

    expect(out).toEqual({ accepted: 1, auto: true });
    expect(readPendingNextSteps(c as never)).toEqual([{ text: 'Run the tests', auto: true }]);
  });

  it('ignores auto on a later item', async () => {
    const c = ctx();
    await run({ steps: [{ text: 'First' }, { text: 'Second', auto: true }] }, c);

    expect(readPendingNextSteps(c as never)).toEqual([{ text: 'First' }, { text: 'Second' }]);
  });

  it('replaces the previous list when called twice in a turn', async () => {
    const c = ctx();
    await run({ steps: [{ text: 'First plan' }, { text: 'Also this' }] }, c);
    await run({ steps: [{ text: 'Changed my mind' }] }, c);

    expect(readPendingNextSteps(c as never)).toEqual([{ text: 'Changed my mind' }]);
  });

  it('rejects a non-array steps value', async () => {
    await expect(run({ steps: 'run the tests' })).rejects.toThrow(/steps must be an array/);
    await expect(run({})).rejects.toThrow(/steps must be an array/);
  });

  it('rejects a list with no usable item', async () => {
    await expect(run({ steps: [{ auto: true }, { text: 42 }] })).rejects.toThrow(
      /at least one item/,
    );
  });

  it('is leader-safe metadata: auto permission, non-mutating, own capability', () => {
    expect(nextStepsTool.name).toBe('nextsteps');
    expect(nextStepsTool.permission).toBe('auto');
    expect(nextStepsTool.mutating).toBe(false);
    expect(nextStepsTool.capabilities).toEqual(['session.nextsteps']);
  });

  it('caps the schema at the same number of items the slot keeps', () => {
    const steps = nextStepsTool.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(steps['steps']?.['maxItems']).toBe(4);
    expect(steps['steps']?.['minItems']).toBe(1);
  });
});
