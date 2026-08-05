/**
 * Integration coverage for the interactive auth-menu flows the TUI panel
 * drives through the {@link AuthFlowIo} bridge, plus the readline menus
 * that own those flows (`runTopMenu` / `manageProvider`).
 *
 * Complements `auth-panel-service.test.ts` (which mocks `local.js` and the
 * OAuth modules): here the REAL flow modules run end-to-end against a real
 * config file + real `DefaultSecretVault` — only the health probe
 * (`@wrongstack/runtime/probe`) is mocked so `runAuthLocal` is hermetic.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import type { ModelsRegistry, ResolvedModel, ResolvedProvider } from '@wrongstack/core/types';
import type { AuthFlowIo } from '@wrongstack/tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthMenuDeps } from '../src/auth-menu/types.js';
import { createAuthPanelHost } from '../src/auth-menu/panel-service.js';
import { runTopMenu } from '../src/auth-menu/top-menu.js';
import { manageProvider } from '../src/auth-menu/provider-menu.js';
import { addKeyForProvider } from '../src/auth-menu/add-provider.js';

// ── Hermetic probe ─────────────────────────────────────────────────────────
const probeMock = vi.hoisted(() => vi.fn());

vi.mock('@wrongstack/runtime/probe', async (orig) => ({
  ...(await orig<typeof import('@wrongstack/runtime/probe')>()),
  probeLocalLlm: probeMock,
}));

const PROBE_OK = {
  ok: true,
  status: 'ok',
  modelIds: ['llama3.1', 'qwen2.5'],
  modelCount: 2,
  elapsedMs: 15,
} as const;

const PROBE_UNREACHABLE = {
  ok: false,
  status: 'unreachable',
  detail: 'ECONNREFUSED',
} as const;

// ── Test helpers ───────────────────────────────────────────────────────────

function makeRegistry(
  catalog: Partial<ResolvedProvider>[] = [],
  models: Array<Partial<ResolvedModel> & { providerId: string; modelId: string }> = [],
): ModelsRegistry {
  return {
    getProvider: vi.fn(async (id: string) => catalog.find((p) => p.id === id)),
    listProviders: vi.fn(async () => catalog as ResolvedProvider[]),
    getModel: vi.fn(async (providerId: string, modelId: string) =>
      models.find((m) => m.providerId === providerId && m.modelId === modelId),
    ) as ModelsRegistry['getModel'],
    suggestModel: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  } as never as ModelsRegistry;
}

async function setup(
  opts: {
    catalog?: Partial<ResolvedProvider>[];
    models?: Array<Partial<ResolvedModel> & { providerId: string; modelId: string }>;
    preExisting?: object;
  } = {},
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-auth-flows-'));
  const configPath = path.join(tmpDir, 'config.json');
  if (opts.preExisting) {
    await fs.writeFile(configPath, JSON.stringify(opts.preExisting), { mode: 0o600 });
  }
  const vault = new DefaultSecretVault({ keyFile: path.join(tmpDir, '.key') });
  const registry = makeRegistry(opts.catalog ?? [], opts.models ?? []);
  const host = createAuthPanelHost({
    vault,
    modelsRegistry: registry,
    profileConfigPath: configPath,
  });
  return { host, registry, configPath, tmpDir, vault };
}

/** Scripted AuthFlowIo: each prompt consumes the next answer (Error → reject). */
function makeIo(answers: Array<string | Error> = []) {
  const log: string[] = [];
  const prompts: Array<{ question: string; secret: boolean }> = [];
  let i = 0;
  const io: AuthFlowIo = {
    onLog: (line) => log.push(line),
    prompt: async (question, { secret }) => {
      prompts.push({ question, secret });
      const answer = answers[i++];
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    signal: new AbortController().signal,
  };
  return { io, log, prompts };
}

async function readProviders(configPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}; // nothing saved yet
    throw err;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return (parsed.providers as Record<string, unknown>) ?? {};
}

