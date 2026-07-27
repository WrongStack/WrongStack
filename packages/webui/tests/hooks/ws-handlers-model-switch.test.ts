import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send: vi.fn(), listSavedProviders: vi.fn() }),
}));

vi.mock('@/components/Toaster', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { WS_HANDLERS } from '../../src/hooks/ws-handlers';
import { useChatStore } from '../../src/stores/chat-store';
import { useConfigStore } from '../../src/stores/config-store';

describe('model switch ws handler', () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
  });

  it('updates the visible identity and records the next-request boundary', () => {
    WS_HANDLERS['model.switch_result']?.({
      type: 'model.switch_result',
      payload: {
        requestId: 'switch-1',
        success: true,
        message: 'Switched',
        previousProvider: 'openai',
        previousModel: 'gpt-old',
        provider: 'anthropic',
        model: 'claude-new',
        runActive: true,
      },
    });

    expect(useConfigStore.getState()).toMatchObject({
      provider: 'anthropic',
      model: 'claude-new',
    });
    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: 'system',
      content: expect.stringMatching(/next LLM request.*current run/i),
    });
  });
});
