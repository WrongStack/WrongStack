import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { handlers, send, updatePrefs, client } = vi.hoisted(() => {
  const handlers = new Map<string, (message: any) => void>();
  const send = vi.fn();
  const updatePrefs = vi.fn();
  const client = {
    send,
    on: (type: string, handler: (message: any) => void) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
  };
  return { handlers, send, updatePrefs, client };
});

vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ client, updatePrefs }) }));

import { ProviderTestView } from '@/components/ProviderTestView';
import { useLocalPrefs } from '@/stores/local-prefs';

afterEach(() => {
  cleanup();
  handlers.clear();
  send.mockReset();
  updatePrefs.mockReset();
  useLocalPrefs.setState({
    favoriteModels: [],
    disabledModels: [],
    fallbackModels: [],
    fallbackProfiles: {},
  });
});

describe('ProviderTestView', () => {
  it('shows disabled models but excludes them from defaults and normal select-all', () => {
    useLocalPrefs.setState({ disabledModels: ['account-a/model-two'] });
    render(<ProviderTestView />);
    act(() => {
      handlers.get('providers.saved')?.({
        type: 'providers.saved',
        payload: {
          providers: [{ id: 'account-a', type: 'openai', family: 'openai', apiKeys: [] }],
        },
      });
    });
    fireEvent.click(screen.getByText('account-a'));
    fireEvent.click(screen.getByText('Next'));
    act(() => {
      handlers.get('provider.models')?.({
        type: 'provider.models',
        payload: {
          provider: 'account-a',
          models: [
            { id: 'model-one', name: 'One', capabilities: [] },
            { id: 'model-two', name: 'Two', capabilities: [] },
          ],
        },
      });
    });

    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(screen.getByText('Test 1 model(s)')).toBeTruthy();
    fireEvent.click(screen.getByText('With disabled models'));
    expect(screen.getByText('Test 2 model(s)')).toBeTruthy();
    fireEvent.click(screen.getByText('Select all'));
    expect(screen.getByText('Test 1 model(s)')).toBeTruthy();
  });

  it('selects a saved account, selects its models, and starts one bounded test run', () => {
    render(<ProviderTestView />);
    expect(send).toHaveBeenCalledWith({ type: 'providers.saved' });

    act(() => {
      handlers.get('providers.saved')?.({
        type: 'providers.saved',
        payload: {
          providers: [
            {
              id: 'account-a',
              type: 'openai-codex',
              family: 'openai-codex',
              apiKeys: [{ label: 'work', maskedKey: 'sk-…1234', isActive: true, createdAt: 'now' }],
            },
          ],
        },
      });
    });
    fireEvent.click(screen.getByText('account-a'));
    fireEvent.click(screen.getByText('Next'));
    expect(send).toHaveBeenCalledWith({
      type: 'provider.models',
      payload: { providerId: 'account-a', includeDisabled: true },
    });

    act(() => {
      handlers.get('provider.models')?.({
        type: 'provider.models',
        payload: {
          provider: 'account-a',
          models: [
            {
              id: 'model-one',
              name: 'Model One',
              contextWindow: 200_000,
              maxOutput: 32_000,
              capabilities: ['tools', 'reasoning'],
            },
            {
              id: 'model-two',
              name: 'Model Two',
              capabilities: [],
            },
          ],
        },
      });
    });

    fireEvent.click(screen.getByText('Test 2 model(s)'));
    const run = send.mock.calls.find(([message]) => message.type === 'provider.test.run')?.[0];
    expect(run).toMatchObject({
      type: 'provider.test.run',
      payload: {
        providerId: 'account-a',
        modelIds: ['model-one', 'model-two'],
        timeoutMs: 45_000,
        maxTokens: 32,
      },
    });
    expect(run.payload.requestId).toEqual(expect.any(String));
  });

  it('favorites passing models and confirms disable with fallback cleanup', () => {
    useLocalPrefs.setState({
      favoriteModels: [],
      disabledModels: [],
      fallbackModels: ['account-a/bad-model', 'account-b/safe'],
      fallbackProfiles: {
        default: ['account-a/bad-model', 'account-b/safe'],
      },
    });
    render(<ProviderTestView />);
    act(() => {
      handlers.get('providers.saved')?.({
        type: 'providers.saved',
        payload: {
          providers: [
            {
              id: 'account-a',
              type: 'openai-codex',
              family: 'openai-codex',
              apiKeys: [],
            },
          ],
        },
      });
    });
    fireEvent.click(screen.getByText('account-a'));
    fireEvent.click(screen.getByText('Next'));
    act(() => {
      handlers.get('provider.models')?.({
        type: 'provider.models',
        payload: {
          provider: 'account-a',
          models: [
            { id: 'good-model', name: 'Good', capabilities: [] },
            { id: 'bad-model', name: 'Bad', capabilities: [] },
          ],
        },
      });
    });
    fireEvent.click(screen.getByText('Test 2 model(s)'));
    const requestId = send.mock.calls.find(([message]) => message.type === 'provider.test.run')?.[0]
      .payload.requestId;
    act(() => {
      handlers.get('provider.test.result')?.({
        type: 'provider.test.result',
        payload: {
          requestId,
          providerId: 'account-a',
          modelId: 'good-model',
          status: 'passed',
          diagnosis: 'ok',
          latencyMs: 10,
        },
      });
      handlers.get('provider.test.result')?.({
        type: 'provider.test.result',
        payload: {
          requestId,
          providerId: 'account-a',
          modelId: 'bad-model',
          status: 'failed',
          diagnosis: 'model_unavailable',
          latencyMs: 10,
        },
      });
      handlers.get('provider.test.complete')?.({
        type: 'provider.test.complete',
        payload: {
          requestId,
          providerId: 'account-a',
          passed: 1,
          failed: 1,
          cancelled: 0,
        },
      });
    });

    expect(screen.getAllByText('Retry')).toHaveLength(1);
    fireEvent.click(screen.getByText('Retry'));
    const retry = send.mock.calls
      .filter(([message]) => message.type === 'provider.test.run')
      .at(-1)?.[0];
    expect(retry).toBeDefined();
    expect(retry).toMatchObject({
      payload: { providerId: 'account-a', modelIds: ['bad-model'] },
    });
    act(() => {
      handlers.get('provider.test.complete')?.({
        type: 'provider.test.complete',
        payload: {
          requestId: retry!.payload.requestId,
          providerId: 'account-a',
          passed: 1,
          failed: 0,
          cancelled: 0,
        },
      });
    });

    fireEvent.click(screen.getByText('Favorite'));
    expect(updatePrefs).toHaveBeenCalledWith({ favoriteModels: ['account-a/good-model'] });

    fireEvent.click(screen.getByText('Disable'));
    expect(screen.getByText('Disable this model?')).toBeTruthy();
    fireEvent.click(screen.getByText('Disable model'));
    expect(updatePrefs).toHaveBeenLastCalledWith({
      disabledModels: ['account-a/bad-model'],
      favoriteModels: ['account-a/good-model'],
      fallbackModels: ['account-b/safe'],
      fallbackProfiles: { default: ['account-b/safe'] },
    });
  });

  it('bulk-disables multiple failed models with one confirmation', () => {
    useLocalPrefs.setState({
      favoriteModels: ['account-a/bad-one'],
      disabledModels: [],
      fallbackModels: ['account-a/bad-one', 'account-a/bad-two'],
      fallbackProfiles: { default: ['account-a/bad-one', 'account-a/bad-two'] },
    });
    render(<ProviderTestView />);
    act(() => {
      handlers.get('providers.saved')?.({
        type: 'providers.saved',
        payload: {
          providers: [{ id: 'account-a', type: 'openai', family: 'openai', apiKeys: [] }],
        },
      });
    });
    fireEvent.click(screen.getByText('account-a'));
    fireEvent.click(screen.getByText('Next'));
    act(() => {
      handlers.get('provider.models')?.({
        type: 'provider.models',
        payload: {
          provider: 'account-a',
          models: [
            { id: 'bad-one', name: 'Bad one', capabilities: [] },
            { id: 'bad-two', name: 'Bad two', capabilities: [] },
          ],
        },
      });
    });
    fireEvent.click(screen.getByText('Test 2 model(s)'));
    const requestId = send.mock.calls.find(([message]) => message.type === 'provider.test.run')?.[0]
      .payload.requestId;
    act(() => {
      for (const modelId of ['bad-one', 'bad-two']) {
        handlers.get('provider.test.result')?.({
          type: 'provider.test.result',
          payload: {
            requestId,
            providerId: 'account-a',
            modelId,
            status: 'failed',
            diagnosis: 'model_unavailable',
            latencyMs: 10,
          },
        });
      }
      handlers.get('provider.test.complete')?.({
        type: 'provider.test.complete',
        payload: {
          requestId,
          providerId: 'account-a',
          passed: 0,
          failed: 2,
          cancelled: 0,
        },
      });
    });

    fireEvent.click(screen.getByText('Disable all failed (2)'));
    expect(screen.getByText('Disable 2 failed models?')).toBeTruthy();
    fireEvent.click(screen.getByText('Disable model'));
    expect(updatePrefs).toHaveBeenLastCalledWith({
      disabledModels: ['account-a/bad-one', 'account-a/bad-two'],
      favoriteModels: [],
      fallbackModels: [],
      fallbackProfiles: { default: [] },
    });
  });
});
