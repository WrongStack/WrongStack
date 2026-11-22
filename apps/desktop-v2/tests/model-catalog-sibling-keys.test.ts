// @vitest-environment jsdom
// The legacy-draft notice and the registry search render side by side for the same
// provider. Both remount per provider, so both are keyed by it; with the same key React
// warned "two children with the same key" whenever the registry search was open.
import { webcrypto } from 'node:crypto';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ModelCatalogSettings } from '../src/ModelCatalogSettings';
import { surfaceI18n } from '../src/surface-i18n';

const bridge = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/platform', () => ({ request: bridge.request, native: true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('opening the registry search keeps sibling keys unique', async () => {
  await surfaceI18n.changeLanguage('en');
  vi.stubGlobal('crypto', webcrypto);
  bridge.request.mockImplementation(async (method: string) => {
    if (method === 'profile-draft.get') return { revision: 0, value: null };
    throw Error('Unexpected native call ' + method);
  });
  const providerId = 'fixture-provider';
  const command = vi.fn(async (method: string) => {
    if (method === 'prefs.get')
      return { profileIdentity: { id: '7'.repeat(64), name: 'Key fixture' } };
    if (method === 'providers.list') return { providers: [{ id: providerId, name: 'Fixture' }] };
    if (method === 'providers.saved') return { providers: [{ id: providerId, customModels: {} }] };
    if (method === 'provider.models') return { provider: providerId, models: [] };
    throw Error('Unexpected engine request ' + method);
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ModelCatalogSettings, { command })));
    const find = () =>
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Find in model registry',
      );
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(find()?.disabled).toBe(false);
    });
    await act(async () => find()!.click());
    expect(host.querySelector('[aria-label="Search model registry"]')).not.toBeNull();
    const duplicates = errors.mock.calls.filter((call) =>
      String(call[0]).includes('two children with the same key'),
    );
    expect(duplicates).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    errors.mockRestore();
    vi.unstubAllGlobals();
    bridge.request.mockReset();
  }
});
