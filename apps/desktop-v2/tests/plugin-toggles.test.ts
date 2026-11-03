// @vitest-environment jsdom
import { PLUGIN_AUDIT_ENTRIES } from '@wrongstack/plugins/plugin-audit-catalog';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PluginToggles } from '../src/PluginToggles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(draft: Record<string, unknown>) {
  const change = vi.fn();
  const host = document.createElement('div');
  act(() => createRoot(host).render(createElement(PluginToggles, { draft, change })));
  const switchFor = (name: string) =>
    host.querySelector<HTMLButtonElement>(`[id="plugin-${name}"]`) as HTMLButtonElement;
  return { host, change, switchFor };
}

const lockable = PLUGIN_AUDIT_ENTRIES.find((entry) => entry.canDisable);
const locked = PLUGIN_AUDIT_ENTRIES.find((entry) => !entry.canDisable);

describe('per-plugin controls', () => {
  it('lists every catalog plugin, decided ones from the profile and the rest by default', () => {
    if (!lockable) throw new Error('catalog has no plugin that can be disabled');
    const flipped = lockable.defaultState !== 'active';
    const { host, switchFor } = mount({ pluginsEnabled: { [lockable.name]: flipped } });
    expect(host.querySelectorAll('[role="switch"]')).toHaveLength(PLUGIN_AUDIT_ENTRIES.length);
    expect(switchFor(lockable.name).getAttribute('aria-checked')).toBe(String(flipped));
    const other = PLUGIN_AUDIT_ENTRIES.find((entry) => entry.name !== lockable.name);
    if (other)
      expect(switchFor(other.name).getAttribute('aria-checked')).toBe(
        String(other.defaultState === 'active'),
      );
  });

  it('records a flip in the pluginsEnabled draft, keeping what the profile decided', () => {
    if (!lockable) throw new Error('catalog has no plugin that can be disabled');
    const { change, switchFor } = mount({ pluginsEnabled: { 'already-decided': true } });
    act(() => switchFor(lockable.name).click());
    expect(change).toHaveBeenCalledWith('pluginsEnabled', {
      'already-decided': true,
      [lockable.name]: lockable.defaultState !== 'active',
    });
  });

  it('locks plugins that cannot be disabled', () => {
    if (!locked) return;
    const { switchFor, host } = mount({});
    expect(switchFor(locked.name).disabled).toBe(true);
    expect(host.textContent).toContain('Always on');
  });

  it('filters by name or summary, and to enabled plugins only', () => {
    const { host } = mount({});
    const search = host.querySelector('input[type="search"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        'zzz-no-such-plugin',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).toContain('No plugins match this filter.');
    const active = PLUGIN_AUDIT_ENTRIES.filter((entry) => entry.defaultState === 'active').length;
    const fresh = mount({});
    act(() =>
      [...fresh.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Enabled only')
        ?.click(),
    );
    expect(fresh.host.querySelectorAll('[role="switch"]')).toHaveLength(active);
  });
});
