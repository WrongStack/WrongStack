import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { THINKING_WORD_FIELD, THINKING_WORD_PRESETS } from '../src/components/settings-picker.js';

// Minimal settingsPicker state focused on the thinking-word field (22). Other
// fields are valid filler the reducer doesn't read for these operations.
function settingsBase(overrides: Record<string, unknown> = {}) {
  return {
    settingsPicker: {
      open: true,
      field: THINKING_WORD_FIELD,
      mode: 'off' as const,
      delayMs: 0,
      titleAnimation: true,
      yolo: false,
      fleetChat: 'off',
      chime: false,
      confirmExit: true,
      nextPrediction: false,
      featureMcp: true,
      featurePlugins: true,
      featureMemory: true,
      featureSkills: true,
      featureModelsRegistry: true,
      tokenSavingTier: 'off' as const,
      allowOutsideProjectRoot: true,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60_000,
      enhanceEnabled: true,
      enhanceLanguage: 'original' as const,
      indexOnStart: true,
      thinkingWord: 'thinking',
      thinkingWordEditing: false,
      thinkingWordDraft: '',
      reasoningMode: 'auto' as const,
      reasoningEffort: 'high' as const,
      reasoningPreserve: false,
      cacheTtl: 'default' as const,
      contextAutoCompact: true,
      contextStrategy: 'hybrid' as const,
      contextMode: 'balanced' as const,
      maxConcurrent: 10,
      logLevel: 'info' as const,
      auditLevel: 'standard' as const,
      debugStream: false,
      statuslineMode: 'detailed' as const,
      configScope: 'global' as const,
      hint: undefined as string | undefined,
      ...overrides,
    },
  };
}

const base = (overrides: Record<string, unknown> = {}) =>
  ({ ...settingsBase(overrides) }) as never as Parameters<typeof reducer>[0];

describe('thinking word — preset cycling (←/→)', () => {
  it('cycles forward through the preset list', () => {
    let s = base({ thinkingWord: THINKING_WORD_PRESETS[0] });
    for (let i = 0; i < THINKING_WORD_PRESETS.length; i++) {
      expect(s.settingsPicker.thinkingWord).toBe(THINKING_WORD_PRESETS[i]);
      s = reducer(s, { type: 'settingsValueChange', delta: 1 });
    }
    // wraps back to the first preset
    expect(s.settingsPicker.thinkingWord).toBe(THINKING_WORD_PRESETS[0]);
  });

  it('cycles backward and wraps to the last preset', () => {
    const s = reducer(base({ thinkingWord: THINKING_WORD_PRESETS[0] }), {
      type: 'settingsValueChange',
      delta: -1,
    });
    expect(s.settingsPicker.thinkingWord).toBe(
      THINKING_WORD_PRESETS[THINKING_WORD_PRESETS.length - 1],
    );
  });

  it('folds a custom word into the list so cycling never drops it', () => {
    // custom value not in presets — forward lands on the first preset…
    const fwd = reducer(base({ thinkingWord: 'banana' }), {
      type: 'settingsValueChange',
      delta: 1,
    });
    expect(fwd.settingsPicker.thinkingWord).toBe(THINKING_WORD_PRESETS[0]);
    // …and backward lands on the last preset.
    const back = reducer(base({ thinkingWord: 'banana' }), {
      type: 'settingsValueChange',
      delta: -1,
    });
    expect(back.settingsPicker.thinkingWord).toBe(
      THINKING_WORD_PRESETS[THINKING_WORD_PRESETS.length - 1],
    );
  });

  it('keeps thinking-word and reasoning-mode field indices independent', () => {
    expect(THINKING_WORD_FIELD).toBe(22);

    const s = reducer(base({ field: 23, thinkingWord: 'thinking', reasoningMode: 'auto' }), {
      type: 'settingsValueChange',
      delta: 1,
    });

    expect(s.settingsPicker.thinkingWord).toBe('thinking');
    expect(s.settingsPicker.reasoningMode).toBe('on');
  });
});

describe('thinking word — free-text editing (Enter)', () => {
  it('start seeds the draft with the current word and enters edit mode', () => {
    const s = reducer(base({ thinkingWord: 'cooking' }), {
      type: 'settingsThinkingEditStart',
    });
    expect(s.settingsPicker.thinkingWordEditing).toBe(true);
    expect(s.settingsPicker.thinkingWordDraft).toBe('cooking');
  });

  it('change updates the draft and caps it at the max length', () => {
    const long = 'x'.repeat(40);
    const s = reducer(base({ thinkingWordEditing: true }), {
      type: 'settingsThinkingEditChange',
      draft: long,
    });
    expect(s.settingsPicker.thinkingWordDraft.length).toBe(16);
  });

  it('commit applies a valid draft, clears edit mode, no hint', () => {
    const s = reducer(
      base({ thinkingWord: 'thinking', thinkingWordEditing: true, thinkingWordDraft: 'vibing' }),
      {
        type: 'settingsThinkingEditCommit',
      },
    );
    expect(s.settingsPicker.thinkingWord).toBe('vibing');
    expect(s.settingsPicker.thinkingWordEditing).toBe(false);
    expect(s.settingsPicker.thinkingWordDraft).toBe('');
    expect(s.settingsPicker.hint).toBeUndefined();
  });

  it('commit of an empty draft keeps the current word (treated as cancel)', () => {
    const s = reducer(
      base({ thinkingWord: 'cooking', thinkingWordEditing: true, thinkingWordDraft: '   ' }),
      {
        type: 'settingsThinkingEditCommit',
      },
    );
    expect(s.settingsPicker.thinkingWord).toBe('cooking');
    expect(s.settingsPicker.thinkingWordEditing).toBe(false);
    expect(s.settingsPicker.hint).toBeUndefined();
  });

  it('commit of an invalid draft keeps the word and surfaces a hint', () => {
    const s = reducer(
      base({ thinkingWord: 'cooking', thinkingWordEditing: true, thinkingWordDraft: 'two words' }),
      {
        type: 'settingsThinkingEditCommit',
      },
    );
    expect(s.settingsPicker.thinkingWord).toBe('cooking'); // unchanged
    expect(s.settingsPicker.thinkingWordEditing).toBe(false);
    expect(s.settingsPicker.hint).toMatch(/invalid/i);
  });

  it('cancel discards the draft and leaves the word unchanged', () => {
    const s = reducer(
      base({ thinkingWord: 'cooking', thinkingWordEditing: true, thinkingWordDraft: 'zzz' }),
      {
        type: 'settingsThinkingEditCancel',
      },
    );
    expect(s.settingsPicker.thinkingWord).toBe('cooking');
    expect(s.settingsPicker.thinkingWordEditing).toBe(false);
    expect(s.settingsPicker.thinkingWordDraft).toBe('');
  });

  it('moving field focus abandons an in-progress edit', () => {
    const s = reducer(base({ thinkingWordEditing: true, thinkingWordDraft: 'partial' }), {
      type: 'settingsFieldMove',
      delta: 1,
    });
    expect(s.settingsPicker.thinkingWordEditing).toBe(false);
    expect(s.settingsPicker.thinkingWordDraft).toBe('');
  });
});