/** Scripted AuthMenuDeps for the readline menus (one shared answer queue). */
function menuCtx(
  configPath: string,
  vault: DefaultSecretVault,
  registry: ModelsRegistry,
  answers: Array<string | Error> = [],
) {
  const logs: string[] = [];
  let i = 0;
  const next = () => {
    const a = answers[i++];
    if (a instanceof Error) throw a;
    return a ?? '';
  };
  const deps: AuthMenuDeps = {
    renderer: {
      write: (s: string) => logs.push(s),
      writeInfo: (s: string) => logs.push(s),
      writeWarning: (s: string) => logs.push(s),
      writeError: (s: string) => logs.push(s),
    },
    reader: {
      readLine: async () => next(),
      readSecret: async () => next(),
    },
    modelsRegistry: registry,
    vault,
    profileConfigPath: configPath,
  };
  return { deps, logs };
}

const ANTHROPIC_ONE_KEY = {
  providers: {
    anthropic: {
      type: 'anthropic',
      family: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKeys: [
        { label: 'default', apiKey: 'sk-work-1234567890', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      activeKey: 'default',
    },
  },
};

const ANTHROPIC_CATALOG: Partial<ResolvedProvider>[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    family: 'anthropic',
    apiBase: 'https://api.anthropic.com',
    envVars: ['ANTHROPIC_API_KEY'],
    models: [{ id: 'claude-sonnet-4-6' }],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  probeMock.mockResolvedValue(PROBE_OK);
});

// ── Panel host: addCustomProvider (real add-provider flow) ────────────────
describe('panel host — addCustomProvider flow', () => {
  it('prompts id/family/baseUrl/models/envVars then label+key and saves', async () => {
    const { host, configPath } = await setup();
    const { io, log } = makeIo([
      'my-proxy',
      'openai-compatible',
      'http://localhost:9999/v1',
      'm1, m2',
      'KEY_ENV',
      'default',
      'sk-x-1234567890',
    ]);
    const result = await host.addCustomProvider(io);
    expect(result.ok).toBe(true);
    const providers = await readProviders(configPath);
    expect(providers['my-proxy']).toMatchObject({
      type: 'my-proxy',
      family: 'openai-compatible',
      baseUrl: 'http://localhost:9999/v1',
      models: ['m1', 'm2'],
      envVars: ['KEY_ENV'],
      activeKey: 'default',
    });
    // First provider added → adopted as the default (template has models).
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw.provider).toBe('my-proxy');
    expect(raw.model).toBe('m1');
    expect(log.some((l) => l.includes('Saved my-proxy'))).toBe(true);
  });

  it('aborts on q at the provider id', async () => {
    const { host } = await setup();
    const { io } = makeIo(['q']);
    expect((await host.addCustomProvider(io)).ok).toBe(false);
  });

  it('aborts when the id already exists', async () => {
    const { host, configPath } = await setup({ preExisting: ANTHROPIC_ONE_KEY });
    const { io, log } = makeIo(['anthropic']);
    const result = await host.addCustomProvider(io);
    expect(result.ok).toBe(false);
    expect(log.some((l) => l.includes('already exists'))).toBe(true);
    expect(Object.keys(await readProviders(configPath))).toEqual(['anthropic']);
  });

  it('auto-assigns a generated custom-N id on a blank id', async () => {
    const { host, configPath } = await setup();
    // '', family, baseUrl, models, envVars, label, key
    const { io, log } = makeIo(['', 'openai', '', '', '', 'default', 'sk-g-1234567890']);
    const result = await host.addCustomProvider(io);
    expect(result.ok).toBe(true);
    expect(log.some((l) => l.includes('Using generated id:'))).toBe(true);
    const providers = await readProviders(configPath);
    const ids = Object.keys(providers);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^custom-/);
  });

  it('aborts on q at the family prompt', async () => {
    const { host, configPath } = await setup();
    const { io } = makeIo(['my-proxy', 'q']);
    expect((await host.addCustomProvider(io)).ok).toBe(false);
    expect(await readProviders(configPath)).toEqual({});
  });

  it('rejects an invalid family', async () => {
    const { host } = await setup();
    const { io, log } = makeIo(['my-proxy', 'mystery']);
    expect((await host.addCustomProvider(io)).ok).toBe(false);
    expect(log.some((l) => l.includes('Invalid family: "mystery"'))).toBe(true);
  });
});

