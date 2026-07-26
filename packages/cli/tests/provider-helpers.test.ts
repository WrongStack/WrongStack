import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  hasApiKey,
  buildPickableProviders,
  isKeylessLocalProvider,
  resolveProviderAlias,
  visibleModelIds,
} from '../src/provider-helpers.js';

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
});

afterEach(() => {
  process.env = savedEnv;
});

function fakeProvider(over: Record<string, unknown> = {}) {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    family: 'anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    models: [{ id: 'opus-4' }, { id: 'haiku-4' }],
    ...over,
  } as never;
}

function fakeRegistry(catalog: unknown[]) {
  return {
    listProviders: vi.fn().mockResolvedValue(catalog),
  } as never;
}

// ── hasApiKey ────────────────────────────────────────────────────────────────

describe('hasApiKey', () => {
  it('returns true when env var is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    expect(hasApiKey(fakeProvider())).toBe(true);
  });

  it('returns false when no env var and no config', () => {
    expect(hasApiKey(fakeProvider())).toBe(false);
  });

  it('returns false when config has no entry for the provider', () => {
    expect(hasApiKey(fakeProvider(), { providers: {} } as never)).toBe(false);
  });

  it('returns true when config has plaintext apiKey', () => {
    const config = { providers: { anthropic: { apiKey: 'sk-stored' } } } as never;
    expect(hasApiKey(fakeProvider(), config)).toBe(true);
  });

  it('returns true when config has apiKeys[] with at least one key', () => {
    const config = {
      providers: {
        anthropic: { apiKeys: [{ label: 'prod', apiKey: 'sk-prod' }] },
      },
    } as never;
    expect(hasApiKey(fakeProvider(), config)).toBe(true);
  });

  it('returns false when apiKeys[] is empty or entries lack apiKey', () => {
    const config = {
      providers: {
        anthropic: { apiKeys: [{ label: 'no-key' }] },
      },
    } as never;
    expect(hasApiKey(fakeProvider(), config)).toBe(false);
  });
});

// ── isKeylessLocalProvider ───────────────────────────────────────────────────

describe('isKeylessLocalProvider', () => {
  it('is true for a loopback gateway with no env vars (omniroute)', () => {
    expect(
      isKeylessLocalProvider({ apiBase: 'http://localhost:20128/v1', envVars: [] }),
    ).toBe(true);
  });

  it('is true for 127.x and ::1 hosts', () => {
    expect(isKeylessLocalProvider({ apiBase: 'http://127.0.0.1:4000/v1' })).toBe(true);
    expect(isKeylessLocalProvider({ apiBase: 'http://[::1]:8000/v1' })).toBe(true);
  });

  it('is false when the provider declares key env vars', () => {
    expect(
      isKeylessLocalProvider({ apiBase: 'http://localhost:20128/v1', envVars: ['OMNI_KEY'] }),
    ).toBe(false);
  });

  it('is false for a remote host', () => {
    expect(isKeylessLocalProvider({ apiBase: 'https://api.openai.com/v1' })).toBe(false);
  });

  it('is false when there is no base URL or it is malformed', () => {
    expect(isKeylessLocalProvider({})).toBe(false);
    expect(isKeylessLocalProvider({ apiBase: 'not a url' })).toBe(false);
  });
});

// ── resolveProviderAlias ─────────────────────────────────────────────────────

describe('resolveProviderAlias', () => {
  it('returns the id unchanged when no alias is set', () => {
    expect(resolveProviderAlias('anthropic', { providers: {} } as never)).toBe('anthropic');
  });

  it('returns the type when provider entry has a different type', () => {
    const config = {
      providers: { 'my-custom': { type: 'openai-compatible' } },
    } as never;
    expect(resolveProviderAlias('my-custom', config)).toBe('openai-compatible');
  });

  it('returns the original id when type matches the id (no alias)', () => {
    const config = {
      providers: { openai: { type: 'openai' } },
    } as never;
    expect(resolveProviderAlias('openai', config)).toBe('openai');
  });

  it('returns the id unchanged when no providers section exists', () => {
    expect(resolveProviderAlias('xyz', {} as never)).toBe('xyz');
  });
});

