import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { noOpVault } from '@wrongstack/core/security';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConfigWriteLockHolder,
  type PrefHelperDeps,
  persistPrefsToConfig,
  prefSnapshot,
  updateGlobalConfig,
} from '../src/server/pref-helpers.js';

describe('WebUI preference persistence helpers', () => {
  let dir: string;
  let rootConfigPath: string;
  let configPath: string;
  let warn: ReturnType<typeof vi.fn>;
  let deps: PrefHelperDeps;
  let holder: ConfigWriteLockHolder;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-pref-helpers-'));
    rootConfigPath = path.join(dir, 'config.json');
    configPath = path.join(dir, 'profiles', 'default', 'config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      rootConfigPath,
      JSON.stringify({ version: 1, activeProfile: 'default' }),
      'utf8',
    );
    warn = vi.fn();
    deps = {
      profileConfigPath: configPath,
      vault: noOpVault,
      logger: { warn },
    };
    holder = { lock: Promise.resolve() };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function readConfig(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
  }

  it('snapshots only preference keys that are present', () => {
    expect(
      prefSnapshot({ yolo: false, uiLocale: 'tr', hqToken: 'secret', unrelated: true }),
    ).toEqual({
      yolo: false,
      uiLocale: 'tr',
    });
    expect(prefSnapshot({})).toEqual({});
  });

  it('creates a missing config and serializes updates through the lock holder', async () => {
    const order: string[] = [];
    await Promise.all([
      updateGlobalConfig(
        deps,
        holder,
        (config) => {
          order.push('first');
          config.first = true;
        },
        'first write',
      ),
      updateGlobalConfig(
        deps,
        holder,
        (config) => {
          order.push('second');
          config.second = true;
        },
        'second write',
      ),
    ]);

    expect(order).toEqual(['first', 'second']);
    expect(await readConfig()).toEqual({ first: true, second: true });
    expect(JSON.parse(await fs.readFile(rootConfigPath, 'utf8'))).toEqual({
      version: 1,
      activeProfile: 'default',
    });
    await expect(holder.lock).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses to overwrite corrupt config JSON', async () => {
    await fs.writeFile(configPath, '{broken', 'utf8');

    await updateGlobalConfig(
      deps,
      holder,
      () => {
        throw new Error('must not be reached');
      },
      'settings',
    );

    expect(await fs.readFile(configPath, 'utf8')).toBe('{broken');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('refusing to overwrite corrupt config'),
    );
  });

  it('never persists the WebUI "auto" effort sentinel as a concrete level', async () => {
    await persistPrefsToConfig(deps, holder, {
      reasoningMode: 'on',
      reasoningEffort: 'auto',
      reasoningPreserve: true,
    });

    // 'auto' means "this tab follows the general setting": the session-scoped
    // pref lands on the tab meta, but the global config keeps whatever
    // concrete effort it already had (here: none at all).
    const config = await readConfig();
    expect(config.modelRuntime).toEqual({ reasoning: { mode: 'on', preserve: true } });
  });

  it('logs mutation/write failures without poisoning later writes', async () => {
    await fs.writeFile(configPath, '{}', 'utf8');

    await updateGlobalConfig(
      deps,
      holder,
      () => {
        throw new Error('mutation failed');
      },
      'settings',
    );
    await updateGlobalConfig(
      deps,
      holder,
      (config) => {
        config.recovered = true;
      },
      'settings',
    );

    expect(warn).toHaveBeenCalledWith('settings: failed to persist to config: mutation failed');
    expect(await readConfig()).toEqual({ recovered: true });
  });

  it('projects every supported preference family into global config', async () => {
    await persistPrefsToConfig(deps, holder, {
      autonomy: 'auto',
      autonomyDelayMs: 250,
      autoProceedMaxIterations: 9,
      yolo: true,
      chime: true,
      confirmExit: false,
      fleetChatVerbosity: 'full',
      enhanceEnabled: false,
      enhanceDelayMs: 1_000,
      enhanceLanguage: 'english',
      nextPrediction: true,
      uiLocale: 'tr',
      fallbackModels: ['fast', 'safe'],
      fallbackProfiles: { reliable: ['safe'] },
      favoriteModels: ['fast'],
      favoriteModelsOnly: true,
      modelMatrix: { coder: { provider: 'openai', model: 'fast' } },
      fallbackAuto: false,
      featureMcp: true,
      featurePlugins: false,
      featureMemory: true,
      featureSkills: false,
      featureModelsRegistry: true,
      contextAutoCompact: true,
      contextStrategy: 'selective',
      contextMode: 'deep',
      tokenSavingTier: 'aggressive',
      maxConcurrent: 7,
      titleAnimation: false,
      logLevel: 'debug',
      auditLevel: 'full',
      indexOnStart: true,
      maxIterations: 80,
      hqEnabled: true,
      hqUrl: 'ws://127.0.0.1:3499',
      hqToken: 'secret',
      hqRawContent: false,
      tgSessionEnd: true,
      tgDelegate: false,
      tgLongToolMs: 5_000,
      reasoningMode: 'on',
      reasoningEffort: 'high',
      reasoningPreserve: true,
      cacheTtl: '1h',
    });

    expect(await readConfig()).toEqual({
      autonomy: {
        defaultMode: 'auto',
        autoProceedDelayMs: 250,
        autoProceedMaxIterations: 9,
        yolo: true,
        chime: true,
        confirmExit: false,
        fleetChatVerbosity: 'full',
        enhance: false,
        enhanceDelayMs: 1_000,
        enhanceLanguage: 'english',
        terminalTitleAnimation: false,
      },
      yolo: true,
      nextPrediction: true,
      uiLocale: 'tr',
      fallbackModels: ['fast', 'safe'],
      fallbackProfiles: { reliable: ['safe'] },
      favoriteModels: ['fast'],
      favoriteModelsOnly: true,
      modelMatrix: { coder: { provider: 'openai', model: 'fast' } },
      fallbackAuto: false,
      features: {
        mcp: true,
        plugins: false,
        memory: true,
        skills: false,
        modelsRegistry: true,
        tokenSavingMode: 'aggressive',
      },
      context: { autoCompact: true, strategy: 'selective', mode: 'deep' },
      maxConcurrent: 7,
      log: { level: 'debug' },
      session: { auditLevel: 'full' },
      indexing: { onSessionStart: true },
      tools: { maxIterations: 80 },
      hq: {
        enabled: true,
        url: 'ws://127.0.0.1:3499',
        token: 'secret',
        rawContent: false,
      },
      extensions: {
        telegram: {
          notifyOnSessionEnd: true,
          notifyOnDelegate: false,
          longToolThresholdMs: 5_000,
        },
      },
      modelRuntime: {
        reasoning: { mode: 'on', effort: 'high', preserve: true },
        cache: { ttl: '1h' },
      },
    });
  });

  it('merges existing nested config and handles default cache plus ignored value types', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        autonomy: { existing: true },
        features: { existing: true },
        context: { existing: true },
        log: { format: 'json' },
        session: { name: 'saved' },
        indexing: { roots: ['src'] },
        tools: { timeoutMs: 10 },
        hq: { bind: '127.0.0.1' },
        extensions: { telegram: { existing: true } },
        modelRuntime: {
          reasoning: { preserve: false },
          cache: { ttl: '5m' },
        },
      }),
      'utf8',
    );

    await persistPrefsToConfig(deps, holder, {
      autonomy: 'eternal',
      chime: false,
      featureMcp: false,
      contextMode: 'frugal',
      logLevel: 'warn',
      auditLevel: 'minimal',
      indexOnStart: false,
      maxIterations: 0,
      hqEnabled: false,
      tgDelegate: true,
      reasoningEffort: 'low',
      cacheTtl: 'default',
      fallbackProfiles: [],
      modelMatrix: [],
    });

    const config = await readConfig();
    // 'eternal' round-trips through `defaultMode` now (was silently dropped
    // before the autonomy-mode persist-layer fix); see
    // `pref-helpers.ts` AUTONOMY_VALUES + persist filter.
    expect(config.autonomy).toEqual({ existing: true, chime: false, defaultMode: 'eternal' });
    expect(config.features).toEqual({ existing: true, mcp: false });
    expect(config.context).toEqual({ existing: true, mode: 'frugal' });
    expect(config.log).toEqual({ format: 'json', level: 'warn' });
    expect(config.session).toEqual({ name: 'saved', auditLevel: 'minimal' });
    expect(config.indexing).toEqual({ roots: ['src'], onSessionStart: false });
    expect(config.tools).toEqual({ timeoutMs: 10, maxIterations: 0 });
    expect(config.hq).toEqual({ bind: '127.0.0.1', enabled: false });
    expect(config.extensions).toEqual({ telegram: { existing: true, notifyOnDelegate: true } });
    expect(config.modelRuntime).toEqual({
      reasoning: { preserve: false, effort: 'low' },
    });
    expect(config).not.toHaveProperty('fallbackProfiles');
    expect(config).not.toHaveProperty('modelMatrix');
  });

  it('does not touch config sections for an empty preference update', async () => {
    await fs.writeFile(configPath, JSON.stringify({ keep: true }), 'utf8');
    await persistPrefsToConfig(deps, holder, {});
    expect(await readConfig()).toEqual({ keep: true });
  });

  // WrongProxy / WrongTrace: the WebUI toggle + URL flow through the
  // prefs.update pipeline (validator → ctx.meta → persist → live runtime),
  // but `persistPrefsToConfig` previously had no branch that mutated the
  // decrypted config for these keys. The validator accepted them, the
  // hot-reload wiring fired, the config file was rewritten with zero
  // changes — and the next boot saw an empty profile. These tests pin the
  // canonical nested shape (`tools.wrongProxy.{enabled,url}`) so the
  // regression can't return unnoticed AND so a future writer doesn't
  // accidentally land the values at the top level (where the runtime
  // probe + TUI picker never read them).
  it('persists wrongProxyEnabled + wrongProxyUrl to nested tools.wrongProxy', async () => {
    await fs.writeFile(configPath, '{}', 'utf8');
    await persistPrefsToConfig(deps, holder, {
      wrongProxyEnabled: true,
      wrongProxyUrl: 'http://proxy.local:9000/proxy',
    });
    expect(await readConfig()).toEqual({
      tools: {
        wrongProxy: {
          enabled: true,
          url: 'http://proxy.local:9000/proxy',
        },
      },
    });
  });

  it('updates wrongProxyEnabled without dropping wrongProxyUrl from existing nested config', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        tools: { wrongProxy: { enabled: true, url: 'http://old:8000' } },
      }),
      'utf8',
    );
    await persistPrefsToConfig(deps, holder, { wrongProxyEnabled: false });
    const config = await readConfig();
    expect((config.tools as Record<string, unknown>).wrongProxy).toEqual({
      enabled: false,
      url: 'http://old:8000',
    });
  });

  it('does not overwrite other tools-section keys when writing wrongProxy', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ tools: { maxIterations: 80, wrongProxy: { enabled: true } } }),
      'utf8',
    );
    await persistPrefsToConfig(deps, holder, { wrongProxyUrl: 'http://new:8000' });
    expect(await readConfig()).toEqual({
      tools: {
        maxIterations: 80,
        wrongProxy: { enabled: true, url: 'http://new:8000' },
      },
    });
  });

  it('rejects non-boolean / non-string wrongProxy values silently (typeof guard)', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        tools: { wrongProxy: { enabled: true, url: 'http://keep:8000' } },
      }),
      'utf8',
    );
    await persistPrefsToConfig(deps, holder, {
      wrongProxyEnabled: 'yes',
      wrongProxyUrl: 12345,
    });
    // Validator rejects the payload upstream, but if a non-member value
    // ever reaches `persistPrefsToConfig` directly, the typeof guards
    // must leave the existing fields untouched rather than overwrite
    // them with garbage.
    const config = await readConfig();
    expect((config.tools as Record<string, unknown>).wrongProxy).toEqual({
      enabled: true,
      url: 'http://keep:8000',
    });
  });

  // `config.plugins` outranks `extensions.<name>.enabled` (resolvePluginEnablement),
  // so writing only the extension left the panel's switch decorative for every
  // plugin that also had a plugins[] entry.
  describe('pluginsEnabled lands on the winning config layer', () => {
    it('flips a matching plugins[] entry alongside the extension', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({ plugins: ['type-gate', 'unrelated'] }),
        'utf8',
      );
      await persistPrefsToConfig(deps, holder, { pluginsEnabled: { 'type-gate': false } });
      const config = await readConfig();
      expect(config.plugins).toEqual([{ name: 'type-gate', enabled: false }, 'unrelated']);
      expect(config.extensions).toEqual({ 'type-gate': { enabled: false } });
    });

    it('re-enables an object-form entry and keeps its other options', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          plugins: [{ name: 'type-gate', enabled: false, options: { strict: 1 } }],
        }),
        'utf8',
      );
      await persistPrefsToConfig(deps, holder, { pluginsEnabled: { 'type-gate': true } });
      const config = await readConfig();
      expect(config.plugins).toEqual([
        { name: 'type-gate', enabled: true, options: { strict: 1 } },
      ]);
    });

    it('matches the @wrongstack/plugins/<name> spelling of an entry', async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({ plugins: ['@wrongstack/plugins/type-gate'] }),
        'utf8',
      );
      await persistPrefsToConfig(deps, holder, { pluginsEnabled: { 'type-gate': false } });
      expect((await readConfig()).plugins).toEqual([
        { name: '@wrongstack/plugins/type-gate', enabled: false },
      ]);
    });

    it('leaves plugins[] alone when nothing matches — the extension decides', async () => {
      await fs.writeFile(configPath, JSON.stringify({ plugins: ['other'] }), 'utf8');
      await persistPrefsToConfig(deps, holder, {
        pluginsEnabled: { 'duplicate-code-detector': true },
      });
      const config = await readConfig();
      expect(config.plugins).toEqual(['other']);
      expect(config.extensions).toEqual({ 'duplicate-code-detector': { enabled: true } });
    });
  });
});

