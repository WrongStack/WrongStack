/**
 * The model catalog is a hand-built modal surface. It must expose a named
 * dialog role so assistive tech can identify its boundary and title.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      ({
        'common:action.close': 'Close',
        'settings:providerModels.catalogSearchTitle': 'Model catalog',
        'settings:providerModels.catalogSearchPlaceholder': 'Search models',
        'settings:providerModels.catalogSearchAria': 'Search models',
      })[key] ?? key,
  }),
}));

import { ModelCatalogPicker } from '../../src/components/SettingsPanel/ModelCatalogPicker';

function mount() {
  const ws = { on: () => vi.fn(), searchProviderModels: vi.fn() };
  return render(<ModelCatalogPicker ws={ws as never} onSelect={vi.fn()} onClose={vi.fn()} />);
}

afterEach(() => cleanup());

describe('ModelCatalogPicker dialog semantics', () => {
  it('renders the catalog search control and close button', () => {
    mount();
    expect(screen.getByRole('textbox', { name: 'Search models' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('exposes the modal surface as a named dialog', () => {
    mount();
    const dialog = screen.getByRole('dialog', { name: 'Model catalog' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });
});