// ── visibleModelIds ──────────────────────────────────────────────────────────

describe('visibleModelIds', () => {
  it('treats empty ChatGPT/OpenAI/Codex saved model lists as refreshable catalog fallbacks', () => {
    const catalog = ['gpt-5.6-sol', 'gpt-5.4'];
    expect(
      visibleModelIds('openai-codex', { providers: {} } as never, catalog, { models: [] } as never),
    ).toEqual(catalog);
    expect(
      visibleModelIds('chatgpt', { providers: {} } as never, catalog, {
        type: 'openai-codex',
        models: [],
      } as never),
    ).toEqual(catalog);
    expect(
      visibleModelIds('openai', { providers: {} } as never, ['gpt-5.5'], { models: [] } as never),
    ).toEqual(['gpt-5.5']);
  });

  it('augments non-empty ChatGPT/OpenAI/Codex saved model lists with refreshed catalog models', () => {
    expect(
      visibleModelIds('codex', { providers: {} } as never, ['gpt-5.6-sol', 'gpt-5.4'], {
        type: 'openai-codex',
        models: ['legacy-codex'],
      } as never),
    ).toEqual(['legacy-codex', 'gpt-5.6-sol', 'gpt-5.4']);
  });

  it('treats a saved model list as additive for EVERY provider', () => {
    // Previously this was a strict allowlist for every provider outside a
    // four-entry hand-list, which hid catalog models the user's own plan
    // includes (kimi-for-coding offered 2 of 4; alibaba-token-plan 11 of 22).
    // The saved list now adds to the catalog instead of replacing it.
    expect(
      visibleModelIds('anthropic', { providers: {} } as never, ['opus', 'haiku'], {
        models: ['opus'],
      } as never),
    ).toEqual(['opus', 'haiku']);
  });

  it('never lets an empty saved list pin a provider to zero models', () => {
    // A real config had `github-copilot: { models: [] }` written by an auth
    // flow with nothing to cache yet, which made the provider list nothing at
    // all in the picker.
    expect(
      visibleModelIds('github-copilot', { providers: {} } as never, ['opus'], {
        models: [],
      } as never),
    ).toEqual(['opus']);
  });

  it('keeps config-only model ids the catalog does not carry', () => {
    expect(
      visibleModelIds('anthropic', { providers: {} } as never, ['opus'], {
        models: ['my-self-hosted'],
      } as never),
    ).toEqual(['my-self-hosted', 'opus']);
  });
});

// ── buildPickableProviders ───────────────────────────────────────────────────