// B-07: migrated from packages/webui/tests/server/pref-helpers.test.ts — pins
// the NESTED modelRuntime shape (reasoning + cache + parameters all the way
// through persistPrefsToConfig → read-back). The server suite covers the
// reasoning sub-shape in isolation (`never persists the WebUI "auto" effort
// sentinel as a concrete level`) and the cache.ttl scalar (`merges existing
// nested config`) but never the three-sub-object round-trip on a single
// matrix entry. A future refactor that strips one of the sub-objects (e.g.
// drops `cache` while persisting `reasoning`) would pass every server test
// and only fail this one.
describe('WebUI preference persistence — nested modelRuntime round-trip', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-pref-helpers-rt-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('persists model matrix entries with route-specific runtime overrides', async () => {
    const profileConfigPath = path.join(dir, 'config.json');
    await fs.writeFile(profileConfigPath, JSON.stringify({ version: 1 }), 'utf8');

    await persistPrefsToConfig(
      {
        globalConfigPath: path.join(dir, 'root.json'),
        profileConfigPath,
        vault: noOpVault,
        logger: { warn: () => undefined },
      } as PrefHelperDeps,
      { lock: Promise.resolve() },
      {
        modelMatrix: {
          planner: {
            fallbackProfile: 'cheap',
            modelRuntime: {
              reasoning: { mode: 'on', effort: 'low', preserve: false },
              cache: { ttl: '5m' },
              parameters: { user: 'planner' },
            },
          },
        },
      },
    );

    const written = JSON.parse(await fs.readFile(profileConfigPath, 'utf8')) as {
      modelMatrix?: Record<string, unknown>;
    };
    expect(written.modelMatrix).toEqual({
      planner: {
        fallbackProfile: 'cheap',
        modelRuntime: {
          reasoning: { mode: 'on', effort: 'low', preserve: false },
          cache: { ttl: '5m' },
          parameters: { user: 'planner' },
        },
      },
    });
  });
});
