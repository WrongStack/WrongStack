import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import {
  DefaultConfigLoader,
  repairConfigDefaults,
} from '../../src/storage/config-loader.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

// vi.mock is hoisted above imports — the factory uses vi.importActual to lazily
// get the real module, avoiding TDZ issues with importing at module scope.
// The returned plain object replaces 'node:fs/promises' before the second
// import runs.  Exposed via globalThis so tests can configure mock behavior.
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const mockFs = {
    // Fall through to the real module for anything not overridden (chmod,
    // open, fsync, …) so atomicWrite's durability path works on real files.
    ...real,
    readFile: vi.fn(real.readFile),
    writeFile: vi.fn(real.writeFile),
    rename: real.rename,
    access: real.access,
    unlink: real.unlink,
    mkdir: real.mkdir,
    readdir: real.readdir,
    rm: real.rm,
    mkdtemp: real.mkdtemp,
    copyFile: real.copyFile,
    stat: real.stat,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__mockFs = mockFs;
  return mockFs;
});

// After vi.mock replacement, this gets the spy-wrapped plain object.
import * as fs from 'node:fs/promises';

describe('DefaultConfigLoader', () => {
  let projectRoot: string;
  let userHome: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cfg-proj-'));
    userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cfg-home-'));
  });
  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(userHome, { recursive: true, force: true });
    delete process.env['WRONGSTACK_PROVIDER'];
    delete process.env['WRONGSTACK_MODEL'];
  });

  function loader(opts?: { events?: EventBus; traceId?: string }) {
    const paths = resolveWstackPaths({ projectRoot, userHome });
    const profileCfgPath = paths.profileConfig('default');
    return { loader: new DefaultConfigLoader({ paths, ...opts }), paths, profileCfgPath };
  }

  it('returns behavior defaults with no files (no hardcoded provider/model)', async () => {
    const { loader: l, paths, profileCfgPath } = loader();
    const cfg = await l.load();
    expect(cfg.provider).toBeUndefined();
    expect(cfg.model).toBeUndefined();
    expect(cfg.context.mode).toBe('balanced');
    expect(cfg.context.softThreshold).toBe(0.7);
    expect(cfg.tools.maxIterations).toBe(100);
    expect(cfg.features.mcp).toBe(true);
    expect(cfg.mcpServers).toEqual({});

    // Bootstrap config only stores version + activeProfile
    const bootstrap = JSON.parse(await fs.readFile(paths.globalConfig, 'utf8'));
    expect(bootstrap.version).toBe(1);
    expect(bootstrap.activeProfile).toBe('default');

    // Full behavior defaults are now persisted to the profile config
    const written = JSON.parse(await fs.readFile(profileCfgPath, 'utf8'));
    expect(written.provider).toBeUndefined();
    expect(written.model).toBeUndefined();
    expect(written.version).toBe(1);
    expect(written.configScope).toBe('global');
    expect(written.maxConcurrent).toBe(4);
    expect(written.context.mode).toBe('balanced');
    expect(written.context.strategy).toBe('hybrid');
    expect(written.autonomy.defaultMode).toBe('auto');
    expect(written.autonomy.autoProceedDelayMs).toBe(45_000);
    expect(written.autonomy.enhanceDelayMs).toBe(60_000);
    expect(written.autonomy.autoProceedMaxIterations).toBe(50);
    expect(written.modelRuntime.reasoning).toEqual({
      mode: 'auto',
    });
  });

  it('migrates the legacy `superMemory` key into `Sage` without losing user settings', async () => {
    const { loader: l, profileCfgPath } = loader();
    await fs.mkdir(path.dirname(profileCfgPath), { recursive: true });
    await fs.writeFile(
      profileCfgPath,
      JSON.stringify({
        version: 1,
        superMemory: {
          inject: { turnContext: true },
          storage: { directory: '.custom/memories' },
        },
      }),
    );
    const cfg = await l.load();
    const sage = (cfg as unknown as Record<string, unknown>)['Sage'] as {
      inject?: { turnContext?: boolean };
      storage?: { directory?: string };
    };
    expect(sage?.inject?.turnContext).toBe(true);
    expect(sage?.storage?.directory).toBe('.custom/memories');
    expect((cfg as unknown as Record<string, unknown>)['superMemory']).toBeUndefined();
  });

  it('prefers explicit `Sage` values over migrated legacy `superMemory` ones', async () => {
    const { loader: l, profileCfgPath } = loader();
    await fs.mkdir(path.dirname(profileCfgPath), { recursive: true });
    await fs.writeFile(
      profileCfgPath,
      JSON.stringify({
        version: 1,
        superMemory: { inject: { turnContext: true }, embeddings: { enabled: true } },
        Sage: { inject: { turnContext: false } },
      }),
    );
    const cfg = await l.load();
    const sage = (cfg as unknown as Record<string, unknown>)['Sage'] as {
      inject?: { turnContext?: boolean };
      embeddings?: { enabled?: boolean };
    };
    expect(sage?.inject?.turnContext).toBe(false); // explicit Sage wins
    expect(sage?.embeddings?.enabled).toBe(true); // legacy-only sub-key survives
  });

  it('fills missing global defaults without overwriting user settings', async () => {
    const { loader: l, paths, profileCfgPath } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        provider: 'anthropic',
        model: 'anthropic-test-model',
        maxConcurrent: 12,
        autonomy: { defaultMode: 'auto' },
        modelRuntime: { parameters: { user: 'kept' } },
        Sage: { storage: { directory: 'custom-memory', engine: 'jsonl' } },
      }),
    );

    const cfg = await l.load();
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('anthropic-test-model');
    expect(cfg.maxConcurrent).toBe(12);
    expect(cfg.autonomy?.defaultMode).toBe('auto');
    expect(cfg.autonomy?.autoProceedDelayMs).toBe(45_000);
    expect(cfg.modelRuntime?.parameters?.user).toBe('kept');
    expect(cfg.modelRuntime?.reasoning?.effort).toBeUndefined();
    expect(cfg.Sage?.storage?.directory).toBe('custom-memory');
    expect((cfg.Sage?.storage as Record<string, unknown> | undefined)?.['engine']).toBeUndefined();

    // User settings are migrated to the profile config
    const written = JSON.parse(await fs.readFile(profileCfgPath, 'utf8'));
    expect(written.provider).toBe('anthropic');
    expect(written.model).toBe('anthropic-test-model');
    expect(written.maxConcurrent).toBe(12);
    expect(written.autonomy.defaultMode).toBe('auto');
    expect(written.autonomy.autoProceedDelayMs).toBe(45_000);
    expect(written.modelRuntime.parameters.user).toBe('kept');
    expect(written.modelRuntime.reasoning.effort).toBeUndefined();
    expect(written.Sage.storage.directory).toBe('custom-memory');
    expect(written.Sage.storage.engine).toBeUndefined();
  });

  it('does not persist env or CLI identity overrides when seeding defaults', async () => {
    process.env['WRONGSTACK_PROVIDER'] = 'openai';
    process.env['WRONGSTACK_API_KEY'] = 'sk-env';
    try {
      const { loader: l, profileCfgPath } = loader();
      const cfg = await l.load({ cliFlags: { model: 'gpt-5' } });
      expect(cfg.provider).toBe('openai');
      expect(cfg.model).toBe('gpt-5');
      expect(cfg.apiKey).toBe('sk-env');

      // Env overrides must not be persisted to the profile config
      const written = JSON.parse(await fs.readFile(profileCfgPath, 'utf8'));
      expect(written.provider).toBeUndefined();
      expect(written.model).toBeUndefined();
      expect(written.apiKey).toBeUndefined();
      expect(written.autonomy.defaultMode).toBe('auto');
    } finally {
      delete process.env['WRONGSTACK_PROVIDER'];
      delete process.env['WRONGSTACK_API_KEY'];
    }
  });

  it('user config controls Playwright MCP when explicitly configured', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ mcpServers: { playwright: { enabled: true, transport: 'stdio', command: 'npx' } } }),
    );

    const cfg = await l.load();
    expect(cfg.features.mcp).toBe(true);
    expect(cfg.mcpServers?.playwright?.enabled).toBe(true);
    expect(cfg.mcpServers?.playwright?.command).toBe('npx');
  });

  it('user-global config sets provider/model', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ provider: 'anthropic', model: 'anthropic-test-model' }),
    );
    const cfg = await l.load();
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('anthropic-test-model');
  });

  it('normalizes inline provider model metadata into models and customModels', async () => {
    const { loader: l, profileCfgPath } = loader();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fs.mkdir(path.dirname(profileCfgPath), { recursive: true });
      await fs.writeFile(
        profileCfgPath,
        JSON.stringify({
          provider: 'acme',
          model: 'acme-large',
          providers: {
            acme: {
              type: 'acme',
              family: 'openai-compatible',
              models: [
                'legacy-model',
                {
                  id: 'acme-large',
                  name: 'Inline Acme Large',
                  limit: { context: 262_144, output: 32_768 },
                  tool_call: true,
                  reasoning: true,
                  modalities: { input: ['text', 'image'], output: ['text'] },
                  capabilities: { streaming: true },
                },
                'acme-large',
                null,
                { name: 'missing id' },
              ],
              customModels: {
                'acme-large': {
                  name: 'Explicit Acme Large',
                  maxOutput: 4_096,
                  capabilities: { maxContext: 131_072, tools: false, jsonMode: true },
                },
              },
            },
          },
        }),
      );

      const cfg = await l.load();
      const provider = cfg.providers?.['acme'];
      expect(provider?.models).toEqual(['legacy-model', 'acme-large']);
      const acmeLarge = provider?.customModels?.['acme-large'];
      // Legacy derived fields are unchanged.
      expect(acmeLarge?.name).toBe('Explicit Acme Large');
      expect(acmeLarge?.maxOutput).toBe(4_096);
      expect(acmeLarge?.capabilities).toEqual({
        maxContext: 131_072,
        tools: false,
        reasoning: true,
        vision: true,
        streaming: true,
        jsonMode: true,
      });
      // ME-2: full inline model object round-trips via modelsDev, merged
      // field-by-field (inline-derived + explicit customModels compose).
      expect(acmeLarge?.modelsDev).toMatchObject({
        name: 'Inline Acme Large',
        limit: { context: 262_144, output: 32_768 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      });
      const firstWarning = warn.mock.calls.at(0)?.[0];
      expect(firstWarning).toEqual(
        expect.stringContaining('"event":"config.invalid_inline_provider_model"'),
      );
      expect(firstWarning).toEqual(
        expect.stringContaining('"message":"Ignoring invalid inline provider model entry"'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  // ── ME-2: full models.dev schema round-trip ────────────────────────────

  it('ME-2: round-trips full models.dev inline model objects (cost, modalities.output, knowledge, dates)', async () => {
    const { loader: l, profileCfgPath } = loader();
    await fs.mkdir(path.dirname(profileCfgPath), { recursive: true });
    await fs.writeFile(
      profileCfgPath,
      JSON.stringify({
        providers: {
          acme: {
            type: 'acme',
            family: 'openai-compatible',
            models: [
              {
                id: 'acme-pro',
                name: 'Acme Pro',
                description: 'Full-featured model',
                family: 'acme-pro',
                attachment: true,
                reasoning: true,
                reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
                tool_call: true,
                structured_output: true,
                temperature: true,
                knowledge: '2025-06-01',
                release_date: '2026-01-15',
                last_updated: '2026-02-01',
                open_weights: false,
                modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
                cost: { input: 5, output: 20, cache_read: 0.5, cache_write: 6.25 },
                limit: { context: 500_000, output: 64_000 },
              },
            ],
          },
        },
      }),
    );
    const cfg = await l.load();
    const acmePro = cfg.providers?.['acme']?.customModels?.['acme-pro'];
    expect(acmePro?.modelsDev).toMatchObject({
      name: 'Acme Pro',
      description: 'Full-featured model',
      knowledge: '2025-06-01',
      release_date: '2026-01-15',
      cost: { input: 5, output: 20, cache_read: 0.5, cache_write: 6.25 },
      limit: { context: 500_000, output: 64_000 },
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
    });
    // Legacy derived fields still populated from the same object.
    expect(acmePro?.capabilities?.maxContext).toBe(500_000);
    expect(acmePro?.maxOutput).toBe(64_000);
    expect(acmePro?.capabilities?.tools).toBe(true);
    expect(acmePro?.capabilities?.reasoning).toBe(true);
    expect(acmePro?.capabilities?.vision).toBe(true);
  });

  it('ME-2: customModels.modelsDev merges field-by-field with inline modelsDev', async () => {
    const { loader: l, profileCfgPath } = loader();
    await fs.mkdir(path.dirname(profileCfgPath), { recursive: true });
    await fs.writeFile(
      profileCfgPath,
      JSON.stringify({
        providers: {
          acme: {
            type: 'acme',
            family: 'openai-compatible',
            models: [
              {
                id: 'acme-merge',
                name: 'Inline Name',
                limit: { context: 100_000 },
                cost: { input: 3 },
              },
            ],
            customModels: {
              'acme-merge': {
                modelsDev: {
                  name: 'Explicit Name',
                  limit: { output: 8_192 },
                  cost: { output: 12 },
                },
              },
            },
          },
        },
      }),
    );
    const cfg = await l.load();
    const merged = cfg.providers?.['acme']?.customModels?.['acme-merge']?.modelsDev;
    // Explicit customModels.modelsDev wins per-field over inline-derived;
    // untouched fields survive from the inline object.
    expect(merged?.name).toBe('Explicit Name');
    expect(merged?.limit).toEqual({ context: 100_000, output: 8_192 });
    expect(merged?.cost).toEqual({ input: 3, output: 12 });
  });

  it('ME-2: plain-string models[] configs load and re-serialize byte-identical (zero-migration)', async () => {
    const { loader: l, profileCfgPath } = loader();
    const rawConfig = {
      providers: {
        acme: {
          type: 'acme',
          family: 'openai-compatible',
          apiKey: 'sk-test',
          models: ['model-a', 'model-b', 'model-c'],
        },
      },
    };
    await fs.mkdir(path.dirname(profileCfgPath), { recursive: true });
    await fs.writeFile(profileCfgPath, JSON.stringify(rawConfig, null, 2));
    const cfg = await l.load();
    const provider = cfg.providers?.['acme'];
    // String allowlist preserved exactly, no customModels generated.
    expect(provider?.models).toEqual(['model-a', 'model-b', 'model-c']);
    expect(provider?.customModels).toBeUndefined();
  });

  it('never loads settings from the root bootstrap once a profile exists', async () => {
    const { loader: l, paths, profileCfgPath } = loader();
    await fs.mkdir(path.dirname(profileCfgPath), { recursive: true });
    await fs.writeFile(
      profileCfgPath,
      JSON.stringify({
        activeProfile: 'must-not-win',
        provider: 'profile-provider',
        model: 'profile-model',
        maxConcurrent: 7,
      }),
    );
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        version: 1,
        activeProfile: 'default',
        provider: 'stale-root-provider',
        model: 'stale-root-model',
        maxConcurrent: 99,
      }),
    );

    const cfg = await l.load();

    expect(cfg.provider).toBe('profile-provider');
    expect(cfg.model).toBe('profile-model');
    expect(cfg.maxConcurrent).toBe(7);
    expect(cfg.activeProfile).toBe('default');
    expect(JSON.parse(await fs.readFile(paths.globalConfig, 'utf8'))).toEqual({
      version: 1,
      activeProfile: 'default',
    });
  });

  it('does not migrate root settings into an existing empty profile', async () => {
    const { loader: l, paths, profileCfgPath } = loader();
    await fs.mkdir(path.dirname(profileCfgPath), { recursive: true });
    await fs.writeFile(profileCfgPath, '{}');
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        version: 1,
        activeProfile: 'default',
        provider: 'stale-root-provider',
        model: 'stale-root-model',
      }),
    );

    const cfg = await l.load();

    expect(cfg.provider).toBeUndefined();
    expect(cfg.model).toBeUndefined();
    expect(JSON.parse(await fs.readFile(paths.globalConfig, 'utf8'))).toEqual({
      version: 1,
      activeProfile: 'default',
    });
  });

  it('memoizes file reads across repeated load() calls until mtime changes', async () => {
    const { loader: l, profileCfgPath } = loader();
    // Write the initial config to the profile config (user settings)
    await fs.mkdir(path.dirname(profileCfgPath), { recursive: true });
    await fs.writeFile(profileCfgPath, JSON.stringify({ provider: 'anthropic', model: 'claude-opus-4-7' }));

    const readSpy = vi.spyOn(fs, 'readFile');
    const statSpy = vi.spyOn(fs, 'stat');

    const first = await l.load();
    const second = await l.load();
    expect(first.provider).toBe('anthropic');
    expect(second.provider).toBe('anthropic');

    const profileReads = readSpy.mock.calls.filter(([file]) => String(file) === profileCfgPath);
    // 3 structural reads (ensureProfileConfig + backup + readJson on first load)
    // + 1 for ensureProfileConfig on second load = 4
    expect(profileReads.length).toBe(4);

    await new Promise((resolve) => setTimeout(resolve, 5));
    // Update the profile config to simulate a config change
    await fs.writeFile(profileCfgPath, JSON.stringify({ provider: 'openai', model: 'gpt-5' }));
    const third = await l.load();
    expect(third.provider).toBe('openai');

    expect(statSpy.mock.calls.some(([file]) => String(file) === profileCfgPath)).toBe(true);
  });

  it('project-local config overrides user-global', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
    );
    await fs.mkdir(path.dirname(paths.projectLocalConfig), { recursive: true });
    await fs.writeFile(paths.projectLocalConfig, JSON.stringify({ model: 'claude-opus-4-7' }));
    const cfg = await l.load();
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-opus-4-7');
  });

  it('env overrides files', async () => {
    process.env['WRONGSTACK_PROVIDER'] = 'openai';
    const { loader: l } = loader();
    const cfg = await l.load();
    expect(cfg.provider).toBe('openai');
  });

  it('cli flags override env', async () => {
    process.env['WRONGSTACK_PROVIDER'] = 'openai';
    const { loader: l } = loader();
    const cfg = await l.load({ cliFlags: { provider: 'groq' } });
    expect(cfg.provider).toBe('groq');
  });

  it('invalid version throws', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ version: 99 }));
    await expect(l.load()).rejects.toThrow(/version/);
  });

  it('strict mode requires provider+model', async () => {
    const paths = resolveWstackPaths({ projectRoot, userHome });
    const l = new DefaultConfigLoader({ paths, strict: true });
    await expect(l.load()).rejects.toThrow(/provider/);
  });

  it('strict mode passes when provider+model both present', async () => {
    const paths = resolveWstackPaths({ projectRoot, userHome });
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ provider: 'openai', model: 'gpt-4o' }));
    const l = new DefaultConfigLoader({ paths, strict: true });
    const cfg = await l.load();
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-4o');
  });

  it('strict mode demands model when provider alone is set', async () => {
    const paths = resolveWstackPaths({ projectRoot, userHome });
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ provider: 'openai' }));
    const l = new DefaultConfigLoader({ paths, strict: true });
    await expect(l.load()).rejects.toThrow(/model/);
  });

  it('reads WRONGSTACK_MODEL / API_KEY / BASE_URL / LOG_LEVEL env vars', async () => {
    process.env['WRONGSTACK_MODEL'] = 'gpt-4o';
    process.env['WRONGSTACK_API_KEY'] = 'sk-x';
    process.env['WRONGSTACK_BASE_URL'] = 'https://x';
    process.env['WRONGSTACK_LOG_LEVEL'] = 'debug';
    try {
      const { loader: l } = loader();
      const cfg = await l.load();
      expect(cfg.model).toBe('gpt-4o');
      expect(cfg.apiKey).toBe('sk-x');
      expect(cfg.baseUrl).toBe('https://x');
      expect(cfg.log.level).toBe('debug');
    } finally {
      delete process.env['WRONGSTACK_MODEL'];
      delete process.env['WRONGSTACK_API_KEY'];
      delete process.env['WRONGSTACK_BASE_URL'];
      delete process.env['WRONGSTACK_LOG_LEVEL'];
    }
  });

  it('rejects invalid context thresholds', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        context: { warnThreshold: 0.9, softThreshold: 0.5, hardThreshold: 0.95 },
      }),
    );
    await expect(l.load()).rejects.toThrow(/thresholds/);
  });

  it('ignores unknown context-window modes and uses the default', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ context: { mode: 'tiny' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = await l.load();
      expect(cfg.context.mode).toBe('balanced');
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores malformed JSON gracefully', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, '{not json');
    // should not throw — just use defaults
    const cfg = await l.load();
    expect(cfg.context.softThreshold).toBe(0.7);
  });

  it('merges primitive arrays by concatenation with deduplication', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ features: { plugins: ['a', 'b'] } }));
    await fs.mkdir(path.dirname(paths.projectLocalConfig), { recursive: true });
    await fs.writeFile(
      paths.projectLocalConfig,
      JSON.stringify({ features: { plugins: ['b', 'c'] } }),
    );
    const cfg = await l.load();
    expect(cfg.features.plugins).toEqual(['a', 'b', 'c']);
  });

  it('replaces object arrays wholesale', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ mcpServers: [{ name: 'a', url: 'http://a' }] }),
    );
    await fs.mkdir(path.dirname(paths.projectLocalConfig), { recursive: true });
    await fs.writeFile(
      paths.projectLocalConfig,
      JSON.stringify({ mcpServers: [{ name: 'b', url: 'http://b' }] }),
    );
    const cfg = await l.load();
    expect(cfg.mcpServers).toEqual([{ name: 'b', url: 'http://b' }]);
  });

  it('returned config is frozen', async () => {
    const { loader: l } = loader();
    const cfg = await l.load();
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  // ── multi-key apiKeys[] resolution ─────────────────────────────────────────

  it('mirrors the first apiKeys[] entry into apiKey when none is set', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            apiKeys: [
              { label: 'prod', apiKey: 'sk-prod' },
              { label: 'dev', apiKey: 'sk-dev' },
            ],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-prod');
  });

  it('honors activeKey label when resolving apiKeys[]', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            activeKey: 'dev',
            apiKeys: [
              { label: 'prod', apiKey: 'sk-prod' },
              { label: 'dev', apiKey: 'sk-dev' },
            ],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-dev');
  });

  it('falls back to first entry when activeKey label does not match', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            activeKey: 'missing',
            apiKeys: [
              { label: 'prod', apiKey: 'sk-prod' },
              { label: 'dev', apiKey: 'sk-dev' },
            ],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-prod');
  });

  it('preserves an explicit apiKey instead of mirroring from apiKeys[]', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'sk-explicit',
            apiKeys: [{ label: 'prod', apiKey: 'sk-prod' }],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-explicit');
  });

  it('ignores malformed apiKeys[] entries (missing label or apiKey)', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            apiKeys: [
              null,
              { label: 'no-key' },
              { apiKey: 'no-label' },
              { label: 'good', apiKey: 'sk-good' },
            ],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-good');
  });

  it('leaves apiKey undefined when apiKeys[] is empty or all malformed', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: { type: 'openai', apiKeys: [null, { label: 1 }] },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBeUndefined();
  });

  // ── validation errors ────────────────────────────────────────────────────

  it('throws when context thresholds are non-numeric', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ context: { warnThreshold: 'oops', softThreshold: 0.7, hardThreshold: 0.9 } }),
    );
    await expect(l.load()).rejects.toThrow(/context\.warnThreshold/);
  });

  it('throws when context thresholds are out of order', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ context: { warnThreshold: 0.9, softThreshold: 0.7, hardThreshold: 0.8 } }),
    );
    await expect(l.load()).rejects.toThrow(/warn < soft < hard/);
  });

  it('falls back to the default when context.mode is an unknown id', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ context: { mode: 'lightning-fast' } }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = await l.load();
      // Unknown mode must not brick the CLI — it is replaced by the default.
      expect(cfg.context.mode).toBe('balanced');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lightning-fast'));
    } finally {
      warn.mockRestore();
    }
  });

  // ── storage.* event emissions ─────────────────────────────────────────────

  it('emits storage.write with outcome success on persistSyncConfig()', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l } = loader({ events });
    await l.persistSyncConfig({});
    expect(emitSpy).toHaveBeenCalledWith('storage.write', expect.objectContaining({
      store: 'config',
      operation: 'persist_sync',
      outcome: 'success',
    }));
  });

  it('emits storage.error when persistSyncConfig() encounters a write failure', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l, paths } = loader({ events });
    await fs.mkdir(path.dirname(paths.syncConfig), { recursive: true });
    // Make atomicWrite's underlying writeFile call fail with EACCES
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockFs = (globalThis as any).__mockFs as typeof fs;
    mockFs.writeFile.mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
    try {
      await expect(l.persistSyncConfig({})).rejects.toThrow('Permission denied');
      expect(emitSpy).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        store: 'config',
        operation: 'persist_sync',
        outcome: 'failure',
        error: expect.stringContaining('EACCES'),
      }));
    } finally {
      mockFs.writeFile.mockReset();
    }
  });

  it('emits storage.read with outcome success when loadSyncConfig() finds sync.json', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l, paths } = loader({ events });
    await fs.mkdir(path.dirname(paths.syncConfig), { recursive: true });
    await fs.writeFile(paths.syncConfig, JSON.stringify({ githubToken: 'ghp_abc123' }));
    const result = await l.loadSyncConfig();
    expect(result).not.toBeNull();
    expect(result!.githubToken).toBe('ghp_abc123');
    expect(emitSpy).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'config',
      operation: 'load_sync',
      outcome: 'success',
    }));
  });

  it('emits storage.read with outcome failure when loadSyncConfig() encounters EACCES', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l, paths } = loader({ events });
    await fs.mkdir(path.dirname(paths.syncConfig), { recursive: true });
    // Write a valid file so the path resolves, then make readFile fail with EACCES
    await fs.writeFile(paths.syncConfig, JSON.stringify({ githubToken: 'ghp_abc' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockFs = (globalThis as any).__mockFs as typeof fs;
    mockFs.readFile.mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
    try {
      const result = await l.loadSyncConfig();
      // EACCES → returns null, not a thrown error
      expect(result).toBeNull();
      expect(emitSpy).toHaveBeenCalledWith('storage.read', expect.objectContaining({
        store: 'config',
        operation: 'load_sync',
        outcome: 'failure',
        error: expect.stringContaining('EACCES'),
      }));
    } finally {
      mockFs.readFile.mockReset();
    }
  });

  it('emits storage.read with outcome failure when loadSyncConfig() finds corrupt JSON', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l, paths } = loader({ events });
    await fs.mkdir(path.dirname(paths.syncConfig), { recursive: true });
    await fs.writeFile(paths.syncConfig, 'not-json{');
    const result = await l.loadSyncConfig();
    expect(result).toBeNull();
    expect(emitSpy).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'config',
      operation: 'load_sync',
      outcome: 'failure',
      error: 'parse error or empty file',
    }));
  });
});

