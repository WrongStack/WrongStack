/**
 * Unit tests for the autonomous continue feature:
 * parseContinueDirective(), makeContinueToNextIterationTool().
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  parseContinueDirective,
  makeContinueToNextIterationTool,
  setAutonomousContinue,
  clearAutonomousContinue,
  consumeAutonomousContinue,
} from '../../src/core/continue-to-next-iteration.js';
import { Context } from '../../src/core/context.js';

// ---------------------------------------------------------------------------
// parseContinueDirective()
// ---------------------------------------------------------------------------

describe('parseContinueDirective', () => {
  it('returns none for empty string', () => {
    expect(parseContinueDirective('')).toBe('none');
  });

  it('returns none for plain text without markers', () => {
    expect(parseContinueDirective('Hello world, no markers here')).toBe('none');
  });

  it('ignores markers embedded in sentences', () => {
    // The marker must be on its own line — embedded in text is ignored
    expect(parseContinueDirective('Remember to use [continue] in your summary')).toBe('none');
  });

  it('returns continue for [continue] on its own line', () => {
    expect(parseContinueDirective('[continue]')).toBe('continue');
  });

  it('returns continue for [continue] with leading whitespace', () => {
    expect(parseContinueDirective('  [continue]  ')).toBe('continue');
  });

  it('returns continue for [continue] indented inside block', () => {
    const text = `Done with step 1.
  [continue]
Proceeding to step 2.`;
    expect(parseContinueDirective(text)).toBe('continue');
  });

  it('returns continue for [next step]', () => {
    expect(parseContinueDirective('[next step]')).toBe('continue');
  });

  it('returns continue for [proceed]', () => {
    expect(parseContinueDirective('[proceed]')).toBe('continue');
  });

  it('returns stop for [done]', () => {
    expect(parseContinueDirective('[done]')).toBe('stop');
  });

  it('is case-insensitive', () => {
    expect(parseContinueDirective('[CONTINUE]')).toBe('continue');
    expect(parseContinueDirective('[Done]')).toBe('stop');
    expect(parseContinueDirective('[Next Step]')).toBe('continue');
  });

  it('rightmost marker wins when multiple appear', () => {
    // If model accidentally emits [continue] then [done], stop takes priority
    expect(parseContinueDirective('[continue]\n[done]')).toBe('stop');
    expect(parseContinueDirective('[done]\n[continue]')).toBe('continue');
  });

  it('returns continue when only [proceed] appears', () => {
    expect(parseContinueDirective('All done.\n[proceed]\n')).toBe('continue');
  });

  it('multiline: marker in middle of text, rest of text preserved', () => {
    // The parser only cares about whether a directive was found, not content
    expect(parseContinueDirective('Step 1 complete.\n[continue]\nStep 2 starting.')).toBe(
      'continue',
    );
  });
});

// ---------------------------------------------------------------------------
// makeContinueToNextIterationTool()
// ---------------------------------------------------------------------------

describe('makeContinueToNextIterationTool', () => {
  it('has correct name and metadata', () => {
    const tool = makeContinueToNextIterationTool();
    expect(tool.name).toBe('continue_to_next_iteration');
    expect(tool.permission).toBe('auto');
    expect(tool.mutating).toBe(false);
    expect(tool.inputSchema.required).toEqual([]);
  });

  it('returns { continue: true }', async () => {
    const tool = makeContinueToNextIterationTool();
    // Minimal context — only meta is needed
    const ctx = new Context({
      systemPrompt: [],
      provider: null as never,
      session: { id: 'x', pendingToolUses: [], append: async () => {}, flush: async () => {} },
      signal: new AbortController().signal,
      tokenCounter: { account: () => {} } as never,
      cwd: '/tmp',
      projectRoot: '/tmp',
      model: 'test',
    });
    const result = await tool.execute({}, ctx);
    expect(result).toEqual({ continue: true });
  });

  it('sets _autonomousContinue in ctx.meta', async () => {
    const tool = makeContinueToNextIterationTool();
    const ctx = new Context({
      systemPrompt: [],
      provider: null as never,
      session: { id: 'x', pendingToolUses: [], append: async () => {}, flush: async () => {} },
      signal: new AbortController().signal,
      tokenCounter: { account: () => {} } as never,
      cwd: '/tmp',
      projectRoot: '/tmp',
      model: 'test',
    });
    await tool.execute({}, ctx);
    expect(ctx.meta['_autonomousContinue']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Meta key helpers
// ---------------------------------------------------------------------------

describe('autonomous continue meta helpers', () => {
  let ctx: Context;

  beforeEach(() => {
    ctx = new Context({
      systemPrompt: [],
      provider: null as never,
      session: { id: 'x', pendingToolUses: [], append: async () => {}, flush: async () => {} },
      signal: new AbortController().signal,
      tokenCounter: { account: () => {} } as never,
      cwd: '/tmp',
      projectRoot: '/tmp',
      model: 'test',
    });
  });

  it('clearAutonomousContinue removes the key', () => {
    setAutonomousContinue(ctx);
    expect(ctx.meta['_autonomousContinue']).toBe(true);
    clearAutonomousContinue(ctx);
    expect(ctx.meta['_autonomousContinue']).toBeUndefined();
  });

  it('consumeAutonomousContinue returns true and clears the flag', () => {
    setAutonomousContinue(ctx);
    expect(consumeAutonomousContinue(ctx)).toBe(true);
    expect(ctx.meta['_autonomousContinue']).toBeUndefined();
  });

  it('consumeAutonomousContinue returns false when flag not set', () => {
    expect(consumeAutonomousContinue(ctx)).toBe(false);
    expect(ctx.meta['_autonomousContinue']).toBeUndefined();
  });

  it('setAutonomousContinue sets the flag idempotently', () => {
    setAutonomousContinue(ctx);
    setAutonomousContinue(ctx);
    expect(ctx.meta['_autonomousContinue']).toBe(true);
  });
});
