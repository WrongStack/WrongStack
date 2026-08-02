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
    expect(prefSnapshot({ yolo: false, uiLocale: 'tr', unrelated: true })).toEqual({
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
});