// ── Panel host: addCatalogProvider (addKeyForCatalogProvider real flow) ────
describe('panel host — addCatalogProvider flow', () => {
  it('keeps catalog defaults and saves under the suggested alias', async () => {
    const { host, configPath } = await setup({ catalog: ANTHROPIC_CATALOG });
    const { io, log, prompts } = makeIo(['', '', '', 'default', 'sk-ant-1234567890']);
    const result = await host.addCatalogProvider('anthropic', io);
    expect(result.ok).toBe(true);
    expect(prompts[0]?.secret).toBe(false); // family
    expect(prompts[1]?.secret).toBe(false); // baseUrl
    expect(prompts[2]?.secret).toBe(false); // alias
    const providers = await readProviders(configPath);
    expect(providers['anthropic']).toMatchObject({
      type: 'anthropic',
      family: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      envVars: ['ANTHROPIC_API_KEY'],
      activeKey: 'default',
    });
    // Adoption via the catalog model.
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw.provider).toBe('anthropic');
    expect(raw.model).toBe('claude-sonnet-4-6');
    expect(log.some((l) => l.includes('Saved anthropic'))).toBe(true);
  });

  it('applies family/baseUrl overrides and a custom alias', async () => {
    const { host, configPath } = await setup({ catalog: ANTHROPIC_CATALOG });
    const { io } = makeIo(['google', 'http://override.local/v1', 'g-anthropic', 'default', 'sk-g-1234567890']);
    expect((await host.addCatalogProvider('anthropic', io)).ok).toBe(true);
    const providers = await readProviders(configPath);
    expect(providers['g-anthropic']).toMatchObject({
      type: 'anthropic',
      family: 'google',
      baseUrl: 'http://override.local/v1',
    });
    expect(providers['anthropic']).toBeUndefined();
  });

  it('q at the family prompt aborts before saving', async () => {
    const { host, configPath } = await setup({ catalog: ANTHROPIC_CATALOG });
    const { io } = makeIo(['q']);
    expect((await host.addCatalogProvider('anthropic', io)).ok).toBe(false);
    expect(await readProviders(configPath)).toEqual({});
  });

  it('refuses an alias that conflicts on family/baseUrl', async () => {
    const { host, configPath } = await setup({
      catalog: ANTHROPIC_CATALOG,
      preExisting: {
        providers: {
          anthropic: { type: 'anthropic', family: 'openai' },
        },
      },
    });
    const { io, log } = makeIo(['', '', 'anthropic', 'default', 'sk-c-1234567890']);
    const result = await host.addCatalogProvider('anthropic', io);
    expect(result.ok).toBe(false);
    expect(log.some((l) => l.includes('already exists with different family/baseUrl'))).toBe(true);
  });

  it('rejects an invalid family override', async () => {
    const { host } = await setup({ catalog: ANTHROPIC_CATALOG });
    const { io, log } = makeIo(['mystery']);
    const result = await host.addCatalogProvider('anthropic', io);
    expect(result.ok).toBe(false);
    expect(log.some((l) => l.includes('Invalid family: "mystery"'))).toBe(true);
  });

  it('aborts on q at the base URL prompt', async () => {
    const { host, configPath } = await setup({ catalog: ANTHROPIC_CATALOG });
    const { io } = makeIo(['google', 'q']);
    expect((await host.addCatalogProvider('anthropic', io)).ok).toBe(false);
    expect(await readProviders(configPath)).toEqual({});
  });

  it('bumps the suggested alias when the family-specific alias is taken', async () => {
    const { host, configPath } = await setup({
      catalog: ANTHROPIC_CATALOG,
      preExisting: {
        providers: {
          'anthropic-google': { type: 'anthropic', family: 'google' },
        },
      },
    });
    // family 'google' → suggested 'anthropic-google' (taken) → 'anthropic-google-2'
    const { io } = makeIo(['google', '', '', 'default', 'sk-g-1234567890']);
    const result = await host.addCatalogProvider('anthropic', io);
    expect(result.ok).toBe(true);
    const providers = await readProviders(configPath);
    expect(providers['anthropic-google-2']).toMatchObject({
      type: 'anthropic',
      family: 'google',
    });
    expect(providers['anthropic-google']).toBeDefined();
  });

  it('proceeds when an existing alias matches family and baseUrl', async () => {
    const { host, configPath } = await setup({
      catalog: ANTHROPIC_CATALOG,
      preExisting: {
        providers: {
          anthropic: {
            type: 'anthropic',
            family: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
          },
        },
      },
    });
    // Same family + baseUrl → no conflict → adds the key to the existing entry.
    const { io } = makeIo(['', '', 'anthropic', 'work', 'sk-w-1234567890']);
    const result = await host.addCatalogProvider('anthropic', io);
    expect(result.ok).toBe(true);
    const providers = await readProviders(configPath);
    expect((providers['anthropic'] as { apiKeys?: unknown[] }).apiKeys).toHaveLength(1);
    expect((providers['anthropic'] as { activeKey?: string }).activeKey).toBe('work');
  });
});