describe('buildPickableProviders', () => {
  it('returns empty array when nothing is configured and no env keys', async () => {
    const registry = fakeRegistry([
      { id: 'anthropic', family: 'anthropic', envVars: ['ANTHROPIC_API_KEY'], models: [] },
    ]);
    const result = await buildPickableProviders(registry, { providers: {} } as never);
    expect(result).toEqual([]);
  });

  it('returns providers that have a key via env var', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-x';
    const registry = fakeRegistry([
      {
        id: 'anthropic',
        family: 'anthropic',
        envVars: ['ANTHROPIC_API_KEY'],
        models: [{ id: 'opus' }, { id: 'haiku' }],
      },
    ]);
    const result = await buildPickableProviders(registry, { providers: {} } as never);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('anthropic');
    expect(result[0]!.models).toEqual(['opus', 'haiku']);
  });

  it('returns providers with stored apiKey in config', async () => {
    const registry = fakeRegistry([
      {
        id: 'openai',
        family: 'openai',
        envVars: ['OPENAI_API_KEY'],
        models: [{ id: 'gpt-4o' }],
      },
    ]);
    const result = await buildPickableProviders(registry, {
      providers: { openai: { apiKey: 'sk-test' } },
    } as never);
    expect(result.map((p) => p.id)).toContain('openai');
  });

  it('adds config models on top of the catalog list', async () => {
    const registry = fakeRegistry([
      {
        id: 'custom',
        family: 'openai',
        envVars: [],
        models: [{ id: 'default-model' }],
      },
    ]);
    const result = await buildPickableProviders(registry, {
      providers: { custom: { apiKey: 'sk', models: ['m1', 'm2'] } },
    } as never);
    const custom = result.find((p) => p.id === 'custom');
    // Config-named ids first, then whatever models.dev knows for the provider.
    expect(custom?.models).toEqual(['m1', 'm2', 'default-model']);
  });

  it('includes a keyless local gateway from the catalog (omniroute)', async () => {
    const registry = fakeRegistry([
      {
        id: 'omniroute',
        family: 'openai-compatible',
        apiBase: 'http://localhost:20128/v1',
        envVars: [],
        models: [{ id: 'cc/claude-opus-4-8' }, { id: 'openai/gpt-5-codex' }],
      },
    ]);
    const result = await buildPickableProviders(registry, { providers: {} } as never);
    const omni = result.find((p) => p.id === 'omniroute');
    expect(omni).toBeDefined();
    expect(omni?.models).toEqual(['cc/claude-opus-4-8', 'openai/gpt-5-codex']);
  });

  it('includes a keyless local gateway configured as a custom loopback provider', async () => {
    const registry = fakeRegistry([]);
    const result = await buildPickableProviders(registry, {
      providers: {
        omniroute: {
          type: 'omniroute',
          family: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:20128/v1',
          models: ['cc/claude-opus-4-8'],
        },
      },
    } as never);
    const omni = result.find((p) => p.id === 'omniroute');
    expect(omni?.models).toEqual(['cc/claude-opus-4-8']);
  });

  it('filters out unsupported family providers', async () => {
    const registry = fakeRegistry([
      {
        id: 'bad',
        family: 'unsupported',
        envVars: ['BAD_KEY'],
        models: [],
      },
    ]);
    process.env.BAD_KEY = 'x';
    const result = await buildPickableProviders(registry, { providers: {} } as never);
    expect(result.find((p) => p.id === 'bad')).toBeUndefined();
    delete process.env.BAD_KEY;
  });

  it('resolves family via cfg.type alias when cfg.family is missing', async () => {
    const registry = fakeRegistry([
      {
        id: 'openai',
        family: 'openai',
        envVars: ['OPENAI_API_KEY'],
        models: [{ id: 'gpt-4o' }],
      },
    ]);
    const result = await buildPickableProviders(registry, {
      providers: { 'my-alias': { type: 'openai', apiKey: 'sk' } },
    } as never);
    const alias = result.find((p) => p.id === 'my-alias');
    expect(alias?.family).toBe('openai');
    expect(alias?.models).toEqual(['gpt-4o']);
  });

  it('falls back to "unsupported" family when no inherited entry is found', async () => {
    const registry = fakeRegistry([]);
    const result = await buildPickableProviders(registry, {
      providers: { mystery: { apiKey: 'sk' } },
    } as never);
    expect(result.find((p) => p.id === 'mystery')).toBeUndefined();
  });

  it('survives a catalog failure (listProviders rejects)', async () => {
    const registry = {
      listProviders: vi.fn().mockRejectedValue(new Error('offline')),
    } as never;
    const result = await buildPickableProviders(registry, {
      providers: { openai: { family: 'openai', apiKey: 'sk', models: ['gpt'] } },
    } as never);
    expect(result).toEqual([{ id: 'openai', family: 'openai', models: ['gpt'] }]);
  });

  it('does not duplicate providers also present in catalog', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    const registry = fakeRegistry([
      {
        id: 'anthropic',
        family: 'anthropic',
        envVars: ['ANTHROPIC_API_KEY'],
        models: [{ id: 'opus' }],
      },
    ]);
    const result = await buildPickableProviders(registry, {
      providers: { anthropic: { apiKey: 'sk-stored', family: 'anthropic', models: ['custom'] } },
    } as never);
    // Should appear only once
    const anths = result.filter((p) => p.id === 'anthropic');
    expect(anths).toHaveLength(1);
    // The overlay's ids lead, but the catalog's are no longer dropped.
    expect(anths[0]!.models).toEqual(['custom', 'opus']);
  });
});
