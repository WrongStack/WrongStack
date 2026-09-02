import { describe, expect, it } from 'vitest';
import {
  formatClearAllowlistDialogBody,
  formatClearAllowlistToast,
  shouldFireUndoToast,
  shouldOfferClear,
} from '../../src/components/SettingsPanel/ProviderModelsPanel.filter';
import type { SavedProvider } from '../../src/components/SettingsPanel/ProviderSection';
import {
  applyClearModels,
  applyUndoClear,
  shouldOfferClearFromSaved,
} from '../../src/components/SettingsPanel/settings-panel-reducers';
import { resolveUndoSend } from '../../src/components/SettingsPanel/undo-send-decision';

/**
 * Tests for the new "Clear allowlist" two-step UX:
 *   1. A confirmation dialog (`<ClearAllowlistDialog>`)
 *   2. An undo toast with `provider.update` reapplier
 *
 * The dialog is presentational; the toast decision is driven by
 * the filter helpers. The parent (`<SettingsPanel>`) owns the
 * `setSavedProviders` reducer, so we extract the pure
 * transformations (`applyClearModels`, `applyUndoClear`) into
 * `settings-panel-reducers.ts` and test them here.
 *
 * The component itself (dialog open/close, toast firing, keyboard
 * shortcuts) is exercised by the browser/typecheck — these tests
 * pin down the data-shaping and the textual contract.
 */

describe('shouldOfferClear (visibility of the "Clear allowlist" button)', () => {
  it('returns true when there is at least one pinned model', () => {
    expect(shouldOfferClear(['a'])).toBe(true);
    expect(shouldOfferClear(['a', 'b', 'c'])).toBe(true);
  });

  it('returns false when the saved list is undefined or empty', () => {
    expect(shouldOfferClear(undefined)).toBe(false);
    expect(shouldOfferClear([])).toBe(false);
  });
});

describe('shouldFireUndoToast (whether to show the undo affordance)', () => {
  it('returns true exactly when there is something to undo', () => {
    expect(shouldFireUndoToast(['a'])).toBe(true);
    expect(shouldFireUndoToast(['a', 'b', 'c'])).toBe(true);
  });

  it('returns false on an empty list', () => {
    expect(shouldFireUndoToast([])).toBe(false);
  });
});

describe('formatClearAllowlistToast (toast message text)', () => {
  it('includes the provider id and the removed count', () => {
    expect(formatClearAllowlistToast('ollama', 3)).toContain('ollama');
    expect(formatClearAllowlistToast('ollama', 3)).toContain('3');
  });

  it('uses "model" (singular) for a single removed model', () => {
    const text = formatClearAllowlistToast('ollama', 1);
    expect(text).toMatch(/\b1 model\b/);
    expect(text).not.toMatch(/\bmodels\b/);
  });

  it('uses "models" (plural) for zero or many removed models', () => {
    expect(formatClearAllowlistToast('ollama', 0)).toMatch(/\b0 models\b/);
    expect(formatClearAllowlistToast('ollama', 2)).toMatch(/\b2 models\b/);
    expect(formatClearAllowlistToast('ollama', 7)).toMatch(/\b7 models\b/);
  });
});

describe('formatClearAllowlistDialogBody (dialog description text)', () => {
  it('includes the pinned count and the provider id', () => {
    const body = formatClearAllowlistDialogBody('ollama', 3);
    expect(body).toContain('3');
    expect(body).toContain('ollama');
    expect(body).toContain('models.dev');
  });

  it('uses "model" (singular) for one pinned model', () => {
    const body = formatClearAllowlistDialogBody('vllm', 1);
    expect(body).toMatch(/\b1 pinned model\b/);
    expect(body).not.toMatch(/\bpinned models\b/);
  });

  it('uses "models" (plural) for zero or many pinned models', () => {
    expect(formatClearAllowlistDialogBody('vllm', 0)).toMatch(/\b0 pinned models\b/);
    expect(formatClearAllowlistDialogBody('vllm', 5)).toMatch(/\b5 pinned models\b/);
  });
});

describe('shouldOfferClearFromSaved (parent-level "did anything change?" check)', () => {
  it('returns true when the provider has any saved models', () => {
    expect(shouldOfferClearFromSaved({ id: 'a', models: ['x'] })).toBe(true);
    expect(shouldOfferClearFromSaved({ id: 'a', pickedModelId: 'x', models: ['x', 'y'] })).toBe(
      true,
    );
  });

  it('returns false when the saved provider has no allowlist', () => {
    expect(shouldOfferClearFromSaved({ id: 'a', models: [] })).toBe(false);
    expect(shouldOfferClearFromSaved({ id: 'a', models: undefined })).toBe(false);
  });
});

function saved(overrides: Partial<SavedProvider>): SavedProvider {
  return {
    id: 'ollama',
    family: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    apiKeys: [],
    ...overrides,
  };
}