describe('repairConfigDefaults', () => {
  it('adds missing defaults, repairs incompatible shapes, and preserves identity settings', () => {
    const report = repairConfigDefaults({
      provider: 'custom-provider',
      model: 'custom-model',
      maxConcurrent: 'invalid',
      context: { mode: 'balanced' },
      extensions: { custom: { enabled: true } },
    });

    expect(report.changed).toBe(true);
    expect(report.fixed['provider']).toBe('custom-provider');
    expect(report.fixed['model']).toBe('custom-model');
    expect(report.fixed['maxConcurrent']).toBe(4);
    expect(report.fixed['context']).toMatchObject({
      mode: 'balanced',
      autoCompact: true,
      strategy: 'hybrid',
    });
    expect(report.fixed['extensions']).toEqual({ custom: { enabled: true } });
    expect(report.changes).toEqual(
      expect.arrayContaining([
        { path: 'maxConcurrent', action: 'replaced' },
        { path: 'context.autoCompact', action: 'added' },
      ]),
    );
  });

  it('is idempotent after defaults are materialized', () => {
    const first = repairConfigDefaults({ provider: 'p', model: 'm' });
    const second = repairConfigDefaults(first.fixed);

    expect(second.changed).toBe(false);
    expect(second.changes).toEqual([]);
  });

  it('replaces NaN and Infinity with default numeric values', () => {
    const report = repairConfigDefaults({
      maxConcurrent: NaN,
      context: { warnThreshold: Infinity },
    });
    expect(report.fixed['maxConcurrent']).toBe(4);
    expect((report.fixed['context'] as Record<string, unknown>)['warnThreshold']).toBe(0.55);
  });
});
