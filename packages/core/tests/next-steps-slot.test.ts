import { isFinalTurnStopReason, parseNextSteps } from '@wrongstack/tools/next-steps';
import { describe, expect, it } from 'vitest';
import {
  clearPendingNextSteps,
  hasNextStepsTag,
  MAX_PENDING_NEXT_STEPS,
  maybeAppendPendingNextSteps,
  type PendingNextStep,
  readPendingNextSteps,
  renderNextStepsBlock,
  writePendingNextSteps,
} from '../src/core/next-steps-slot.js';
import type { Context } from '../src/core/context.js';
import type { Response } from '../src/types/provider.js';

/**
 * `core` cannot import the parser (package DAG), so this module re-derives the
 * tag shape. These tests are what keeps the two halves honest: everything the
 * renderer emits is fed through the real `parseNextSteps` from `@wrongstack/tools`.
 */

type SlotCtx = Pick<Context, 'meta' | 'agentId' | 'todos' | 'signal'>;

function ctx(overrides: Partial<SlotCtx> = {}): SlotCtx {
  return {
    meta: {},
    agentId: 'leader',
    todos: [],
    signal: new AbortController().signal,
    ...overrides,
  } as SlotCtx;
}

function res(text: string, stopReason: Response['stopReason'] = 'end_turn'): Response {
  return {
    content: text ? [{ type: 'text', text }] : [],
    stopReason,
    usage: { input: 0, output: 0 },
    model: 'test-model',
  } as Response;
}

