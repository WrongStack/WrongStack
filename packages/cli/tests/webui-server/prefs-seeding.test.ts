import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPrefsSeeding, seedConfigToMeta } from '../../src/webui-server/prefs-seeding.js';

describe('createPrefsSeeding', () => {
  it('updates live app config prefs without mutating a frozen config object', async () => {
    const frozenConfig = Object.freeze({});
    const opts = {
      agent: { ctx: { meta: {} } },
      appConfig: frozenConfig,
    } as never;

    const { persistPrefs } = createPrefsSeeding(opts);

    await expect(
      persistPrefs({
        fallbackProfiles: { default: ['anthropic/anthropic-test-model'] },
      }),
    ).resolves.toBeUndefined();
    expect((opts as { appConfig: unknown }).appConfig).not.toBe(frozenConfig);
    expect((opts as { appConfig: { fallbackProfiles?: unknown } }).appConfig.fallbackProfiles).toEqual({
      default: ['anthropic/anthropic-test-model'],
    });
    expect(Object.isExtensible(frozenConfig)).toBe(false);
  });

  it('persists reasoning/cache + contextMode/tokenSavingTier/maxConcurrent/titleAnimation to config.json (parity with the standalone server)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-seed-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(globalConfigPath, JSON.stringify({ version: 1 }), 'utf8');

    const opts = {
      agent: { ctx: { meta: {} } },
      globalConfigPath,
      appConfig: {},
    } as never;

    const { persistPrefs } = createPrefsSeeding(opts);
    await persistPrefs({
      reasoningMode: 'on',
      reasoningEffort: 'low',
      reasoningPreserve: true,
      cacheTtl: '1h',
      contextMode: 'frugal',
      tokenSavingTier: 'light',
      maxConcurrent: 7,
      titleAnimation: false,
    });

    const written = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
    expect(written.modelRuntime.reasoning).toEqual({ mode: 'on', effort: 'low', preserve: true });
    expect(written.modelRuntime.cache).toEqual({ ttl: '1h' });
    expect(written.context.mode).toBe('frugal');
    expect(written.features.tokenSavingMode).toBe('light');
    expect(written.maxConcurrent).toBe(7);
    expect(written.autonomy.terminalTitleAnimation).toBe(false);
  });

  it('persists model matrix entries with route-specific runtime overrides', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-matrix-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(globalConfigPath, JSON.stringify({ version: 1 }), 'utf8');

    const opts = {
      agent: { ctx: { meta: {} } },
      globalConfigPath,
      appConfig: {},
    } as never;

    const { persistPrefs } = createPrefsSeeding(opts);
    const modelMatrix = {
      planner: {
        fallbackProfile: 'cheap',
        modelRuntime: {
          reasoning: { mode: 'on', effort: 'low', preserve: false },
          cache: { ttl: '5m' },
          parameters: { user: 'planner' },
        },
      },
    };

    await persistPrefs({ modelMatrix });

    expect((opts as { appConfig: { modelMatrix?: unknown } }).appConfig.modelMatrix).toEqual(modelMatrix);
    const written = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
    expect(written.modelMatrix).toEqual(modelMatrix);
  });

  it('persists provider+model to config.json (model.switch path)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-model-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(
      globalConfigPath,
      JSON.stringify({ version: 1, provider: 'anthropic', model: 'old-model' }),
      'utf8',
    );
    const opts = { agent: { ctx: { meta: {} } }, globalConfigPath, appConfig: {} } as never;
    const { persistPrefs } = createPrefsSeeding(opts);
    await persistPrefs({ provider: 'openai', model: 'gpt-5-codex' });
    const written = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
    expect(written.provider).toBe('openai');
    expect(written.model).toBe('gpt-5-codex');
  });

  it('persists uiLocale to config.json and includes it in pref snapshots', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-locale-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(globalConfigPath, JSON.stringify({ version: 1, uiLocale: 'en' }), 'utf8');
    const opts = {
      agent: { ctx: { meta: { uiLocale: 'tr' } } },
      globalConfigPath,
      appConfig: {},
    } as never;

    const { prefSnapshot, persistPrefs } = createPrefsSeeding(opts);

    expect(prefSnapshot()).toMatchObject({ uiLocale: 'tr' });
    await persistPrefs({ uiLocale: 'de' });

    expect((opts as { appConfig: { uiLocale?: string } }).appConfig.uiLocale).toBe('de');
    const written = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
    expect(written.uiLocale).toBe('de');
  });

  it('cacheTtl "default" removes the cache override', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-cache-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(
      globalConfigPath,
      JSON.stringify({ version: 1, modelRuntime: { cache: { ttl: '1h' } } }),
      'utf8',
    );
    const opts = { agent: { ctx: { meta: {} } }, globalConfigPath, appConfig: {} } as never;
    const { persistPrefs } = createPrefsSeeding(opts);
    await persistPrefs({ cacheTtl: 'default' });
    const written = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
    expect(written.modelRuntime.cache).toBeUndefined();
  });
});

describe('seedConfigToMeta', () => {
  it('seeds reasoning/cache + contextMode/tokenSavingTier/maxConcurrent/titleAnimation from config.json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-meta-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        version: 1,
        maxConcurrent: 3,
        context: { mode: 'deep' },
        features: { tokenSavingMode: 'medium' },
        autonomy: { terminalTitleAnimation: false },
        modelMatrix: {
          planner: {
            modelRuntime: {
              reasoning: { mode: 'on', effort: 'low', preserve: false },
            },
          },
        },
        modelRuntime: { reasoning: { mode: 'off', effort: 'max', preserve: true }, cache: { ttl: '5m' } },
      }),
      'utf8',
    );
    const meta: Record<string, unknown> = {};
    await seedConfigToMeta({ agent: { ctx: { meta } }, globalConfigPath } as never);

    expect(meta['maxConcurrent']).toBe(3);
    expect(meta['contextMode']).toBe('deep');
    expect(meta['tokenSavingTier']).toBe('medium');
    expect(meta['titleAnimation']).toBe(false);
    expect(meta['reasoningMode']).toBe('off');
    expect(meta['reasoningEffort']).toBe('max');
    expect(meta['reasoningPreserve']).toBe(true);
    expect(meta['cacheTtl']).toBe('5m');
    expect(meta['modelMatrix']).toEqual({
      planner: {
        modelRuntime: {
          reasoning: { mode: 'on', effort: 'low', preserve: false },
        },
      },
    });
  });

  it('seeds uiLocale from config.json so WebUI starts in the shared language', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-meta-locale-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(globalConfigPath, JSON.stringify({ version: 1, uiLocale: 'tr' }), 'utf8');
    const meta: Record<string, unknown> = {};

    await seedConfigToMeta({ agent: { ctx: { meta } }, globalConfigPath } as never);

    expect(meta['uiLocale']).toBe('tr');
  });
});
