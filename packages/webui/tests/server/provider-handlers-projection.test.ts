import type { ProviderConfig } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { projectSavedProviders, type SavedProviderView } from '@wrongstack/webui-server';

/**
 * `projectSavedProviders` is the canonical projection from
 * `ProviderConfig` (in-memory, on disk) to the wire shape sent over
 * the `providers.saved` WebSocket broadcast. It's the contract
 * the WebUI's `<ProviderModelsPanel>` consumes — when the picked
 * model id or models allowlist is missing from a card, the panel
 * renders the empty state.
 *
 * The function lives in `provider-handlers.ts` next to the WS
 * dispatch, but it's pure data and tests live here.
 */

const NOW = '2026-06-15T10:00:00.000Z';

function cfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { type: 'ollama', ...over };
}

function asView(input: Record<string, ProviderConfig>): SavedProviderView[] {
  return projectSavedProviders(input);
}

describe('projectSavedProviders', () => {
  it('returns an empty list for an empty input', () => {
    expect(asView({})).toEqual([]);
  });

  it('passes through the id, family, and baseUrl verbatim', () => {
    const [view] = asView({
      ollama: cfg({ family: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }),
    });
    expect(view?.id).toBe('ollama');
    expect(view?.family).toBe('openai-compatible');
    expect(view?.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('falls back to the id when family is unset', () => {
    const [view] = asView({ ollama: cfg() });
    expect(view?.family).toBe('ollama');
  });

  it('surfaces pickedModelId from the first entry of `models`', () => {
    const [view] = asView({
      ollama: cfg({ models: ['llama3.1:8b', 'qwen2.5:7b'] }),
    });
    expect(view?.pickedModelId).toBe('llama3.1:8b');
    expect(view?.models).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
  });

  it('leaves pickedModelId undefined when `models` is empty or unset', () => {
    expect(asView({ ollama: cfg() })[0]?.pickedModelId).toBeUndefined();
    expect(asView({ ollama: cfg({ models: [] }) })[0]?.pickedModelId).toBeUndefined();
  });

  it('always includes the models field (even when empty/undefined) so the WebUI can render the empty state', () => {
    expect(asView({ ollama: cfg() })[0]?.models).toBeUndefined();
    expect(asView({ ollama: cfg({ models: [] }) })[0]?.models).toEqual([]);
  });

  it('masks every API key', () => {
    const [view] = asView({
      ollama: cfg({
        apiKeys: [{ label: 'default', apiKey: 'sk-very-long-secret-1234', createdAt: NOW }],
        activeKey: 'default',
      }),
    });
    const key = view?.apiKeys[0];
    expect(key).toBeDefined();
    expect(key?.label).toBe('default');
    // The masked form is "sk-v…1234" — the middle is hidden, but
    // the last 4 chars remain (industry-standard masking). The
    // invariant we care about is that the *plaintext* secret body
    // is not exposed: the chars between the prefix and the suffix
    // must not be visible.
    expect(key?.maskedKey).not.toContain('very-long-secret');
    expect(key?.maskedKey).toContain('…');
    expect(key?.isActive).toBe(true);
    expect(key?.createdAt).toBe(NOW);
  });

  it('flags the active key correctly across multiple entries', () => {
    const [view] = asView({
      vllm: cfg({
        apiKeys: [
          { label: 'a', apiKey: 'ka', createdAt: NOW },
          { label: 'b', apiKey: 'kb', createdAt: NOW },
          { label: 'c', apiKey: 'kc', createdAt: NOW },
        ],
        activeKey: 'b',
      }),
    });
    const flags = view?.apiKeys.map((k) => k.isActive);
    expect(flags).toEqual([false, true, false]);
  });

  it('returns no active key when activeKey does not match any entry', () => {
    const [view] = asView({
      ollama: cfg({
        apiKeys: [{ label: 'a', apiKey: 'ka', createdAt: NOW }],
        activeKey: 'nonexistent',
      }),
    });
    expect(view?.apiKeys.every((k) => !k.isActive)).toBe(true);
  });

  it('upgrades a legacy single apiKey through normalizeKeys', () => {
    const [view] = asView({
      legacy: cfg({ apiKey: 'sk-legacy-secret' }),
    });
    // The legacy key becomes a `default` entry and is masked.
    expect(view?.apiKeys).toHaveLength(1);
    expect(view?.apiKeys[0]?.label).toBe('default');
    expect(view?.apiKeys[0]?.maskedKey).not.toContain('sk-legacy-secret');
  });

  it('returns providers in the order they were inserted (Object.keys order)', () => {
    const views = asView({
      a: cfg(),
      b: cfg(),
      c: cfg(),
    });
    expect(views.map((v) => v.id)).toEqual(['a', 'b', 'c']);
  });

  it('emits all fields the WebUI panel consumes (pickedModelId, models, apiKeys)', () => {
    const [view] = asView({
      ollama: cfg({
        family: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
        models: ['llama3.1:8b'],
        apiKeys: [{ label: 'default', apiKey: 'sk-secret', createdAt: NOW }],
        activeKey: 'default',
      }),
    });
    expect(view).toEqual({
      id: 'ollama',
      family: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      pickedModelId: 'llama3.1:8b',
      models: ['llama3.1:8b'],
      apiKeys: [
        {
          label: 'default',
          // The masked form is "sk-s…cret" — first 4 + ellipsis +
          // last 4. The plaintext body between must be hidden.
          maskedKey: expect.stringMatching(/^sk-s…cret$/),
          isActive: true,
          createdAt: NOW,
        },
      ],
    });
  });
});
