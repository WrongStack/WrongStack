// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { identityLabel, sessionIdentity } from '../src/identity-model';
import { SessionModelControls } from '../src/SessionModelControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = {
  sessionId: 's1',
  current: 'default',
  chosen: true,
  variants: [
    { variant: 'lite', label: 'Lite', hint: 'Short guidance', tokens: 2400 },
    { variant: 'default', label: 'Standard', hint: 'Balanced guidance', tokens: 7800 },
    { variant: 'pro', label: 'Pro', hint: 'Full coding guidance', tokens: 12_400 },
  ],
};

describe('the conversation’s agent identity', () => {
  it('lists the engine’s identities with their prompt size and picks the running one', () => {
    const { options, current } = sessionIdentity(info, {});
    expect(options.map((option) => identityLabel(option))).toEqual([
      'Lite · ~2,400 tokens',
      'Standard · ~7,800 tokens',
      'Pro · ~12,400 tokens',
    ]);
    expect(current).toBe('default');
    expect(sessionIdentity(info, { systemPromptVariant: 'pro' }).current).toBe('pro');
    expect(sessionIdentity(undefined, {}).options).toEqual([]);
  });

  it('asks for the identities and switches this conversation’s', async () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 's1', provider: 'zai', model: 'glm-5' },
    });
    state = reduceEngine(state, { type: 'system_prompt.info', payload: info });
    const send = vi.fn(async () => undefined);
    const command = vi.fn(async (type: string) =>
      type === 'prefs.get' ? { systemPromptVariant: 'pro' } : {},
    );
    const host = document.createElement('div');
    await act(async () =>
      createRoot(host).render(
        createElement(SessionModelControls, { state, command, send, onSettings: vi.fn() }),
      ),
    );
    expect(send).toHaveBeenCalledWith('system_prompt.get');
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Agent identity"]');
    expect(select?.value).toBe('default');
    await act(async () => {
      if (!select) return;
      select.value = 'pro';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(command).toHaveBeenCalledWith('prefs.update', { systemPromptVariant: 'pro' }, [
      'key.operation_result',
    ]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('stays hidden when the engine offers no identities', async () => {
    const host = document.createElement('div');
    await act(async () =>
      createRoot(host).render(
        createElement(SessionModelControls, {
          state: { ...emptyEngineState, connected: true },
          command: vi.fn(async () => ({})),
          send: vi.fn(async () => undefined),
          onSettings: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector('select[aria-label="Agent identity"]')).toBeNull();
  });
});
