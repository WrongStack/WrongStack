// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderKeyReplace } from '../src/ProviderKeyReplace';
import { buildKeyUpdate, maskedApiKey } from '../src/provider-settings-model';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the key replacement request', () => {
  it('keeps the label and trims the new secret, refusing an empty one', () => {
    expect(buildKeyUpdate('openai', 'work', '  sk-new-secret-1234  ')).toEqual({
      type: 'key.update',
      payload: { providerId: 'openai', label: 'work', apiKey: 'sk-new-secret-1234' },
    });
    expect(() => buildKeyUpdate('openai', 'work', '   ', 'missing')).toThrow('missing');
  });

  it('masks a key the way the engine reports it', () => {
    expect(maskedApiKey('sk-new-secret-1234')).toBe('sk-n…1234');
    expect(maskedApiKey('short')).toBe('•••••');
    expect(maskedApiKey('')).toBe('—');
  });
});

describe('replacing a saved key in place', () => {
  let root: Root;
  let host: HTMLElement;
  const saved = (masked: string) => ({
    providers: [{ id: 'openai', apiKeys: [{ label: 'work', maskedKey: masked, isActive: true }] }],
  });
  async function render(command: ReturnType<typeof vi.fn>, onStatus: ReturnType<typeof vi.fn>) {
    await act(async () =>
      root.render(
        createElement(ProviderKeyReplace, {
          providerId: 'openai',
          label: 'work',
          disabled: false,
          command: command as never,
          onStatus: onStatus as never,
        }),
      ),
    );
  }
  async function submit(secret: string) {
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    const input = host.querySelector('input')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, secret);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector('form')!.requestSubmit());
  }
  beforeEach(async () => {
    await surfaceI18n.changeLanguage('en');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('sends key.update and confirms the saved key now shows the new secret', async () => {
    const command = vi.fn(async (type: string) =>
      type === 'providers.saved' ? saved('sk-n…1234') : { success: true },
    );
    const onStatus = vi.fn();
    await render(command, onStatus);
    expect(host.textContent).toBe('Replace key');
    await submit('sk-new-secret-1234');
    expect(command.mock.calls[0]).toEqual([
      'key.update',
      { providerId: 'openai', label: 'work', apiKey: 'sk-new-secret-1234' },
      ['key.operation_result'],
    ]);
    expect(onStatus).toHaveBeenCalledWith({
      ok: true,
      text: 'The work key for openai was replaced.',
    });
    // The form closes and does not keep the secret.
    expect(host.querySelector('input')).toBeNull();
    act(() => root.unmount());
  });

  it('reports an unverified replacement when the saved key did not change', async () => {
    const command = vi.fn(async (type: string) =>
      type === 'providers.saved' ? saved('sk-o…9999') : { success: true },
    );
    const onStatus = vi.fn();
    await render(command, onStatus);
    await submit('sk-new-secret-1234');
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(host.querySelector('input')?.value).toBe('');
    act(() => root.unmount());
  });
});
