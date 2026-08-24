import { describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_POSITIONS } from '../src/ui-contracts.js';
import {
  getSettingsFieldValue,
  resolveSettingsFieldValue,
  SETTINGS_FIELD_LABELS,
  type SettingsPickerValues,
} from '../src/components/settings-picker.js';

describe('resolveSettingsFieldValue', () => {
  // ── Boolean fields ──────────────────────────────────────────────

  describe('boolean fields', () => {
    const boolCases: Array<[number, string]> = [
      [3, 'yolo'],
      [5, 'chime'],
      [6, 'confirmExit'],
      [14, 'allowOutsideProjectRoot'],
      [33, 'debugStream'],
    ];

    for (const [field, _key] of boolCases) {
      const label = SETTINGS_FIELD_LABELS[field];

      it(`${label} (field ${field}): accepts on/true/yes/1`, () => {
        for (const v of ['on', 'ON', 'true', 'TRUE', 'yes', '1']) {
          const r = resolveSettingsFieldValue(field, v);
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(Object.values(r.patch)[0]).toBe(true);
            expect(r.displayValue).toBe('on');
          }
        }
      });

      it(`${label} (field ${field}): accepts off/false/no/0`, () => {
        for (const v of ['off', 'OFF', 'false', 'no', '0']) {
          const r = resolveSettingsFieldValue(field, v);
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(Object.values(r.patch)[0]).toBe(false);
            expect(r.displayValue).toBe('off');
          }
        }
      });

      it(`${label} (field ${field}): rejects invalid`, () => {
        const r = resolveSettingsFieldValue(field, 'maybe');
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toContain(label);
          expect(r.error.toLowerCase()).toContain('on');
          expect(r.error.toLowerCase()).toContain('off');
        }
      });
    }
  });

  // ── Enum fields ──────────────────────────────────────────────────

  describe('enum fields', () => {
    it('autonomy mode (0): accepts off/suggest/auto (case-insensitive)', () => {
      for (const [v, expected] of [
        ['off', 'off'],
        ['SUGGEST', 'suggest'],
        ['Auto', 'auto'],
      ] as const) {
        const r = resolveSettingsFieldValue(0, v);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.patch.mode).toBe(expected);
      }
    });

    it('autonomy mode (0): rejects invalid with valid options listed', () => {
      const r = resolveSettingsFieldValue(0, 'fast');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('off');
        expect(r.error).toContain('suggest');
        expect(r.error).toContain('auto');
      }
    });

    it('reasoning effort (24): accepts all levels', () => {
      const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      for (const v of levels) {
        const r = resolveSettingsFieldValue(24, v);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.patch.reasoningEffort).toBe(v);
      }
    });

    it('log level (31): accepts all levels', () => {
      const levels = ['error', 'warn', 'info', 'debug', 'trace'];
      for (const v of levels) {
        const r = resolveSettingsFieldValue(31, v);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.patch.logLevel).toBe(v);
      }
    });

    it('config scope (35): accepts global/project', () => {
      const r1 = resolveSettingsFieldValue(35, 'global');
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.patch.configScope).toBe('global');

      const r2 = resolveSettingsFieldValue(35, 'PROJECT');
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.patch.configScope).toBe('project');
    });
  });

  // ── Preset (numeric) fields ─────────────────────────────────────

  describe('preset fields', () => {
    it('max iterations (15): accepts numeric preset', () => {
      const r = resolveSettingsFieldValue(15, '500');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.maxIterations).toBe(500);
        expect(r.displayValue).toBe('500');
      }
    });

    it('max iterations (15): accepts "unlimited" for 0', () => {
      const r = resolveSettingsFieldValue(15, 'unlimited');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.maxIterations).toBe(0);
        expect(r.displayValue).toBe('unlimited');
      }
    });

    it('max iterations (15): rejects non-preset number', () => {
      const r = resolveSettingsFieldValue(15, '42');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('100');
        expect(r.error).toContain('unlimited');
      }
    });

    it('auto-proceed delay (1): accepts numeric and display name', () => {
      const r1 = resolveSettingsFieldValue(1, '30000');
      expect(r1.ok).toBe(true);
      if (r1.ok) expect(r1.patch.delayMs).toBe(30_000);

      const r2 = resolveSettingsFieldValue(1, '30s');
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.patch.delayMs).toBe(30_000);
    });

    it('auto-proceed delay (1): accepts "disabled" for 0', () => {
      const r = resolveSettingsFieldValue(1, 'disabled');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.delayMs).toBe(0);
        expect(r.displayValue).toBe('disabled');
      }
    });

    it('multi-diff summary (21): accepts "off" for 0', () => {
      const r = resolveSettingsFieldValue(21, 'off');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.multiDiffSummaryThreshold).toBe(0);
      }
    });

    it('max concurrent (30): accepts "runtime default" for 0', () => {
      const r = resolveSettingsFieldValue(30, 'runtime default');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.maxConcurrent).toBe(0);
      }
    });
  });

  // ── Text field (thinking word) ──────────────────────────────────

  describe('thinking word (22)', () => {
    it('accepts a valid word', () => {
      const r = resolveSettingsFieldValue(22, 'pondering');
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.patch.thinkingWord).toBe('pondering');
        expect(r.displayValue).toBe('pondering');
      }
    });

    it('accepts a short custom word', () => {
      const r = resolveSettingsFieldValue(22, 'brewing');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.patch.thinkingWord).toBe('brewing');
    });

    it('rejects empty string', () => {
      const r = resolveSettingsFieldValue(22, '');
      expect(r.ok).toBe(false);
    });

    it('rejects word longer than 16 chars', () => {
      const r = resolveSettingsFieldValue(22, 'supercalifragilistic');
      expect(r.ok).toBe(false);
    });

    it('rejects words with special characters', () => {
      const r = resolveSettingsFieldValue(22, 'think!');
      expect(r.ok).toBe(false);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns error for out-of-range field', () => {
      const r = resolveSettingsFieldValue(99, 'on');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('99');
    });

    it('SETTINGS_FIELD_LABELS has 61 entries', () => {
      expect(SETTINGS_FIELD_LABELS.length).toBe(61);
    });

    it('trims whitespace from input', () => {
      const r = resolveSettingsFieldValue(3, '  on  ');
      expect(r.ok).toBe(true);
    });

    it('all boolean field indices are covered', () => {
      const boolFields = [
        2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 18, 20, 25, 27, 33, 37, 39, 42, 43,
      ];
      for (const f of boolFields) {
        const r = resolveSettingsFieldValue(f, 'on');
        expect(r.ok).toBe(true);
      }
    });

    it('all enum field indices are covered', () => {
      const enumFields = [0, 4, 13, 19, 23, 24, 26, 28, 29, 31, 32, 34, 35, 36, 40];
      for (const f of enumFields) {
        // Use the first value from SETTINGS_FIELD_LABELS to construct a dummy test
        const r = resolveSettingsFieldValue(f, 'invalid_value_xyz');
        expect(r.ok).toBe(false); // should fail, not crash
      }
    });

    it('all preset field indices are covered', () => {
      const presetFields = [1, 15, 16, 17, 21, 30, 38, 41, 44];
      for (const f of presetFields) {
        const r = resolveSettingsFieldValue(f, '999999');
        expect(r.ok).toBe(false); // should fail with error, not crash
      }
    });
  });
});