function textOf(r: Response): string {
  return r.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

describe('renderNextStepsBlock ↔ parseNextSteps round-trip', () => {
  it('produces a block the canonical parser accepts verbatim', () => {
    const steps: PendingNextStep[] = [
      { text: 'Run the parser tests and fix any failures' },
      { text: 'Review the diff for regressions' },
    ];
    const parsed = parseNextSteps(renderNextStepsBlock(steps));
    expect(parsed.texts).toEqual([
      'Run the parser tests and fix any failures',
      'Review the diff for regressions',
    ]);
  });

  it('carries auto="true" through the parser on the first item only', () => {
    const rendered = renderNextStepsBlock([
      { text: 'Run the test suite', auto: true },
      { text: 'Update the docs' },
    ]);
    const parsed = parseNextSteps(rendered);
    expect(parsed.autoTexts).toEqual(['Run the test suite']);
    // The marker must not leak into the visible item text.
    expect(parsed.texts).toEqual(['Run the test suite', 'Update the docs']);
  });

  it('renders no auto marker when the slot dropped it from a later item', () => {
    const c = ctx();
    writePendingNextSteps(c, [{ text: 'First' }, { text: 'Second', auto: true }]);
    const parsed = parseNextSteps(renderNextStepsBlock(readPendingNextSteps(c)!));
    expect(parsed.autoTexts).toEqual([]);
  });

  it('leaves the prose before the block intact once the parser strips it', () => {
    const body = 'Done — the parser now rejects unbalanced blocks.';
    const appended = `${body}\n\n${renderNextStepsBlock([{ text: 'Run the tests' }])}`;
    expect(parseNextSteps(appended).stripped).toBe(body);
  });

  it('agrees with the parser about what counts as an existing block', () => {
    const rendered = renderNextStepsBlock([{ text: 'Run the tests' }]);
    expect(hasNextStepsTag(rendered)).toBe(true);
    expect(hasNextStepsTag('no suggestions here')).toBe(false);
    // The parser tolerates attributes on the opening tag; so must the detector,
    // or a malformed model block would be duplicated rather than respected.
    expect(hasNextStepsTag('<nextsteps auto="true">\n1. x\n</nextsteps>')).toBe(true);
  });
});

describe('slot access', () => {
  it('normalizes text and keeps auto on the first item only', () => {
    const c = ctx();
    writePendingNextSteps(c, [
      { text: '  Run   the tests  ', auto: true },
      { text: 'Second', auto: true },
    ]);
    expect(readPendingNextSteps(c)).toEqual([
      { text: 'Run the tests', auto: true },
      { text: 'Second' },
    ]);
  });

  it('drops empty items and clears the slot when nothing survives', () => {
    const c = ctx();
    writePendingNextSteps(c, [{ text: '   ' }, { text: '' }]);
    expect(readPendingNextSteps(c)).toBeUndefined();
  });

  it('caps the list at MAX_PENDING_NEXT_STEPS', () => {
    const c = ctx();
    writePendingNextSteps(
      c,
      Array.from({ length: MAX_PENDING_NEXT_STEPS + 3 }, (_, i) => ({ text: `Step ${i + 1}` })),
    );
    expect(readPendingNextSteps(c)).toHaveLength(MAX_PENDING_NEXT_STEPS);
  });

  it('replaces rather than appends on a second write', () => {
    const c = ctx();
    writePendingNextSteps(c, [{ text: 'First plan' }]);
    writePendingNextSteps(c, [{ text: 'Changed my mind' }]);
    expect(readPendingNextSteps(c)).toEqual([{ text: 'Changed my mind' }]);
  });

  it('clears the slot', () => {
    const c = ctx();
    writePendingNextSteps(c, [{ text: 'Run the tests' }]);
    clearPendingNextSteps(c);
    expect(readPendingNextSteps(c)).toBeUndefined();
  });
});

describe('maybeAppendPendingNextSteps', () => {
  it('appends to the last text block and empties the slot', () => {
    const c = ctx();
    writePendingNextSteps(c, [{ text: 'Run the parser tests' }]);
    const out = maybeAppendPendingNextSteps(c, res('All done.'));

    expect(parseNextSteps(textOf(out)).texts).toEqual(['Run the parser tests']);
    // Appended, never prepended: the WebUI only adopts a canonical response
    // that strictly extends the text it already streamed.
    expect(textOf(out).startsWith('All done.')).toBe(true);
    expect(readPendingNextSteps(c)).toBeUndefined();
  });

  it('leaves the response untouched when the slot is empty', () => {
    const c = ctx();
    const input = res('All done.');
    expect(maybeAppendPendingNextSteps(c, input)).toBe(input);
  });

  it('does not append for a subagent', () => {
    const c = ctx({ agentId: 'executor' });
    writePendingNextSteps(c, [{ text: 'Run the tests' }]);
    expect(textOf(maybeAppendPendingNextSteps(c, res('Done.')))).toBe('Done.');
  });

  it.each(['tool_use', 'tool_call'] as const)(
    'does not append mid-turn (stopReason=%s)',
    (stopReason) => {
      const c = ctx();
      writePendingNextSteps(c, [{ text: 'Run the tests' }]);
      const out = maybeAppendPendingNextSteps(c, res('Let me check.', stopReason as never));
      expect(textOf(out)).toBe('Let me check.');
      // The steps survive for the response that actually ends the turn.
      expect(readPendingNextSteps(c)).toEqual([{ text: 'Run the tests' }]);
    },
  );

  it('does not append when the run was aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const c = ctx({ signal: controller.signal });
    writePendingNextSteps(c, [{ text: 'Run the tests' }]);
    expect(textOf(maybeAppendPendingNextSteps(c, res('Partial…')))).toBe('Partial…');
  });

  it('drops the steps while todos are still open', () => {
    const c = ctx({
      todos: [{ id: '1', content: 'Finish the migration', status: 'in_progress' }],
    } as Partial<SlotCtx>);
    writePendingNextSteps(c, [{ text: 'Run the tests' }]);
    const out = maybeAppendPendingNextSteps(c, res('Progress update.'));
    expect(textOf(out)).toBe('Progress update.');
    // Dropped, not held: they would be stale by the time the todos close.
    expect(readPendingNextSteps(c)).toBeUndefined();
  });

  it('yields to a block the model wrote itself', () => {
    const c = ctx();
    writePendingNextSteps(c, [{ text: 'From the tool' }]);
    const typed = `Done.\n\n${renderNextStepsBlock([{ text: 'From the message' }])}`;
    const out = maybeAppendPendingNextSteps(c, res(typed));

    expect(parseNextSteps(textOf(out)).texts).toEqual(['From the message']);
    expect(readPendingNextSteps(c)).toBeUndefined();
  });

  it('adds a text block when the turn ended without prose', () => {
    const c = ctx();
    writePendingNextSteps(c, [{ text: 'Run the tests' }]);
    const out = maybeAppendPendingNextSteps(c, res(''));
    expect(parseNextSteps(textOf(out)).texts).toEqual(['Run the tests']);
  });

  it('does not mutate the response it was given', () => {
    const c = ctx();
    writePendingNextSteps(c, [{ text: 'Run the tests' }]);
    const input = res('All done.');
    const out = maybeAppendPendingNextSteps(c, input);
    expect(out).not.toBe(input);
    expect(textOf(input)).toBe('All done.');
  });

  // `endsTurn()` in next-steps-slot.ts hand-duplicates `isFinalTurnStopReason`
  // from `@wrongstack/tools/next-steps` because core cannot import tools in
  // its source DAG (tests can). This pins the two in lockstep through the
  // slot's observable behavior: the block is appended iff the stop reason is
  // final. If either side changes alone, this fails.
  it.each(['tool_use', 'tool_call', 'end_turn', 'stop', 'max_tokens', undefined] as const)(
    'endsTurn matches isFinalTurnStopReason (stopReason=%s)',
    (stopReason) => {
      const c = ctx();
      writePendingNextSteps(c, [{ text: 'Run the tests' }]);
      const out = maybeAppendPendingNextSteps(c, res('Prose.', stopReason as never));
      const appended = textOf(out).includes('<nextsteps>');
      expect(appended).toBe(isFinalTurnStopReason(stopReason));
    },
  );
});