describe('applyClearModels (parent reducer: drop models + pickedModelId)', () => {
  it('returns a new array (immutability)', () => {
    const before = [saved({ id: 'a', models: ['x'], pickedModelId: 'x' })];
    const after = applyClearModels(before, 'a');
    expect(after).not.toBe(before);
  });

  it('drops models and pickedModelId for the targeted provider only', () => {
    const before = [
      saved({ id: 'a', models: ['x', 'y'], pickedModelId: 'x' }),
      saved({ id: 'b', models: ['z'], pickedModelId: 'z' }),
    ];
    const after = applyClearModels(before, 'a');
    expect(after[0]?.id).toBe('a');
    expect(after[0]?.models).toBeUndefined();
    expect(after[0]?.pickedModelId).toBeUndefined();
    // Untouched provider
    expect(after[1]?.id).toBe('b');
    expect(after[1]?.models).toEqual(['z']);
    expect(after[1]?.pickedModelId).toBe('z');
  });

  it('preserves apiKeys (destructive action must not nuke auth state)', () => {
    const before = [
      saved({
        id: 'a',
        models: ['x'],
        pickedModelId: 'x',
        apiKeys: [
          { label: 'default', maskedKey: 'sk-v…1234', isActive: true, createdAt: '2025-01-01' },
        ],
      }),
    ];
    const after = applyClearModels(before, 'a');
    expect(after[0]?.apiKeys).toHaveLength(1);
    expect(after[0]?.apiKeys[0]?.label).toBe('default');
  });

  it('is a no-op for a non-existent provider id', () => {
    const before = [saved({ id: 'a', models: ['x'], pickedModelId: 'x' })];
    const after = applyClearModels(before, 'ghost');
    expect(after).toEqual(before);
  });
});

describe('applyUndoClear (parent reducer: restore previous models + picked id)', () => {
  it('restores models and sets pickedModelId to the first id', () => {
    const before = [saved({ id: 'a', models: [], pickedModelId: undefined })];
    const after = applyUndoClear(before, 'a', ['llama3.1:8b', 'qwen2.5:7b']);
    expect(after[0]?.models).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
    expect(after[0]?.pickedModelId).toBe('llama3.1:8b');
  });

  it('returns a new array and a new provider object (no in-place mutation)', () => {
    const before = [saved({ id: 'a', models: [] })];
    const after = applyUndoClear(before, 'a', ['x']);
    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]?.models).not.toBe(before[0]?.models);
  });

  it('defensive-copies the input list (caller mutation does not leak)', () => {
    const before = [saved({ id: 'a', models: [] })];
    const input = ['x', 'y'];
    const after = applyUndoClear(before, 'a', input);
    input.push('z');
    expect(after[0]?.models).toEqual(['x', 'y']);
  });

  it('handles an empty previous list (defensive: no pickedModelId set)', () => {
    const before = [saved({ id: 'a', models: [] })];
    const after = applyUndoClear(before, 'a', []);
    expect(after[0]?.models).toEqual([]);
    expect(after[0]?.pickedModelId).toBeUndefined();
  });

  it('only affects the targeted provider', () => {
    const before = [
      saved({ id: 'a', models: [] }),
      saved({ id: 'b', models: ['z'], pickedModelId: 'z' }),
    ];
    const after = applyUndoClear(before, 'a', ['x']);
    expect(after[0]?.models).toEqual(['x']);
    expect(after[0]?.pickedModelId).toBe('x');
    // Untouched
    expect(after[1]?.models).toEqual(['z']);
    expect(after[1]?.pickedModelId).toBe('z');
  });
});

describe('resolveUndoSend (toast → WS decision)', () => {
  it('returns kind:"skip" when previousModels is empty', () => {
    expect(
      resolveUndoSend({
        providerId: 'a',
        previousModels: [],
        onUndoClear: undefined,
      }),
    ).toEqual({ kind: 'skip' });
  });

  it('returns kind:"skip" even when onUndoClear is supplied (empty list wins)', () => {
    expect(
      resolveUndoSend({
        providerId: 'a',
        previousModels: [],
        onUndoClear: () => {},
      }),
    ).toEqual({ kind: 'skip' });
  });

  it('returns kind:"callback" when onUndoClear is supplied and there is something to restore', () => {
    const cb = () => {};
    const d = resolveUndoSend({
      providerId: 'ollama',
      previousModels: ['x', 'y'],
      onUndoClear: cb,
    });
    expect(d).toEqual({
      kind: 'callback',
      providerId: 'ollama',
      previousModels: ['x', 'y'],
    });
  });

  it('returns kind:"ws-default" with the dedicated undoProviderClear route when no callback is supplied', () => {
    const d = resolveUndoSend({
      providerId: 'ollama',
      previousModels: ['x', 'y'],
      onUndoClear: undefined,
    });
    // The pin: the default route is always the dedicated
    // `provider.undo_clear` message (via `ws.undoProviderClear`),
    // never a generic `provider.update`. This is what the audit
    // log relies on for the "user undid a clear" category.
    expect(d).toEqual({
      kind: 'ws-default',
      providerId: 'ollama',
      previousModels: ['x', 'y'],
    });
  });

  it('preserves the previousModels list verbatim (no copy / no dedup at this layer)', () => {
    const d = resolveUndoSend({
      providerId: 'a',
      previousModels: ['z', 'y', 'x'],
      onUndoClear: undefined,
    });
    if (d.kind === 'ws-default') {
      expect(d.previousModels).toEqual(['z', 'y', 'x']);
    } else {
      throw new Error(`unexpected kind: ${d.kind}`);
    }
  });
});
