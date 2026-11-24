import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useConfirmModalStore } from '@/components/ConfirmModal';
import { ModelPicker } from '@/components/ModelPicker';
import { ProviderSection } from '@/components/SettingsPanel/ProviderSection';

vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/SettingsPanel/OAuthLoginSection', () => ({ OAuthLoginSection: () => null }));
vi.mock('@/components/SettingsPanel/ProviderModelsPanel', () => ({
  ProviderModelsPanel: () => null,
}));
vi.mock('@/components/SetupScreen/ModelEditor', () => ({ ModelEditor: () => null }));
vi.mock('@/components/SettingsPanel/ProviderHqImport', () => ({ ProviderHqImport: () => null }));
vi.mock('@/components/Toaster', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(cleanup);

function mount(onAddProvider = vi.fn(), providerTab: 'catalog' | 'saved' = 'catalog') {
  const onAddKey = vi.fn();
  const onDeleteKey = vi.fn().mockResolvedValue(true);
  const onRemoveProvider = vi.fn().mockResolvedValue(true);
  const onSetActiveKey = vi.fn().mockResolvedValue(true);
  render(
    <ProviderSection
      activeProvider="openai"
      disabledProviders={[]}
      onToggleProviderDisabled={vi.fn()}
      catalogProviders={[
        {
          id: 'openai',
          name: 'OpenAI',
          family: 'openai',
          envVars: [],
          modelCount: 1,
          hasApiKey: true,
        },
      ]}
      savedProviders={[
        {
          id: 'openai',
          type: 'openai',
          apiKeys: [
            { label: 'default', maskedKey: 'sk-a…1234', isActive: true, createdAt: '' },
            { label: 'backup', maskedKey: 'sk-b…1234', isActive: false, createdAt: '' },
          ],
        },
      ]}
      isLoadingCatalog={false}
      isLoadingSaved={false}
      providerTab={providerTab}
      setProviderTab={vi.fn()}
      onSelectProvider={vi.fn()}
      onAddKey={onAddKey}
      onDeleteKey={onDeleteKey}
      onSetActiveKey={onSetActiveKey}
      onAddProvider={onAddProvider}
      onRemoveProvider={onRemoveProvider}
      onPickProviderModel={vi.fn()}
      ws={{ on: () => () => {} } as never}
      catalogQuery=""
      setCatalogQuery={vi.fn()}
    />,
  );
  if (providerTab === 'catalog') fireEvent.click(screen.getByText('settings:provider.addProfile'));
  return { onAddProvider, onAddKey, onDeleteKey, onRemoveProvider, onSetActiveKey };
}

describe('API key account profiles', () => {
  it.each([
    ['Delete key default', 'onDeleteKey', ['openai', 'default']],
    ['Remove provider openai', 'onRemoveProvider', ['openai']],
  ] as const)(
    'requires confirmation for %s and permits cancellation',
    async (label, handler, args) => {
      const mutations = mount(vi.fn(), 'saved');
      const button = screen.getByRole('button', { name: label });
      fireEvent.click(button);
      expect(mutations[handler]).not.toHaveBeenCalled();
      expect(useConfirmModalStore.getState().request?.defaultAction).toBe('cancel');
      await act(async () => useConfirmModalStore.getState().settle(false));
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      expect(mutations[handler]).not.toHaveBeenCalled();
      fireEvent.click(button);
      await act(async () => useConfirmModalStore.getState().settle(true));
      await waitFor(() => expect(mutations[handler]).toHaveBeenCalledWith(...args));
    },
  );

  it('waits for active-key confirmation and keeps the saved state on failure', async () => {
    const { onSetActiveKey } = mount(vi.fn(), 'saved');
    let reply: ((success: boolean) => void) | undefined;
    onSetActiveKey.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          reply = resolve;
        }),
    );
    const button = screen.getByText('settings:provider.setActive') as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onSetActiveKey).toHaveBeenCalledOnce();
    expect(onSetActiveKey).toHaveBeenCalledWith('openai', 'backup');
    expect(button.disabled).toBe(true);
    await act(async () => reply!(false));
    expect(button.disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Delete key default' })).toBeTruthy();
  });
  it('retains the account form after a failed save and closes it after confirmed success', async () => {
    const add = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mount(add);
    fireEvent.change(screen.getByLabelText('settings:provider.profileAlias'), {
      target: { value: 'work-account' },
    });
    fireEvent.change(screen.getByPlaceholderText('settings:provider.keyPlaceholder'), {
      target: { value: 'work-key' },
    });
    fireEvent.click(screen.getByText('common:action.save'));
    await waitFor(() =>
      expect((screen.getByText('common:action.save') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(
      (screen.getByPlaceholderText('settings:provider.keyPlaceholder') as HTMLInputElement).value,
    ).toBe('work-key');
    expect(
      (screen.getByLabelText('settings:provider.profileAlias') as HTMLInputElement).value,
    ).toBe('work-account');
    fireEvent.click(screen.getByText('common:action.save'));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('settings:provider.keyPlaceholder')).toBeNull(),
    );
    expect(add).toHaveBeenCalledTimes(2);
  });
  it('offers the same model in two accounts and emits the selected auth profile alias', () => {
    const pick = vi.fn();
    render(
      <ModelPicker
        candidates={[
          {
            provider: 'personal-account',
            providerType: 'openai',
            model: 'same-model',
            label: 'Same model',
          },
          {
            provider: 'work-account',
            providerType: 'openai',
            model: 'same-model',
            label: 'Same model',
          },
        ]}
        onPick={pick}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.change(screen.getByPlaceholderText('activity:model.filterPlaceholder'), {
      target: { value: 'openai' },
    });
    expect(screen.getAllByText('Same model')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /work-account/ }));
    expect(pick).toHaveBeenCalledWith('same-model', 'work-account');
  });
  it('offers another account for an already configured provider and retains its canonical type', async () => {
    const { onAddProvider, onAddKey } = mount();
    expect(
      (screen.getByLabelText('settings:provider.profileAlias') as HTMLInputElement).value,
    ).toBe('openai-2');
    fireEvent.change(screen.getByLabelText('settings:provider.profileAlias'), {
      target: { value: 'work-account' },
    });
    fireEvent.change(screen.getByPlaceholderText('settings:provider.keyPlaceholder'), {
      target: { value: 'work-key' },
    });
    // The save handler awaits onAddProvider and then updates form state in a
    // microtask — flush it inside act so the update is not unwrapped.
    await act(async () => {
      fireEvent.click(screen.getByText('common:action.save'));
    });
    expect(onAddProvider).toHaveBeenCalledWith(
      'work-account',
      'openai',
      undefined,
      'work-key',
      undefined,
      undefined,
      'openai',
    );
    expect(onAddKey).not.toHaveBeenCalled();
  });

  it('refuses to put a new account credential into an existing auth profile', () => {
    const { onAddProvider, onAddKey } = mount();
    fireEvent.change(screen.getByLabelText('settings:provider.profileAlias'), {
      target: { value: 'openai' },
    });
    fireEvent.change(screen.getByPlaceholderText('settings:provider.keyPlaceholder'), {
      target: { value: 'different-account-key' },
    });
    fireEvent.click(screen.getByText('common:action.save'));
    expect(onAddProvider).not.toHaveBeenCalled();
    expect(onAddKey).not.toHaveBeenCalled();
  });
});