// ── Panel host: addLocal (REAL runAuthLocal through the bridge) ───────────
describe('panel host — addLocal (real runAuthLocal)', () => {
  it('ollama: default URL, no key prompt, models captured from the probe', async () => {
    const { host, configPath } = await setup();
    const { io, log } = makeIo(['']);
    const result = await host.addLocal('ollama', io);
    expect(result.ok).toBe(true);
    expect(probeMock).toHaveBeenCalledTimes(1);
    const providers = await readProviders(configPath);
    expect(providers['ollama']).toMatchObject({
      type: 'ollama',
      family: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      models: ['llama3.1', 'qwen2.5'],
    });
    expect(log.some((l) => l.includes('Saved ollama'))).toBe(true);
  });

  it('vllm: failed probe + declined save-anyway → nothing saved, exit 0', async () => {
    probeMock.mockResolvedValue(PROBE_UNREACHABLE);
    const { host, configPath } = await setup();
    // baseUrl '', optional key (Enter to skip) '', save-anyway 'n'
    const { io, log } = makeIo(['', '', 'n']);
    const result = await host.addLocal('vllm', io);
    expect(result.ok).toBe(true); // decline is a clean exit (code 0)
    expect(log.some((l) => l.includes('Cancelled. Nothing saved.'))).toBe(true);
    expect(await readProviders(configPath)).toEqual({});
  });

  it('vllm: failed probe + save-anyway → provider saved despite the probe', async () => {
    probeMock.mockResolvedValue(PROBE_UNREACHABLE);
    const { host, configPath } = await setup();
    const { io } = makeIo(['', '', 'y']);
    expect((await host.addLocal('vllm', io)).ok).toBe(true);
    const providers = await readProviders(configPath);
    expect(providers['vllm']).toMatchObject({
      type: 'vllm',
      family: 'openai-compatible',
      baseUrl: 'http://localhost:8000/v1',
    });
  });

  it('rejects an unknown preset id', async () => {
    const { host } = await setup();
    const { io, log } = makeIo();
    expect((await host.addLocal('nope', io)).ok).toBe(false);
    expect(log.some((l) => l.includes('Unknown local preset "nope"'))).toBe(true);
  });
});

