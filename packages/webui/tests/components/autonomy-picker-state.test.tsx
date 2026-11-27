/**
 * AutonomyPicker — the chat-header autonomy mode picker.
 *
 * WCAG 2.2 AA 4.1.2 Name, Role, Value: a stateful control must publish its
 * state to assistive technology. The picker opens a popup of five mutually
 * exclusive modes, so:
 *   - the trigger publishes aria-expanded (the chevron alone is visual only);
 *   - the active mode publishes aria-pressed (the accent background class
 *     alone is visual only).
 *
 * The component renders compact in production (ChatView/ChatHeader.tsx), so
 * the trigger is addressed by its title.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const AUTONOMY_STRINGS: Record<string, string> = {
  'activity:autonomy.heading': 'Autonomy Mode',
  'activity:autonomy.titlePrefix': 'Autonomy: {{label}}',
  'activity:autonomy.labelOff': 'Off',
  'activity:autonomy.labelSuggest': 'Suggest',
  'activity:autonomy.labelAuto': 'Auto',
  'activity:autonomy.labelEternal': 'Eternal',
  'activity:autonomy.labelEternalParallel': 'Eternal Parallel',
  'activity:autonomy.descOff': 'Full manual control — agent waits for your input.',
  'activity:autonomy.descSuggest': 'Agent suggests next steps but waits for approval.',
  'activity:autonomy.descAuto': 'Agent auto-proceeds after brief confirmation delay.',
  'activity:autonomy.descEternal': 'Agent runs autonomously until goal is complete.',
  'activity:autonomy.descEternalParallel': 'Multi-agent autonomous execution — fleet mode.',
};

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = AUTONOMY_STRINGS[key];
      if (!template) return key;
      let out = template;
      for (const [name, value] of Object.entries(options ?? {})) {
        out = out.replace(`{{${name}}}`, String(value));
      }
      return out;
    },
  }),
}));

import { AutonomyPicker } from '../../src/components/AutonomyPicker';

function mount(value: 'off' | 'suggest' | 'auto' = 'suggest') {
  const onChange = vi.fn();
  render(<AutonomyPicker value={value} onChange={onChange} compact />);
  return { onChange };
}

/** The trigger, addressed by its title (production renders it compact). */
function trigger() {
  return screen.getByTitle('Autonomy: Suggest');
}

afterEach(() => cleanup());

describe('AutonomyPicker programmatic state', () => {
  it('renders a native trigger that opens the mode list', () => {
    mount();

    const btn = trigger();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');

    fireEvent.click(btn);
    for (const label of ['Off', 'Suggest', 'Auto', 'Eternal', 'Eternal Parallel']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('reports the picked mode', () => {
    const { onChange } = mount();

    fireEvent.click(trigger());
    fireEvent.click(screen.getByText('Auto'));

    expect(onChange).toHaveBeenCalledWith('auto');
  });

  it('publishes the expanded state on the trigger', () => {
    mount();

    const btn = trigger();
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('publishes which mode is active', () => {
    mount('suggest');

    fireEvent.click(trigger());

    const active = screen.getByRole('button', { pressed: true });
    expect(active.textContent).toContain('Suggest');
  });
});
