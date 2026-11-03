// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SettingRow } from '../src/SettingRow';
import {
  type SettingField,
  settingChange,
  settingsSections,
  settingValue,
} from '../src/settings-fields';
import { prepareSettingsPatch } from '../src/settings-save-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const field = (key: string) =>
  settingsSections.flatMap((section) => section.fields).find((item) => item.key === key) as
    | SettingField
    | undefined;

function row(item: SettingField, value: unknown) {
  const onChange = vi.fn();
  const host = document.createElement('div');
  act(() => createRoot(host).render(createElement(SettingRow, { field: item, value, onChange })));
  return { host, onChange };
}

describe('engine settings the WebUI already offered', () => {
  it('lists each new setting in its section', () => {
    const keys = (id: string) =>
      settingsSections.find((section) => section.id === id)?.fields.map((item) => item.key);
    expect(keys('execution')).toEqual(expect.arrayContaining(['nextStepsMode', 'fsAccess']));
    expect(keys('capabilities')).toEqual(
      expect.arrayContaining(['readSymbols', 'showSageMemoryInject', 'sageMemoryInjectThreshold']),
    );
    expect(keys('routing')).toEqual(
      expect.arrayContaining([
        'favoriteModelsOnly',
        'streamTimeouts.hangTimeoutMs',
        'streamTimeouts.headersTimeoutMs',
      ]),
    );
  });

  it('reads and rewrites a stream watchdog inside its group', () => {
    const prefs = { streamTimeouts: { hangTimeoutMs: 120_000, headersTimeoutMs: 90_000 } };
    expect(settingValue(prefs, 'streamTimeouts.hangTimeoutMs')).toBe(120_000);
    expect(settingValue({}, 'streamTimeouts.hangTimeoutMs')).toBeUndefined();
    expect(settingChange(prefs, 'streamTimeouts.hangTimeoutMs', 0)).toEqual([
      'streamTimeouts',
      { hangTimeoutMs: 0, headersTimeoutMs: 90_000 },
    ]);
    expect(settingChange(prefs, 'streamTimeouts.headersTimeoutMs', undefined)).toEqual([
      'streamTimeouts',
      { hangTimeoutMs: 120_000 },
    ]);
    expect(settingChange(prefs, 'fsAccess', 'project')).toEqual(['fsAccess', 'project']);
  });

  it('saves a cleared watchdog as its group without it, so the default applies', () => {
    const base = { streamTimeouts: { hangTimeoutMs: 120_000 } };
    const [key, value] = settingChange(base, 'streamTimeouts.hangTimeoutMs', undefined);
    expect(prepareSettingsPatch(base, { ...base, [key]: value }, base)).toEqual({
      streamTimeouts: {},
    });
  });

  it('shows an unset watchdog as its default and lets it stay empty', () => {
    const watchdog = field('streamTimeouts.hangTimeoutMs') as SettingField;
    const { host, onChange } = row(watchdog, undefined);
    expect(host.textContent).toContain('Default: 60 s (240 s for MiniMax and Z.AI)');
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.required).toBe(false);
    expect(input.max).toBe('3600');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, '90');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(90_000);
  });

  it('shows the SAGE threshold as a number and stores a number', () => {
    const threshold = field('sageMemoryInjectThreshold') as SettingField;
    const { host, onChange } = row(threshold, 0.9);
    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('0.90');
    expect([...select.options].map((option) => option.textContent)).toContain('0.85 (default)');
    act(() => {
      select.value = '0.95';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(0.95);
  });

  it('words the filesystem scope with the field’s own labels', () => {
    const { host } = row(field('fsAccess') as SettingField, 'project');
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('project');
    expect(host.textContent).toContain('Project — confined to the project root');
  });
});
