import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsNavigation } from '../../src/components/SettingsPanel/SettingsNavigation';
import { Tabs, TabsContent } from '../../src/components/ui/tabs';

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({ t: (key: string) => key.split('.').at(-1) }),
  i18n: {
    language: 'en',
    getResource: (_language: string, _namespace: string, section: string) =>
      section === 'general'
        ? { theme: { heading: 'Color theme' } }
        : section === 'features'
          ? { autoReviewDebounceLabel: 'Debounce interval' }
          : section === 'agent'
            ? { routingReasoningModeAria: 'Reasoning route mode' }
            : undefined,
  },
}));

const tabs = [
  {
    id: 'general',
    icon: <span aria-hidden="true">G</span>,
    labelKey: 'settings:tabs.general',
    descKey: 'settings:tabs.generalDesc',
  },
  {
    id: 'provider',
    icon: <span aria-hidden="true">P</span>,
    labelKey: 'settings:tabs.provider',
    descKey: 'settings:tabs.providerDesc',
  },
  {
    id: 'security',
    icon: <span aria-hidden="true">S</span>,
    labelKey: 'settings:tabs.security',
    descKey: 'settings:tabs.securityDesc',
  },
];

function Fixture() {
  const [active, setActive] = useState('general');
  return (
    <Tabs value={active} onValueChange={setActive} orientation="vertical">
      <SettingsNavigation tabs={tabs} activeTab={active} onSelect={setActive} />
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id}>
          {tab.id} content
        </TabsContent>
      ))}
    </Tabs>
  );
}

describe('SettingsNavigation', () => {
  function ReviewFixture() {
    return (
      <Tabs defaultValue="general">
        <SettingsNavigation
          tabs={[
            ...tabs,
            ...['chimera', 'context', 'routing'].map((id) => ({
              id,
              icon: <span />,
              labelKey: `settings:tabs.${id}`,
            })),
          ]}
          activeTab="general"
          onSelect={vi.fn()}
        />
      </Tabs>
    );
  }

  it('finds review settings in their actual tab instead of the context tab', () => {
    render(<ReviewFixture />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'search' }), {
      target: { value: 'Debounce interval' },
    });
    expect(screen.getByRole('tab', { name: 'chimera' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'context' })).toBeNull();
  });

  it('finds the model-routing tab from a setting label', () => {
    render(<ReviewFixture />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'search' }), {
      target: { value: 'Reasoning route mode' },
    });
    expect(screen.getByRole('tab', { name: 'routing' })).toBeTruthy();
  });

  it('filters sections, preserves tab semantics, and clears the query after navigation', () => {
    render(<Fixture />);
    expect(screen.getByRole('tab', { name: 'general' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /general.*browse/ }));
    const search = screen.getByRole('searchbox', { name: 'search' });
    fireEvent.change(search, { target: { value: 'securityDesc' } });
    expect(screen.queryByRole('tab', { name: 'general' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'security' }));
    expect(screen.getByRole('tab', { name: 'security' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('security content')).toBeTruthy();
    expect((search as HTMLInputElement).value).toBe('');
    expect(
      screen.getByRole('button', { name: /security.*browse/ }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('offers a clear empty state', () => {
    render(<Fixture />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'search' }), {
      target: { value: 'absent' },
    });
    expect(screen.getByRole('status').textContent).toContain('noResults');
    fireEvent.click(screen.getByRole('button', { name: 'clearSearch' }));
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('finds a tab by a setting inside it', () => {
    render(<Fixture />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'search' }), {
      target: { value: 'color theme' },
    });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'general' })).toBeTruthy();
  });

  it('closes the mobile picker when Radix activates a tab on mouse down', () => {
    render(<Fixture />);
    const browse = screen.getByRole('button', { name: /general.*browse/ });
    fireEvent.click(browse);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'provider' }), { button: 0 });
    expect(screen.getByRole('tab', { name: 'provider' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(
      screen.getByRole('button', { name: /provider.*browse/ }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('moves through the vertical tab list with arrow keys', async () => {
    render(<Fixture />);
    const first = screen.getByRole('tab', { name: 'general' });
    // Raw focus() and Radix's roving-focus state updates are not act-wrapped
    // by fireEvent — run them inside act.
    await act(async () => {
      first.focus();
      fireEvent.keyDown(first, { key: 'ArrowDown' });
    });
    expect(screen.getByRole('tab', { name: 'provider' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});
