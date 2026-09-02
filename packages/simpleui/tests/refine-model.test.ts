import { describe, expect, it } from 'vitest';
import {
  normalizedEqual,
  parseFallbackRef,
  projectRefineResult,
  type RefineState,
  resolveEscapeRestore,
  resolveRefineText,
} from '../src/lib/refine-model.js';

function state(overrides: Partial<RefineState> = {}): RefineState {
  return {
    original: 'fix the bug',
    refined: 'fix the bug',
    english: 'fix the bug',
    status: 'refining',
    ...overrides,
  };
}

describe('projectRefineResult', () => {
  it('shows the comparison panel for a real refinement', () => {
    const action = projectRefineResult(
      { refined: 'Fix the null-pointer bug in the parser', english: 'Fix the NPE in the parser' },
      state(),
    );
    expect(action.kind).toBe('panel');
    if (action.kind !== 'panel') throw new Error('expected panel');
    expect(action.state.status).toBe('ready');
    expect(action.state.refined).toBe('Fix the null-pointer bug in the parser');
    expect(action.state.english).toBe('Fix the NPE in the parser');
  });

  it('skips the panel when the refinement is only whitespace/case noise', () => {
    const action = projectRefineResult({ refined: '  Fix   THE bug ', english: 'x' }, state());
    expect(action).toEqual({ kind: 'send', text: 'fix the bug' });
  });

  it('sends the original when the server returns an empty refinement', () => {
    expect(projectRefineResult({ refined: '' }, state())).toEqual({
      kind: 'send',
      text: 'fix the bug',
    });
  });

  it('spends one silent retry on a first timeout', () => {
    const action = projectRefineResult(
      { error: 'timed out', errorKind: 'timeout', retryTimeoutMs: 180_000 },
      state(),
    );
    expect(action.kind).toBe('retry');
    if (action.kind !== 'retry') throw new Error('expected retry');
    expect(action.timeoutMs).toBe(180_000);
    // The retry must be marked spent, or a second timeout would loop forever.
    expect(action.state.retried).toBe(true);
    expect(action.state.status).toBe('refining');
  });

  it('surfaces the recovery panel on a second timeout instead of retrying again', () => {
    const action = projectRefineResult(
      { error: 'timed out', errorKind: 'timeout', retryTimeoutMs: 180_000 },
      state({ retried: true }),
    );
    expect(action.kind).toBe('panel');
    if (action.kind !== 'panel') throw new Error('expected panel');
    expect(action.state.status).toBe('failed');
  });

  it('does not auto-retry a timeout with no server-suggested window', () => {
    const action = projectRefineResult({ error: 'timed out', errorKind: 'timeout' }, state());
    expect(action.kind).toBe('panel');
  });

  it('never silently sends on a provider error — the user decides', () => {
    const action = projectRefineResult(
      { error: 'model unreachable', errorKind: 'provider_error', fallbackRef: 'openai/gpt-4o' },
      state(),
    );
    expect(action.kind).toBe('panel');
    if (action.kind !== 'panel') throw new Error('expected panel');
    expect(action.state.status).toBe('failed');
    expect(action.state.error).toBe('model unreachable');
    expect(action.state.fallbackRef).toBe('openai/gpt-4o');
  });

  it('clears stale failure state when a retry finally succeeds', () => {
    const action = projectRefineResult(
      { refined: 'Fix the parser NPE', english: 'Fix the parser NPE' },
      state({ status: 'failed', error: 'timed out', errorKind: 'timeout', retried: true }),
    );
    if (action.kind !== 'panel') throw new Error('expected panel');
    expect(action.state.error).toBeUndefined();
    expect(action.state.errorKind).toBeUndefined();
  });
});

describe('resolveRefineText', () => {
  const ready = state({ status: 'ready', refined: 'REFINED', english: 'ENGLISH' });

  it('maps each decision to the text it sends', () => {
    expect(resolveRefineText(ready, 'refined')).toBe('REFINED');
    expect(resolveRefineText(ready, 'english')).toBe('ENGLISH');
    expect(resolveRefineText(ready, 'original')).toBe('fix the bug');
  });
});

describe('parseFallbackRef', () => {
  it('splits provider from model', () => {
    expect(parseFallbackRef('openai/gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('splits on the first slash only, so slashed model ids survive', () => {
    expect(parseFallbackRef('openrouter/anthropic/claude-3')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3',
    });
  });

  it('rejects refs with no provider or no model', () => {
    expect(parseFallbackRef('/gpt-4o')).toBeNull();
    expect(parseFallbackRef('openai/')).toBeNull();
    expect(parseFallbackRef('gpt-4o')).toBeNull();
  });
});

describe('normalizedEqual', () => {
  it('ignores case and whitespace runs', () => {
    expect(normalizedEqual('Fix  the BUG', 'fix the bug')).toBe(true);
    expect(normalizedEqual('fix the bug', 'fix the typo')).toBe(false);
  });
});

describe('resolveEscapeRestore', () => {
  it('restores the original into an empty composer', () => {
    expect(resolveEscapeRestore(state(), '')).toBe('fix the bug');
  });

  it('treats a whitespace-only draft as empty and restores', () => {
    expect(resolveEscapeRestore(state(), '   \n\t ')).toBe('fix the bug');
  });

  it('never clobbers text the user typed after the panel opened', () => {
    expect(resolveEscapeRestore(state(), 'a brand new prompt')).toBeNull();
  });

  it('leaves the composer untouched when no panel is open', () => {
    expect(resolveEscapeRestore(null, '')).toBeNull();
  });

  it('returns null for an empty original', () => {
    expect(resolveEscapeRestore(state({ original: '' }), '')).toBeNull();
  });
});