// ── Panel host: remaining error branches ──────────────────────────────────
describe('panel host — error branches', () => {
  it('updateKey reports a provider that vanished', async () => {
    const { host } = await setup();
    const { io, log } = makeIo(['sk-x']);
    const result = await host.updateKey('ghost', 'work', io);
    expect(result.ok).toBe(false);
    expect(log.some((l) => l.includes('Provider "ghost" no longer in config.'))).toBe(true);
  });

  it('editField family: valid set, unset, invalid, and missing provider', async () => {
    const { host, configPath } = await setup({ preExisting: ANTHROPIC_ONE_KEY });
    expect((await host.editField('anthropic', 'family', makeIo(['google']).io)).ok).toBe(true);
    expect((await readProviders(configPath))['anthropic']).toMatchObject({ family: 'google' });

    expect((await host.editField('anthropic', 'family', makeIo(['']).io)).ok).toBe(true);
    const afterUnset = (await readProviders(configPath))['anthropic'] as Record<string, unknown>;
    expect(afterUnset.family).toBeUndefined();

    const { io, log } = makeIo(['mystery']);
    expect((await host.editField('anthropic', 'family', io)).ok).toBe(false);
    expect(log.some((l) => l.includes('Invalid family: "mystery"'))).toBe(true);

    const missing = makeIo([]);
    expect((await host.editField('ghost', 'family', missing.io)).ok).toBe(false);
    expect(missing.log.some((l) => l.includes('Provider "ghost" no longer in config.'))).toBe(true);
  });

  it('editField models: empty list clears to catalog default', async () => {
    const { host, configPath } = await setup({
      preExisting: {
        providers: { anthropic: { type: 'anthropic', family: 'anthropic', models: ['a', 'b'] } },
      },
    });
    const { io, log } = makeIo(['']);
    expect((await host.editField('anthropic', 'models', io)).ok).toBe(true);
    expect(log.some((l) => l.includes('(catalog default)'))).toBe(true);
    expect(((await readProviders(configPath))['anthropic'] as Record<string, unknown>).models).toBeUndefined();
  });

  it('editModelDetails reports a provider that vanished', async () => {
    const { host } = await setup();
    const { io, log } = makeIo([]);
    expect((await host.editModelDetails('ghost', 'm', io)).ok).toBe(false);
    expect(log.some((l) => l.includes('Provider "ghost" no longer in config.'))).toBe(true);
  });

  it('addModel: missing provider, catalog miss, and duplicate id', async () => {
    const { host, configPath } = await setup({
      preExisting: {
        providers: { anthropic: { type: 'anthropic', family: 'anthropic', models: ['m1'] } },
      },
    });

    const missing = makeIo([]);
    expect((await host.addModel('ghost', missing.io)).ok).toBe(false);
    expect(missing.log.some((l) => l.includes('Provider "ghost" no longer in config.'))).toBe(true);

    const miss = makeIo(['m2']); // getModel rejects → no catalog entry
    expect((await host.addModel('anthropic', miss.io, { fromCatalog: true })).ok).toBe(true);
    expect(miss.log.some((l) => l.includes('not found in catalog'))).toBe(true);

    const dup = makeIo(['m1']);
    expect((await host.addModel('anthropic', dup.io)).ok).toBe(true);
    const providers = await readProviders(configPath);
    expect((providers['anthropic'] as Record<string, unknown>).models).toEqual(['m1', 'm2']);
  });

  it('removeModel and resetModelToCatalog report a provider that vanished', async () => {
    const { host } = await setup();
    expect(await host.removeModel('ghost', 'm')).toMatch(/no longer in config/);
    expect(await host.resetModelToCatalog('ghost', 'm')).toMatch(/no longer in config/);
  });
});