// ── getSettingsFieldValue (read counterpart) ──────────────────────

describe('getSettingsFieldValue', () => {
  // A representative slice with all configurable keys populated with
  // known values so we can assert exact display strings.
  const baseValues: SettingsPickerValues = {
    mode: 'auto',
    delayMs: 30_000,
    titleAnimation: true,
    yolo: false,
    fleetChat: 'off',
    chime: true,
    confirmExit: false,
    nextPrediction: true,
    featureMcp: true,
    featurePlugins: false,
    featureMemory: true,
    featureSkills: true,
    featureModelsRegistry: false,
    tokenSavingTier: 'medium',
    allowOutsideProjectRoot: true,
    contextAutoCompact: false,
    contextStrategy: 'hybrid',
    contextMode: 'deep',
    maxConcurrent: 10,
    logLevel: 'debug',
    auditLevel: 'standard',
    indexOnStart: false,
    multiDiffSummaryThreshold: 5,
    maxIterations: 500,
    autoProceedMaxIterations: 0,
    enhanceDelayMs: 60_000,
    preRefineSeconds: 3,
    enhanceEnabled: true,
    enhanceLanguage: 'english',
    debugStream: false,
    statuslineMode: 'detailed',
    reasoningMode: 'on',
    reasoningEffort: 'xhigh',
    reasoningPreserve: true,
    thinkingWord: 'brewing',
    cacheTtl: '5m',
    configScope: 'project',
    animationStyle: 'rainbow',
    breakerEnabled: false,
    breakerAutoKillResetMs: 60_000,
    showModelReasoning: true,
    showAgentSwarmPanel: 'off',
    showSageMemoryInject: false,
    sageMemoryInjectThreshold: 0.85,
    readSymbols: true,
    nextStepsTool: false,
    // WrongProxy / WrongTrace (fields 59/60).
    wrongProxyEnabled: false,
    wrongProxyUrl: 'http://localhost:8000',
    panelPositions: DEFAULT_PANEL_POSITIONS,
  };

  describe('boolean fields', () => {
    it('returns "off" for false', () => {
      const r = getSettingsFieldValue(baseValues, 3); // yolo = false
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.label).toBe('YOLO mode');
        expect(r.displayValue).toBe('off');
      }
    });

    it('returns "on" for true', () => {
      const r = getSettingsFieldValue(baseValues, 5); // chime = true
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.displayValue).toBe('on');
    });
  });

  describe('enum fields', () => {
    it('returns the raw enum value', () => {
      const r = getSettingsFieldValue(baseValues, 0); // mode = 'auto'
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.label).toBe('Default autonomy mode');
        expect(r.displayValue).toBe('auto');
      }
    });

    it('returns the agent swarm panel mode', () => {
      const r = getSettingsFieldValue(baseValues, 40);
      expect(r).toEqual({
        ok: true,
        label: 'Agent swarm panel',
        displayValue: 'off',
      });
    });

    it('returns reasoning effort', () => {
      const r = getSettingsFieldValue(baseValues, 24); // xhigh
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.displayValue).toBe('xhigh');
    });

    it('returns config scope', () => {
      const r = getSettingsFieldValue(baseValues, 35); // project
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.displayValue).toBe('project');
    });
  });

  describe('preset fields', () => {
    it('formats delay as "30s"', () => {
      const r = getSettingsFieldValue(baseValues, 1); // delayMs = 30000
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.displayValue).toBe('30s');
    });

    it('formats max iterations as "500"', () => {
      const r = getSettingsFieldValue(baseValues, 15); // 500
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.displayValue).toBe('500');
    });

    it('formats auto-proceed max as "unlimited" for 0', () => {
      const r = getSettingsFieldValue(baseValues, 16); // 0
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.displayValue).toBe('unlimited');
    });

    it('formats multi-diff threshold as "5"', () => {
      const r = getSettingsFieldValue(baseValues, 21); // 5
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.displayValue).toBe('5');
    });

    it('formats max concurrent as "10"', () => {
      const r = getSettingsFieldValue(baseValues, 30); // 10
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.displayValue).toBe('10');
    });

    it('formats max concurrent 0 as "runtime default"', () => {
      const r = getSettingsFieldValue({ ...baseValues, maxConcurrent: 0 }, 30);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.displayValue).toBe('runtime default');
    });
  });

  describe('text field', () => {
    it('returns the thinking word', () => {
      const r = getSettingsFieldValue(baseValues, 22); // brewing
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.label).toBe('Thinking word');
        expect(r.displayValue).toBe('brewing');
      }
    });
  });

  describe('edge cases', () => {
    it('returns error for out-of-range field', () => {
      const r = getSettingsFieldValue(baseValues, 99);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('99');
    });
  });
});

