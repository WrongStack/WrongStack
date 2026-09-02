import { describe, expect, it } from 'vitest';
import {
  filterRefineModels,
  type RefineFailureModel,
} from '../src/components/refine-failure-panel.js';

/**
 * Pure-logic tests for the search filter used by the TUI refine-failure
 * panel's "pick another model" view. Mirrors the WebUI QuickModelSwitcher
 * search semantics: case-insensitive substring across providerId / model
 * / label, empty/whitespace queries return the full list.
 *
 * Why a dedicated file: `ink-testing-library` does not reliably deliver
 * `stdin.write()` keystrokes to a component mounted with `useInput`
 * already in pick view (the `'data'` event listener is re-registered
 * on every render). The component's render layer delegates to this
 * pure helper, so exercising the helper directly gives us full coverage
 * of the user-visible filter behavior without the flake.
 */

const models: RefineFailureModel[] = [
  { providerId: 'anthropic', model: 'claude-3-5-sonnet', label: 'Sonnet' },
  { providerId: 'anthropic', model: 'claude-3-5-haiku', label: 'Haiku' },
  { providerId: 'openai', model: 'gpt-4o' },
  { providerId: 'openai', model: 'gpt-4o-mini' },
  { providerId: 'google', model: 'gemini-2-0-flash' },
];

describe('filterRefineModels', () => {
  it('returns the input list when query is empty', () => {
    expect(filterRefineModels(models, '')).toEqual(models);
  });

  it('returns the input list when query is whitespace only', () => {
    expect(filterRefineModels(models, '   ')).toEqual(models);
  });

  it('matches by model id substring', () => {
    const out = filterRefineModels(models, 'haiku');
    expect(out).toHaveLength(1);
    expect(out[0]?.model).toBe('claude-3-5-haiku');
  });

  it('matches by provider id substring', () => {
    const out = filterRefineModels(models, 'open');
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.providerId === 'openai')).toBe(true);
  });

  it('matches by label substring', () => {
    const out = filterRefineModels(models, 'sonnet');
    expect(out).toHaveLength(1);
    expect(out[0]?.model).toBe('claude-3-5-sonnet');
  });

  it('is case-insensitive', () => {
    const upper = filterRefineModels(models, 'GEMINI');
    const lower = filterRefineModels(models, 'gemini');
    expect(upper).toEqual(lower);
    expect(upper).toHaveLength(1);
    expect(upper[0]?.model).toBe('gemini-2-0-flash');
  });

  it('returns empty list when nothing matches', () => {
    expect(filterRefineModels(models, 'zzz-no-match')).toEqual([]);
  });

  it('trims surrounding whitespace from the query', () => {
    const out = filterRefineModels(models, '  gpt  ');
    expect(out.map((m) => m.model)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('does not crash when a row has no label', () => {
    const noLabels: RefineFailureModel[] = [
      { providerId: 'openai', model: 'gpt-4o' },
      { providerId: 'openai', model: 'gpt-4o-mini' },
    ];
    expect(() => filterRefineModels(noLabels, 'gpt')).not.toThrow();
    expect(filterRefineModels(noLabels, 'gpt')).toHaveLength(2);
  });

  it('preserves the input list order (no re-sort)', () => {
    const out = filterRefineModels(models, 'anthropic');
    expect(out.map((m) => m.model)).toEqual(['claude-3-5-sonnet', 'claude-3-5-haiku']);
  });

  it('returns the same array reference for empty queries (cheap path)', () => {
    // Avoids unnecessary allocations on every keystroke that produces
    // an all-whitespace query. The component does filtered.length math
    // on each render, so even a one-off equality check matters.
    expect(filterRefineModels(models, '')).toBe(models);
    expect(filterRefineModels(models, '   ')).toBe(models);
  });
});