// ── runTopMenu (interactive menu) ─────────────────────────────────────────
describe('runTopMenu — interactive menu', () => {
  it('quits immediately', async () => {
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = menuCtx(configPath, vault, registry, ['q']);
    expect(await runTopMenu(deps)).toBe(0);
    expect(logs.some((l) => l.includes('Done.'))).toBe(true);
  });

  it('reports an unknown selection and continues', async () => {
    const { configPath, vault, registry } = await setup({ preExisting: ANTHROPIC_ONE_KEY });
    const { deps, logs } = menuCtx(configPath, vault, registry, ['zzz', 'q']);
    expect(await runTopMenu(deps)).toBe(0);
    expect(logs.some((l) => l.includes('Unknown selection: "zzz"'))).toBe(true);
  });

  it('drills into a provider by number, then goes back and quits', async () => {
    const { configPath, vault, registry } = await setup({ preExisting: ANTHROPIC_ONE_KEY });
    const { deps, logs } = menuCtx(configPath, vault, registry, ['1', 'b', 'q']);
    expect(await runTopMenu(deps)).toBe(0);
    expect(logs.some((l) => l.includes('[anthropic]'))).toBe(true);
  });

  it('drills into a provider by id', async () => {
    const { configPath, vault, registry } = await setup({ preExisting: ANTHROPIC_ONE_KEY });
    const { deps, logs } = menuCtx(configPath, vault, registry, ['anthropic', 'q', 'q']);
    expect(await runTopMenu(deps)).toBe(0);
    expect(logs.some((l) => l.includes('Saved providers:'))).toBe(true);
  });

  it('adds a custom provider from the menu', async () => {
    const { configPath, vault, registry } = await setup();
    const { deps } = menuCtx(configPath, vault, registry, [
      'c', 'menu-custom', 'openai', '', '', '', 'default', 'sk-m-1234567890', 'q',
    ]);
    expect(await runTopMenu(deps)).toBe(0);
    const providers = await readProviders(configPath);
    expect(providers['menu-custom']).toMatchObject({ family: 'openai' });
  });

  it('adds a local server via the picker', async () => {
    const { configPath, vault, registry } = await setup();
    const { deps } = menuCtx(configPath, vault, registry, ['l', 'ollama', 'q']);
    expect(await runTopMenu(deps)).toBe(0);
    const providers = await readProviders(configPath);
    expect(providers['ollama']).toMatchObject({ family: 'openai-compatible' });
  });
});

// ── manageProvider (provider submenu) ─────────────────────────────────────
describe('manageProvider — provider submenu', () => {
  async function submenu(answers: string[], preExisting: object = ANTHROPIC_ONE_KEY) {
    const { configPath, vault, registry } = await setup({ preExisting });
    const { deps, logs } = menuCtx(configPath, vault, registry, answers);
    await manageProvider('anthropic', deps);
    return { configPath, logs };
  }

  it('adds another key', async () => {
    const { configPath } = await submenu(['a', 'work2', 'sk-y-1234567890', 'q']);
    const providers = await readProviders(configPath);
    const keys = (providers['anthropic'] as { apiKeys?: unknown[] }).apiKeys;
    expect(keys).toHaveLength(2);
  });

  it('rejects a duplicate key label', async () => {
    const { logs } = await submenu(['a', 'default', 'q']);
    expect(logs.some((l) => l.includes('Label "default" is already used'))).toBe(true);
  });

  it('updates a key by index and validates the index', async () => {
    const { logs: ok } = await submenu(['u 1', 'sk-z-1234567890', 'q']);
    expect(ok.some((l) => l.includes('Updated anthropic/default'))).toBe(true);

    const { logs: bad } = await submenu(['u 5', 'q']);
    expect(bad.some((l) => l.includes('Usage: u <1-1>'))).toBe(true);
  });

  it('deletes a key on confirm and keeps it on decline', async () => {
    const confirmed = await submenu(['d 1', 'y', 'q']);
    expect(
      ((await readProviders(confirmed.configPath))['anthropic'] as { apiKeys?: unknown[] }).apiKeys,
    ).toBeUndefined();

    const declined = await submenu(['d 1', 'n', 'q']);
    expect(
      ((await readProviders(declined.configPath))['anthropic'] as { apiKeys?: unknown[] }).apiKeys,
    ).toHaveLength(1);
  });

  it('sets the active key', async () => {
    const { configPath } = await submenu(['s 1', 'q']);
    expect((await readProviders(configPath))['anthropic']).toMatchObject({ activeKey: 'default' });
  });

  it('edits family (set, unset, invalid)', async () => {
    const set = await submenu(['f', 'google', 'q']);
    expect((await readProviders(set.configPath))['anthropic']).toMatchObject({ family: 'google' });

    const unset = await submenu(['f', '', 'q']);
    expect(
      ((await readProviders(unset.configPath))['anthropic'] as Record<string, unknown>).family,
    ).toBeUndefined();

    const bad = await submenu(['f', 'mystery', 'q']);
    expect(bad.logs.some((l) => l.includes('Invalid family: "mystery"'))).toBe(true);
  });

  it('edits baseUrl and models', async () => {
    const url = await submenu(['B', 'http://new.local/v1', 'q']);
    expect((await readProviders(url.configPath))['anthropic']).toMatchObject({
      baseUrl: 'http://new.local/v1',
    });

    const models = await submenu(['m', 'a, b', 'q']);
    expect((await readProviders(models.configPath))['anthropic']).toMatchObject({
      models: ['a', 'b'],
    });
  });

  it('removes the provider on confirm and keeps it on decline', async () => {
    const removed = await submenu(['x', 'y']);
    expect(await readProviders(removed.configPath)).toEqual({});

    const kept = await submenu(['x', 'n', 'q']);
    expect(Object.keys(await readProviders(kept.configPath))).toEqual(['anthropic']);
  });

  it('reports an unknown action', async () => {
    const { logs } = await submenu(['zzz', 'q']);
    expect(logs.some((l) => l.includes('Unknown action: "zzz"'))).toBe(true);
  });

  it('reports a provider that vanished', async () => {
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = menuCtx(configPath, vault, registry, []);
    await manageProvider('ghost', deps);
    expect(logs.some((l) => l.includes('Provider "ghost" no longer in config.'))).toBe(true);
  });
});

