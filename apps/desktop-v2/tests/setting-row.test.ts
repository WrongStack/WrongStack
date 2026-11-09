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
  writeOnlySettings,
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

describe('select options the engine cannot honor', () => {
  it('lists them disabled with the reason, keeping the rest choosable', () => {
    const autonomy = field('autonomy')!;
    const host = document.createElement('div');
    act(() =>
      createRoot(host).render(
        createElement(SettingRow, {
          field: autonomy,
          value: 'auto',
          onChange: vi.fn(),
          unavailableOptions: new Map([['eternal', 'Not here']]),
        }),
      ),
    );
    const option = (value: string) =>
      host.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!;
    expect(option('eternal').disabled).toBe(true);
    expect(option('eternal').title).toBe('Not here');
    expect(option('eternal-parallel').disabled).toBe(false);
    expect(option('auto').disabled).toBe(false);
  });
});

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

describe('HQ, proxy and Telegram settings', () => {
  const section = settingsSections.find((item) => item.id === 'notifications');
  const keyed = (key: string) => field(key) as SettingField;

  it('covers the WebUI integration preferences, Telegram only once configured', () => {
    const fields = (section?.fields ?? []) as readonly SettingField[];
    expect(fields.map((item) => item.key)).toEqual([
      'wrongProxyEnabled',
      'wrongProxyUrl',
      'hqEnabled',
      'hqUrl',
      'hqToken',
      'hqRawContent',
      'tgSessionEnd',
      'tgDelegate',
      'tgLongToolMs',
      'tgPollIntervalSec',
      'tgChatId',
    ]);
    expect(fields.filter((item) => item.when === 'tgConfigured')).toHaveLength(5);
  });

  it('never reads back the HQ token, and an emptied token keeps the saved one', () => {
    expect([...writeOnlySettings]).toEqual(['hqToken']);
    const { host, onChange } = row(keyed('hqToken'), undefined);
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(host.textContent).toContain('A saved token is never shown here.');
    const type = (target: HTMLInputElement, value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          target,
          value,
        );
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type(input, 'hq-client-token');
    expect(onChange).toHaveBeenLastCalledWith('hq-client-token');
    // With a token typed into the draft, emptying the field drops it from the draft again.
    const typed = row(keyed('hqToken'), 'hq-client-token');
    type(typed.host.querySelector('input') as HTMLInputElement, '');
    expect(typed.onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('edits a URL as text and holds a chat ID to a non-zero integer', () => {
    const proxy = row(keyed('wrongProxyUrl'), 'http://localhost:3444');
    expect((proxy.host.querySelector('input') as HTMLInputElement).value).toBe(
      'http://localhost:3444',
    );
    const chat = row(keyed('tgChatId'), '');
    const input = chat.host.querySelector('input') as HTMLInputElement;
    const pattern = new RegExp(`^(?:${input.pattern})$`);
    expect(['123', '-100200'].every((id) => pattern.test(id))).toBe(true);
    expect(['0', '12a', '-0'].some((id) => pattern.test(id))).toBe(false);
  });
});

describe('terminal display settings', () => {
  it('offers the terminal preferences the WebUI syncs, with the engine’s allowed values', () => {
    const fields = (settingsSections.find((item) => item.id === 'terminal-display')?.fields ??
      []) as readonly SettingField[];
    expect(fields.map((item) => item.key)).toEqual([
      'titleAnimation',
      'showAgentSwarmPanel',
      'confirmExit',
      'statuslineMode',
      'thinkingWord',
      'animationStyle',
      'showModelReasoning',
      'preRefineSeconds',
      'multiDiffSummaryThreshold',
    ]);
    expect(field('titleAnimation')?.kind).toBe('toggle');
    expect(field('confirmExit')?.kind).toBe('toggle');
    expect(field('showAgentSwarmPanel')?.options).toEqual(['bottom', 'sidebar', 'off']);
    expect(field('statuslineMode')?.options).toEqual(['minimum', 'detailed', 'no-color']);
    expect(field('animationStyle')?.options).toHaveLength(7);
  });

  it('holds the thinking word to one short word and never saves it empty', () => {
    const { host } = row(field('thinkingWord') as SettingField, 'working');
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.required).toBe(true);
    const word = new RegExp(`^(?:${input.pattern})$`, 'v');
    expect(['working', 'çalış_1', 'a-b'].every((value) => word.test(value))).toBe(true);
    expect(['two words', 'x'.repeat(17)].some((value) => word.test(value))).toBe(false);
  });
});
