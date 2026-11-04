// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyEngineState } from '../src/engine-state';
import { ProviderCloudSettings } from '../src/ProviderCloudSettings';
import { type ProviderChoice, providerChoices } from '../src/provider-settings-model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function provider(overrides: Partial<ProviderChoice>): ProviderChoice {
  return {
    id: 'bedrock',
    name: 'Bedrock',
    family: 'anthropic',
    saved: true,
    keys: [],
    ...overrides,
  };
}

function mount(choice: ProviderChoice, command = vi.fn(async () => ({ message: 'ok' }))) {
  const host = document.createElement('div');
  act(() =>
    createRoot(host).render(
      createElement(ProviderCloudSettings, { provider: choice, command: command as never }),
    ),
  );
  return { host, command };
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('native cloud routing settings', () => {
  it('reads the saved type and cloud values from the saved connections', () => {
    const [choice] = providerChoices({
      ...emptyEngineState,
      results: {
        'providers.saved': {
          providers: [{ id: 'work', type: 'google-vertex', cloud: { project: 'acme' } }],
        },
      },
    });
    expect(choice).toMatchObject({ type: 'google-vertex', cloud: { project: 'acme' } });
  });

  it('offers nothing for a provider without native cloud fields', () => {
    expect(mount(provider({ id: 'openai', type: 'openai' })).host.textContent).toBe('');
  });

  it('shows the saved values and saves the edited ones on the profile', async () => {
    const { host, command } = mount(
      provider({ type: 'google-vertex', cloud: { project: 'acme', location: 'us-central1' } }),
    );
    expect(host.textContent).toContain('Cloud routing · acme · us-central1');
    const [project, location] = host.querySelectorAll('input');
    type(location as HTMLInputElement, 'europe-west4');
    type(project as HTMLInputElement, '');
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true })),
    );
    expect(command).toHaveBeenCalledWith(
      'provider.update',
      { id: 'bedrock', cloud: { location: 'europe-west4' } },
      ['key.operation_result'],
    );
    expect(host.textContent).toContain('Saved.');
  });

  it('refuses a value the engine would reject before sending it', async () => {
    const { host, command } = mount(provider({ type: 'amazon-bedrock' }));
    expect(host.textContent).toContain('AWS region');
    type(host.querySelector('input') as HTMLInputElement, 'us east 1');
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true })),
    );
    expect(command).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Invalid cloud region');
  });
});
