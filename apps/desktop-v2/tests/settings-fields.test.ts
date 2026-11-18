import { describe, expect, it } from 'vitest';
import { changedSettings, settingsSections } from '../src/settings-fields';

describe('WrongStack profile settings', () => {
  it('allows the engine unlimited iteration budget', () => {
    expect(
      settingsSections
        .flatMap<import('../src/settings-fields').SettingField>((section) => section.fields)
        .find((field) => field.key === 'maxIterations')?.min,
    ).toBe(0);
  });
  it('accepts the engine default of zero automatic continuation steps', () => {
    const field = settingsSections
      .flatMap<import('../src/settings-fields').SettingField>((section) => section.fields)
      .find((field) => field.key === 'autoProceedMaxIterations');
    expect(field?.min).toBe(0);
    expect(
      changedSettings(
        { autoProceedMaxIterations: 0, maxIterations: 40 },
        { autoProceedMaxIterations: 0, maxIterations: 73 },
      ),
    ).toEqual({ maxIterations: 73 });
  });
  it('sends only edited values so unrelated preferences survive a save', () => {
    const base = {
      maxIterations: 40,
      logLevel: 'info',
      fallbackModels: ['model-a'],
      featureMemory: true,
    };
    expect(changedSettings(base, { ...base, maxIterations: 70, featureMemory: false })).toEqual({
      maxIterations: 70,
      featureMemory: false,
    });
    expect(changedSettings(base, { ...base, fallbackModels: ['model-a'] })).toEqual({});
  });
  it('keeps conversation-only lanes out of profile settings', () => {
    const keys = settingsSections.flatMap((section) => section.fields.map((field) => field.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('subagentModelPlan');
    expect(keys).not.toContain('subagentsAllowed');
  });
});
