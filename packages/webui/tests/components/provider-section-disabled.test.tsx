import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderSavedProfiles } from '../../src/components/SettingsPanel/ProviderSavedProfiles';
import type { SavedProvider } from '../../src/components/SettingsPanel/provider-section-types';

// The model panel has its own suite and opens its own WS traffic; the toggle
// row is what this file exercises, so keep the render deterministic.
vi.mock('../../src/components/SettingsPanel/ProviderModelsPanel', () => ({
  ProviderModelsPanel: () => <div data-testid="provider-models-panel" />,
}));

const provider: SavedProvider = {
  id: 'openai',
  type: 'openai',
  family: 'openai',
  models: ['gpt-5'],
  apiKeys: [],
};

const noopNav = {
  setFieldRef: () => () => {},
  handleKeyDown: () => {},
};

/** Minimal props: everything irrelevant to the toggle is an inert stub. */
type Props = Parameters<typeof ProviderSavedProfiles>[0];

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    t: ((key: string) => key) as never,
    savedProviders: [provider],
    savedProviderStats: { keys: 0, activeKeys: 0, models: 1 },
    setShowAddProviderForm: () => {},
    showAddProviderForm: false,
    newProviderId: '',
    handlePickLocalPreset: () => {},
    setNewProviderId: () => {},
    addProviderNav: noopNav,
    newProviderFamily: '',
    setNewProviderFamily: () => {},
    newProviderBaseUrl: '',
    setNewProviderBaseUrl: () => {},
    newProviderApiKey: '',
    setNewProviderApiKey: () => {},
    newProviderModels: [],
    setNewProviderModels: () => {},
    handleAddProvider: () => {},
    saving: false,
    isLoadingSaved: false,
    save: async () => {},
    onRemoveProvider: () => {},
    ws: { listProviderModels: vi.fn() } as never,
    onPickProviderModel: () => {},
    disabledProviders: [] as string[],
    onToggleProviderDisabled: vi.fn(),
    setShowAddKeyForm: () => {},
    showAddKeyForm: null,
    onSetActiveKey: () => {},
    onDeleteKey: () => {},
    newKeyLabel: '',
    setNewKeyLabel: () => {},
    addKeyNav: noopNav,
    showNewKeyValue: false,
    newKeyValue: '',
    setNewKeyValue: () => {},
    setShowNewKeyValue: () => {},
    handleAddKey: () => {},
    ...overrides,
  };
}

describe('ProviderSavedProfiles — disable provider toggle', () => {
  afterEach(cleanup);

  it('renders an enabled switch and reports the provider id on toggle', () => {
    const onToggleProviderDisabled = vi.fn();
    render(<ProviderSavedProfiles {...baseProps({ onToggleProviderDisabled })} />);

    const toggle = screen.getByRole('switch', { name: 'settings:provider.disableToggle' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // The badge only appears once the provider is actually parked.
    expect(screen.queryByText('settings:provider.disabledBadge')).toBeNull();

    fireEvent.click(toggle);
    expect(onToggleProviderDisabled).toHaveBeenCalledWith('openai');
  });

  it('shows the switch on and the badge when the provider is already disabled', () => {
    render(<ProviderSavedProfiles {...baseProps({ disabledProviders: ['openai'] })} />);

    expect(
      screen
        .getByRole('switch', { name: 'settings:provider.disableToggle' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByText('settings:provider.disabledBadge')).toBeTruthy();
  });

  it('matches disabled ids case-insensitively, like the resolver', () => {
    render(<ProviderSavedProfiles {...baseProps({ disabledProviders: ['OpenAI'] })} />);

    expect(
      screen
        .getByRole('switch', { name: 'settings:provider.disableToggle' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
});

describe('ProviderSavedProfiles — a provider the host serves itself', () => {
  afterEach(cleanup);

  it('offers no key to add and no connection to remove for the ACP leader', () => {
    const acp: SavedProvider = {
      id: 'acp',
      type: 'acp',
      family: 'acp',
      models: ['claude-code'],
      hostServed: true,
      apiKeys: [],
    };
    render(<ProviderSavedProfiles {...baseProps({ savedProviders: [acp, provider] })} />);
    expect(screen.getByText('settings:provider.hostServed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove provider acp' })).toBeNull();
    // A saved provider beside it keeps its controls.
    expect(screen.getByRole('button', { name: 'Remove provider openai' })).toBeTruthy();
    expect(screen.getAllByText('settings:provider.addKey')).toHaveLength(1);
  });
});