// ── add-provider.ts: addKeyForProvider template merge + adoption edges ──────
describe('add-provider.ts — addKeyForProvider merge + adoption edges', () => {
  it('fills missing family/baseUrl/envVars/activeKey from the template', async () => {
    const { configPath, vault, registry } = await setup({
      preExisting: {
        providers: { legacy: { type: 'legacy' } }, // no family/baseUrl/envVars/keys
      },
    });
    const { deps } = menuCtx(configPath, vault, registry, ['work', 'sk-x-1234567890']);
    const ok = await addKeyForProvider('legacy', deps, {
      type: 'legacy',
      family: 'openai',
      baseUrl: 'http://legacy.local/v1',
      envVars: ['LEGACY_KEY'],
    });
    expect(ok).toBe(true);
    const providers = await readProviders(configPath);
    expect(providers['legacy']).toMatchObject({
      type: 'legacy',
      family: 'openai',
      baseUrl: 'http://legacy.local/v1',
      envVars: ['LEGACY_KEY'],
      activeKey: 'work',
    });
  });

  it('backfills the type on a legacy entry that lacks it', async () => {
    const { configPath, vault, registry } = await setup({
      preExisting: { providers: { ghost: { family: 'openai' } } }, // no type
    });
    const { deps } = menuCtx(configPath, vault, registry, ['k1', 'sk-y-1234567890']);
    const ok = await addKeyForProvider('ghost', deps, { type: 'ghost' });
    expect(ok).toBe(true);
    const providers = await readProviders(configPath);
    expect(providers['ghost']).toMatchObject({ type: 'ghost', family: 'openai' });
  });

  it('skips adoption when a default provider/model is already set', async () => {
    const { host, configPath } = await setup({
      preExisting: {
        provider: 'openai',
        model: 'gpt-4o',
        providers: { openai: { type: 'openai', family: 'openai' } },
      },
    });
    const { io } = makeIo(['work', 'sk-z-1234567890']);
    expect((await host.addKey('openai', io)).ok).toBe(true);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw.provider).toBe('openai'); // untouched — a default already existed
    expect(raw.model).toBe('gpt-4o');
  });

  it('skips adoption when the catalog lookup fails', async () => {
    const { configPath, vault, registry } = await setup();
    // Registry whose getProvider rejects — resolveDefaultModelId catches it.
    const failing = {
      getProvider: vi.fn(async () => {
        throw new Error('registry down');
      }),
      listProviders: vi.fn(async () => []),
    } as never as ModelsRegistry;
    const { deps } = menuCtx(configPath, vault, failing, ['k1', 'sk-w-1234567890']);
    const ok = await addKeyForProvider('brand-new', deps, { type: 'brand-new' });
    expect(ok).toBe(true);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(raw.provider).toBeUndefined(); // no adoption, no default write
    expect(registry).toBeDefined();
  });
});
