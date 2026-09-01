import type { Config, ModelsRegistry, ResolvedProvider } from '@wrongstack/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runOAuthLoginMenu = vi.fn(async () => undefined);
const addFromCatalog = vi.fn(async () => true);
const runAuthLocal = vi.fn(async () => 0);

vi.mock('../src/auth-menu/oauth-menu.js', () => ({ runOAuthLoginMenu }));
vi.mock('../src/auth-menu/add-provider.js', () => ({ addFromCatalog, addCustomProvider: vi.fn() }));
vi.mock('../src/auth-menu/local.js', () => ({ runAuthLocal }));

const { hasAnyCredential, runFirstRunSetup } = await import('../src/pre-launch/first-run.js');

function config(overrides: Partial<Config> = {}): Config {
  return { providers: {}, ...overrides } as Config;
}

function registry(providers: ResolvedProvider[] = []): ModelsRegistry {
  return { listProviders: async () => providers } as unknown as ModelsRegistry;
}

function catalogProvider(id: string, envVars: string[]): ResolvedProvider {
  return { id, name: id, family: 'openai-compatible', envVars, models: [] };
}

describe('hasAnyCredential', () => {
  it('is false on a machine with nothing configured', async () => {
    expect(await hasAnyCredential(config(), registry(), {})).toBe(false);
  });

  it('sees a saved API key', async () => {
    const cfg = config({
      providers: {
        anthropic: { type: 'anthropic', apiKeys: [{ label: 'a', apiKey: 'sk-x', createdAt: '' }] },
      },
    });
    expect(await hasAnyCredential(cfg, registry(), {})).toBe(true);
  });

  it('sees an OAuth token, which is stored as an apiKeys entry', async () => {
    const cfg = config({
      providers: {
        'anthropic-oauth': {
          type: 'anthropic-oauth',
          family: 'anthropic-oauth',
          apiKeys: [{ label: 'oauth-default', apiKey: 'tok', createdAt: '', authMethod: 'oauth' }],
        },
      },
    });
    expect(await hasAnyCredential(cfg, registry(), {})).toBe(true);
  });

  it('sees a keyless loopback gateway', async () => {
    const cfg = config({
      providers: { ollama: { type: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', envVars: [] } },
    });
    expect(await hasAnyCredential(cfg, registry(), {})).toBe(true);
  });

  it('sees an env var from a shipped provider definition without any catalog', async () => {
    // This is the offline / pruned-catalog case: the definition list is local,
    // so it must answer correctly when listProviders() returns nothing.
    expect(await hasAnyCredential(config(), registry(), { ANTHROPIC_API_KEY: 'sk-x' })).toBe(true);
  });

  it('sees an env var from a catalog-only provider', async () => {
    const reg = registry([catalogProvider('somecloud', ['SOMECLOUD_KEY'])]);
    expect(await hasAnyCredential(config(), reg, { SOMECLOUD_KEY: 'k' })).toBe(true);
  });

  it('stays false when the catalog is unreachable and nothing local is set', async () => {
    const reg = {
      listProviders: async () => {
        throw new Error('offline');
      },
    } as unknown as ModelsRegistry;
    expect(await hasAnyCredential(config(), reg, {})).toBe(false);
  });

  it('ignores an env var that is set but empty', async () => {
    expect(await hasAnyCredential(config(), registry(), { ANTHROPIC_API_KEY: '' })).toBe(false);
  });
});

describe('runFirstRunSetup', () => {
  let written: string[];
  let answers: string[];

  function deps(reloadConfig: () => Promise<Config> = async () => config()) {
    return {
      renderer: {
        write: (s: string) => written.push(s),
        writeInfo: (s: string) => written.push(s),
        writeWarning: (s: string) => written.push(s),
        writeError: (s: string) => written.push(s),
      },
      reader: { readLine: async () => answers.shift() ?? 'q', readSecret: async () => '' },
      modelsRegistry: registry(),
      vault: {} as never,
      profileConfigPath: '/tmp/config.json',
      reloadConfig,
      // The gate only uses the structural subset of these two types.
    } as unknown as Parameters<typeof runFirstRunSetup>[0];
  }

  beforeEach(() => {
    written = [];
    answers = [];
    runOAuthLoginMenu.mockClear();
    addFromCatalog.mockClear();
    runAuthLocal.mockClear();
  });

  it('offers all four routes on screen', async () => {
    answers = ['q'];
    await runFirstRunSetup(deps());
    const screen = written.join('');
    expect(screen).toContain('Sign in with a subscription');
    expect(screen).toContain('Add an API key');
    expect(screen).toContain('Use a local server');
    expect(screen).toContain('Continue without a key');
  });

  it('returns setup-mode for choice 4', async () => {
    answers = ['4'];
    expect(await runFirstRunSetup(deps())).toEqual({ kind: 'setup-mode' });
  });

  it('quits on q and points at wstack auth', async () => {
    answers = ['q'];
    expect(await runFirstRunSetup(deps())).toEqual({ kind: 'quit' });
    expect(written.join('')).toContain('wstack auth');
  });

  it('treats a bare Enter as quit rather than looping forever', async () => {
    answers = [''];
    expect(await runFirstRunSetup(deps())).toEqual({ kind: 'quit' });
  });

  it('routes each numeric choice to its auth flow', async () => {
    const keyed = config({
      providers: { x: { type: 'x', apiKeys: [{ label: 'a', apiKey: 'k', createdAt: '' }] } },
    });
    answers = ['1'];
    expect(await runFirstRunSetup(deps(async () => keyed))).toEqual({ kind: 'configured' });
    expect(runOAuthLoginMenu).toHaveBeenCalledTimes(1);

    written = [];
    answers = ['2'];
    expect(await runFirstRunSetup(deps(async () => keyed))).toEqual({ kind: 'configured' });
    expect(addFromCatalog).toHaveBeenCalledTimes(1);

    written = [];
    answers = ['3'];
    expect(await runFirstRunSetup(deps(async () => keyed))).toEqual({ kind: 'configured' });
    expect(runAuthLocal).toHaveBeenCalledTimes(1);
  });

  it('re-asks instead of falling through when an auth flow adds nothing', async () => {
    // Falling through to the picker here would land the user in the exact
    // dead end this gate exists to remove.
    answers = ['2', '4'];
    expect(await runFirstRunSetup(deps())).toEqual({ kind: 'setup-mode' });
    expect(addFromCatalog).toHaveBeenCalledTimes(1);
    expect(written.join('')).toContain('Still no usable credential');
  });

  it('survives an auth flow that throws', async () => {
    addFromCatalog.mockRejectedValueOnce(new Error('network down'));
    answers = ['2', '4'];
    expect(await runFirstRunSetup(deps())).toEqual({ kind: 'setup-mode' });
    expect(written.join('')).toContain('network down');
  });

  it('rejects an unknown selection and asks again', async () => {
    answers = ['zzz', '4'];
    expect(await runFirstRunSetup(deps())).toEqual({ kind: 'setup-mode' });
    expect(written.join('')).toContain('Unknown selection');
  });
});