// ── formatAllSettingsSummary ─────────────────────────────────────

import { formatAllSettingsSummary } from '../src/components/settings-picker.js';

describe('formatAllSettingsSummary', () => {
  const testValues: SettingsPickerValues = {
    mode: 'off',
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
    featureModelsRegistry: false,
    tokenSavingTier: 'off',
    allowOutsideProjectRoot: true,
    contextAutoCompact: true,
    contextStrategy: 'hybrid',
    contextMode: 'balanced',
    maxConcurrent: 10,
    logLevel: 'info',
    auditLevel: 'standard',
    indexOnStart: true,
    multiDiffSummaryThreshold: 5,
    maxIterations: 500,
    autoProceedMaxIterations: 50,
    enhanceDelayMs: 60_000,
    preRefineSeconds: 3,
    enhanceEnabled: true,
    enhanceLanguage: 'original',
    debugStream: false,
    statuslineMode: 'detailed',
    reasoningMode: 'auto',
    reasoningEffort: 'high',
    reasoningPreserve: false,
    thinkingWord: 'thinking',
    cacheTtl: 'default',
    configScope: 'global',
    animationStyle: 'rainbow',
    breakerEnabled: false,
    breakerAutoKillResetMs: 60_000,
    showModelReasoning: true,
    showAgentSwarmPanel: 'bottom',
    showSageMemoryInject: false,
    sageMemoryInjectThreshold: 0.85,
    readSymbols: false,
    nextStepsTool: false,
    // WrongProxy / WrongTrace (fields 59/60).
    wrongProxyEnabled: false,
    wrongProxyUrl: 'http://localhost:8000',
    panelPositions: DEFAULT_PANEL_POSITIONS,
  };

  it('contains all 12 section headings (incl. Panels for fields 45–57)', () => {
    const out = formatAllSettingsSummary(testValues);
    const sections = [
      'Autonomy',
      'UX',
      'Features',
      'Tools',
      'Reasoning',
      'Context',
      'Fleet',
      'Logging',
      'Debug',
      'Safety',
      'Display',
      'Panels',
    ];
    for (const s of sections) {
      expect(out).toContain(`── ${s} ──`);
    }
  });

  it('renders exactly 61 value lines (one per field)', () => {
    const out = formatAllSettingsSummary(testValues);
    const fieldLines = out.split('\n').filter((l) => l.startsWith('  ') && l.trim().length > 0);
    expect(fieldLines).toHaveLength(61);
  });

  it('includes the thinking word value', () => {
    const out = formatAllSettingsSummary(testValues);
    expect(out).toContain('thinking');
  });

  it('formats booleans as on/off', () => {
    const out = formatAllSettingsSummary(testValues);
    expect(out).toContain('YOLO mode');
    expect(out).toMatch(/YOLO mode\s+off/);
    expect(out).toMatch(/Fleet chat\s+off/);
  });

  it('formats presets with display names', () => {
    const out = formatAllSettingsSummary({ ...testValues, maxIterations: 0 });
    expect(out).toMatch(/Max iterations\s+unlimited/);
  });
});

