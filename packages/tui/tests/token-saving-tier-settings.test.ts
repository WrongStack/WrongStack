import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import {
  DELAY_PRESETS_MS,
  ENHANCE_DELAY_PRESETS,
  TOKEN_SAVING_TIERS,
} from '../src/components/settings-picker.js';

// Minimal settingsPicker with all required fields for the token-saving tier tests.
// The reducer only reads/writes tokenSavingTier for field-13 operations, so
// other fields can be any valid value.
function settingsBase(overrides: Record<string, unknown> = {}) {
  return {
    settingsPicker: {
      open: true,
      field: 13, // token-saving tier field
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
      multiDiffSummaryThreshold: 5,
      thinkingWord: 'thinking',
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

describe('token-saving tier in settings picker', () => {
  it('settingsOpen initialises tokenSavingTier from the action payload', () => {
    const s = reducer(
      { ...settingsBase() } as never as Parameters<typeof reducer>[0],
      {
        type: 'settingsOpen',
        mode: 'off',
        delayMs: 45_000,
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
        tokenSavingTier: 'minimal',
        allowOutsideProjectRoot: true,
        maxIterations: 500,
        autoProceedMaxIterations: 50,
        enhanceDelayMs: 60_000,
        enhanceEnabled: true,
        enhanceLanguage: 'original',
        indexOnStart: true,
        thinkingWord: 'thinking',
        reasoningMode: 'auto' as const,
        reasoningEffort: 'high' as const,
        reasoningPreserve: false,
        cacheTtl: 'default' as const,
        contextAutoCompact: true,
        contextStrategy: 'hybrid',
        contextMode: 'balanced' as const,
        maxConcurrent: 10,
        logLevel: 'info',
        auditLevel: 'standard',
        debugStream: false,
        statuslineMode: 'detailed' as const,
        configScope: 'global',
      } as Parameters<typeof reducer>[1],
    );
    expect(s.settingsPicker.tokenSavingTier).toBe('minimal');
  });

  it('settingsValueChange cycles off → minimal → light → medium → aggressive → auto → off', () => {
    let tier: (typeof TOKEN_SAVING_TIERS)[number] = 'off';
    let s = {
      ...settingsBase({ tokenSavingTier: tier }),
    } as never as Parameters<typeof reducer>[0];

    for (let i = 0; i < TOKEN_SAVING_TIERS.length; i++) {
      expect(s.settingsPicker.tokenSavingTier).toBe(tier);
      s = reducer(s, { type: 'settingsValueChange', delta: 1 });
      const currentIndex = TOKEN_SAVING_TIERS.indexOf(tier);
      tier = TOKEN_SAVING_TIERS[(currentIndex + 1) % TOKEN_SAVING_TIERS.length]!;
      expect(s.settingsPicker.tokenSavingTier).toBe(tier);
    }
  });

  it('settingsValueChange cycles backwards with delta -1', () => {
    let tier: (typeof TOKEN_SAVING_TIERS)[number] = 'aggressive';
    let s = {
      ...settingsBase({ tokenSavingTier: tier }),
    } as never as Parameters<typeof reducer>[0];

    for (let i = TOKEN_SAVING_TIERS.length - 1; i >= 0; i--) {
      expect(s.settingsPicker.tokenSavingTier).toBe(tier);
      s = reducer(s, { type: 'settingsValueChange', delta: -1 });
      tier = TOKEN_SAVING_TIERS[(i - 1 + TOKEN_SAVING_TIERS.length) % TOKEN_SAVING_TIERS.length]!;
      expect(s.settingsPicker.tokenSavingTier).toBe(tier);
    }
  });

  it('settingsValueChange wraps aggressive → auto on forward delta', () => {
    const s = reducer(
      { ...settingsBase({ tokenSavingTier: 'aggressive' }) } as never as Parameters<
        typeof reducer
      >[0],
      { type: 'settingsValueChange', delta: 1 },
    );
    expect(s.settingsPicker.tokenSavingTier).toBe('auto');
  });

  it('settingsValueChange moves off → auto on backward delta', () => {
    const s = reducer(
      { ...settingsBase({ tokenSavingTier: 'off' }) } as never as Parameters<typeof reducer>[0],
      { type: 'settingsValueChange', delta: -1 },
    );
    expect(s.settingsPicker.tokenSavingTier).toBe('auto');
  });

  it('settingsValueChange on field 13 sets restart hint (boot-only)', () => {
    const s = reducer(
      { ...settingsBase({ hint: undefined }) } as never as Parameters<typeof reducer>[0],
      { type: 'settingsValueChange', delta: 1 },
    );
    expect(s.settingsPicker.hint).toBe('↻ Takes effect next session');
  });

  it('TOKEN_SAVING_TIERS exports auto and all five concrete tiers', () => {
    expect(TOKEN_SAVING_TIERS).toEqual(['auto', 'off', 'minimal', 'light', 'medium', 'aggressive']);
  });

  it('field 13 is the token-saving tier field', () => {
    // Verify that field 13 is indeed token-saving tier by checking that field 12
    // (featureModelsRegistry) does NOT change when we issue a field-13 value change.
    const s = reducer(
      {
        ...settingsBase({ field: 13, featureModelsRegistry: true }),
      } as never as Parameters<typeof reducer>[0],
      { type: 'settingsValueChange', delta: 1 },
    );
    // featureModelsRegistry should be unchanged (it's in field 12)
    expect(s.settingsPicker.featureModelsRegistry).toBe(true);
    // tokenSavingTier should have changed
    expect(s.settingsPicker.tokenSavingTier).not.toBe('off');
  });

  it('auto-proceed delay presets include 15 seconds', () => {
    expect(DELAY_PRESETS_MS).toContain(15_000);
  });

  it('refine delay presets include 15 seconds and wrap after 120 seconds', () => {
    expect(ENHANCE_DELAY_PRESETS[0]).toBe(15_000);

    const s = reducer(
      {
        ...settingsBase({ field: 17, enhanceDelayMs: 120_000 }),
      } as never as Parameters<typeof reducer>[0],
      { type: 'settingsValueChange', delta: 1 },
    );

    expect(s.settingsPicker.enhanceDelayMs).toBe(15_000);
  });

  it('max concurrent shows a next-session hint when cycled to default', () => {
    const s = reducer(
      {
        ...settingsBase({ field: 30, maxConcurrent: 50, hint: undefined }),
      } as never as Parameters<typeof reducer>[0],
      { type: 'settingsValueChange', delta: 1 },
    );

    expect(s.settingsPicker.maxConcurrent).toBe(0);
    expect(s.settingsPicker.hint).toBe('↻ Takes effect next session');
  });
});
