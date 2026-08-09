import type { Config, ModelsRegistry } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { autoSelectSavedProvider } from '../src/boot.js';

/**
 * `autoSelectSavedProvider` is the non-interactive (WebUI / --no-interactive)
 * analogue of the TUI picker: when the active provider/model pointers are unset
 * but a usable saved provider exists (e.g. a custom one added via /auth), it
 * resolves a concrete `{ provider, model }` so boot doesn't fall through to the
 * "No provider or model configured" error. These pin the resolution order.
 */

function cfg(providers: Config['providers'], provider = '', model = ''): Config {
  return { provider, model, providers } as never as Config;
}

function registry(catalog: Record<string, { models?: { id: string }[] }>): ModelsRegistry {
  return {
    getProvider: async (id: string) => catalog[id],
  } as never as ModelsRegistry;
}

describe('autoSelectSavedProvider', () => {
  it('adopts a custom provider using its saved models allowlist', async () => {
    const picked = await autoSelectSavedProvider(
      cfg({
        'custom-1': { type: 'custom-1', family: 'openai-compatible', models: ['m-a', 'm-b'] },
      }),
      registry({}),
    );
    expect(picked).toEqual({ provider: 'custom-1', model: 'm-a' });
  });

  it('falls back to the catalog first model when no saved allowlist', async () => {
    const picked = await autoSelectSavedProvider(
      cfg({ anthropic: { type: 'anthropic' } }),
      registry({ anthropic: { models: [{ id: 'claude-a' }, { id: 'claude-b' }] } }),
    );
    expect(picked).toEqual({ provider: 'anthropic', model: 'claude-a' });
  });

  it('honors an already-set provider pointer when only the model is missing', async () => {
    const picked = await autoSelectSavedProvider(
      cfg(
        {
          'custom-1': { type: 'custom-1', models: ['a'] },
          'custom-2': { type: 'custom-2', models: ['b'] },
        },
        'custom-2',
      ),
      registry({}),
    );
    expect(picked).toEqual({ provider: 'custom-2', model: 'b' });
  });

  it('returns undefined when no provider yields a concrete model', async () => {
    const picked = await autoSelectSavedProvider(
      cfg({
        'custom-1': { type: 'custom-1', family: 'openai-compatible', baseUrl: 'http://x/v1' },
      }),
      registry({}),
    );
    expect(picked).toBeUndefined();
  });

  it('returns undefined for an empty providers map', async () => {
    expect(await autoSelectSavedProvider(cfg({}), registry({}))).toBeUndefined();
  });
});