// ── resetSettingsFieldValue ───────────────────────────────────────

import { resetSettingsFieldValue, SETTINGS_DEFAULTS } from '../src/components/settings-picker.js';

describe('resetSettingsFieldValue', () => {
  it('returns the default value for a boolean field', () => {
    const r = resetSettingsFieldValue(3); // yolo default = true
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.label).toBe('YOLO mode');
      expect(r.displayValue).toBe('on');
      expect(r.patch.yolo).toBe(true);
    }
  });

  it('resets the sidebar mission queue field to visible', () => {
    const r = resetSettingsFieldValue(40);
    expect(r).toEqual({
      ok: true,
      patch: {
        showAgentSwarmPanel: 'bottom',
        panelPositions: { fleet: 'bottom' },
      },
      label: 'Agent swarm panel',
      displayValue: 'bottom',
    });
  });

  it('returns the default value for an enum field', () => {
    const r = resetSettingsFieldValue(31); // logLevel default = 'info'
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.displayValue).toBe('info');
      expect(r.patch.logLevel).toBe('info');
    }
  });

  it('returns the default value for a preset field', () => {
    const r = resetSettingsFieldValue(15); // maxIterations default = 500
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.displayValue).toBe('500');
      expect(r.patch.maxIterations).toBe(500);
    }
  });

  it('returns the default value for the thinking word', () => {
    const r = resetSettingsFieldValue(22);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.displayValue).toBe('thinking');
      expect(r.patch.thinkingWord).toBe('thinking');
    }
  });

  it('returns error for out-of-range field', () => {
    const r = resetSettingsFieldValue(99);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('99');
  });

  it('SETTINGS_DEFAULTS has all 49 keys (47 legacy + panelPositions + wrongProxy)', () => {
    expect(Object.keys(SETTINGS_DEFAULTS)).toHaveLength(49);
  });

  it('every field 0-57 can be reset', () => {
    for (let f = 0; f < 58; f++) {
      const r = resetSettingsFieldValue(f);
      expect(r.ok).toBe(true);
    }
  });
});
