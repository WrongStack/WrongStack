import { describe, expect, it } from 'vitest';
import { seedContextMeta } from '../src/server/context-meta.js';

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    autonomy: {},
    features: {},
    context: {},
    modelRuntime: {},
    extensions: {},
    ...overrides,
  };
}

describe('seedContextMeta', () => {
  it('sets autonomy to off by default when no defaultMode', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['autonomy']).toBe('off');
  });

  it('sets autonomy to suggest when defaultMode is suggest', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ autonomy: { defaultMode: 'suggest' } }), context);
    expect(context.meta['autonomy']).toBe('suggest');
  });

  it('sets autonomy to auto when defaultMode is auto', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ autonomy: { defaultMode: 'auto' } }), context);
    expect(context.meta['autonomy']).toBe('auto');
  });

  it('sets autonomy to off for unknown modes', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ autonomy: { defaultMode: 'unknown' } }), context);
    expect(context.meta['autonomy']).toBe('off');
  });

  it('sets default autonomyDelayMs to 45000', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['autonomyDelayMs']).toBe(45000);
  });

  it('sets the default auto-review quiet window to 15000ms', () => {
    const context: { meta: Record<string, unknown> } = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['autoReviewDebounceMs']).toBe(15_000);
  });

  it('reads autoProceedDelayMs from config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ autonomy: { autoProceedDelayMs: 30000 } }), context);
    expect(context.meta['autonomyDelayMs']).toBe(30000);
  });

  it('sets autoProceedMaxIterations with default 50', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['autoProceedMaxIterations']).toBe(50);
  });

  it('reads autoProceedMaxIterations from config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ autonomy: { autoProceedMaxIterations: 100 } }), context);
    expect(context.meta['autoProceedMaxIterations']).toBe(100);
  });

  it('sets yolo from autonomy config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ autonomy: { yolo: true } }), context);
    expect(context.meta['yolo']).toBe(true);
  });

  it('falls back to config.yolo when autonomy.yolo is not set', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ yolo: true }), context);
    expect(context.meta['yolo']).toBe(true);
  });

  it('sets chime from config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ autonomy: { chime: true } }), context);
    expect(context.meta['chime']).toBe(true);
  });

  it('sets confirmExit default to true', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['confirmExit']).toBe(true);
  });

  it('sets confirmExit to false when configured', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ autonomy: { confirmExit: false } }), context);
    expect(context.meta['confirmExit']).toBe(false);
  });

  it('sets fleetChatVerbosity default to off', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['fleetChatVerbosity']).toBe('off');
  });

  it('sets fleetChatVerbosity to off when configured', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ autonomy: { fleetChatVerbosity: 'off' } }), context);
    expect(context.meta['fleetChatVerbosity']).toBe('off');
  });

  it('sets enhanceEnabled default to true', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['enhanceEnabled']).toBe(true);
  });

  it('sets enhanceDelayMs default to 60000', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['enhanceDelayMs']).toBe(60000);
  });

  it('sets enhanceLanguage default to "original"', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['enhanceLanguage']).toBe('original');
  });

  it('sets nextPrediction from config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ nextPrediction: true }), context);
    expect(context.meta['nextPrediction']).toBe(true);
  });

  it('sets fallbackModels from config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ fallbackModels: ['gpt-4'] }), context);
    expect(context.meta['fallbackModels']).toEqual(['gpt-4']);
  });

  it('sets fallbackBridge from config', () => {
    const context: { meta: Record<string, unknown> } = { meta: {} };
    seedContextMeta(makeConfig({ fallbackBridge: 'openai/gpt-5' }), context);
    expect(context.meta['fallbackBridge']).toBe('openai/gpt-5');
  });

  it('reports the same bridge and explicit chain used by auto-review', () => {
    const context: { meta: Record<string, unknown> } = { meta: {} };
    seedContextMeta(
      makeConfig({
        provider: 'openai',
        fallbackBridge: 'anthropic/claude-opus',
        fallbackModels: ['openai/gpt-5-mini'],
        fallbackAuto: false,
      }),
      context,
    );
    expect(context.meta['autoReviewFallbackModels']).toEqual([
      'anthropic/claude-opus',
      'openai/gpt-5-mini',
    ]);
  });

  it('sets fallbackProfiles from config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ fallbackProfiles: { coding: ['claude'] } }), context);
    expect(context.meta['fallbackProfiles']).toEqual({ coding: ['claude'] });
  });

  it('sets favoriteModels from config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ favoriteModels: ['gpt-4o'] }), context);
    expect(context.meta['favoriteModels']).toEqual(['gpt-4o']);
  });

  it('sets favoriteModelsOnly', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ favoriteModelsOnly: true }), context);
    expect(context.meta['favoriteModelsOnly']).toBe(true);
  });

  it('sets modelMatrix from config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ modelMatrix: { 'gpt-4': ['gpt-4o'] } }), context);
    expect(context.meta['modelMatrix']).toEqual({ 'gpt-4': ['gpt-4o'] });
  });

  it('sets fallbackAuto default to true', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['fallbackAuto']).toBe(true);
  });

  it('sets uiLocale when config has a truthy string', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ uiLocale: 'tr-TR' }), context);
    expect(context.meta['uiLocale']).toBe('tr-TR');
  });

  it('does not set uiLocale when config has empty string', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ uiLocale: '' }), context);
    expect(context.meta['uiLocale']).toBeUndefined();
  });

  it('does not set uiLocale when config has non-string value', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ uiLocale: 42 }), context);
    expect(context.meta['uiLocale']).toBeUndefined();
  });

  it('enables features by default', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['featureMcp']).toBe(true);
    expect(context.meta['featurePlugins']).toBe(true);
    expect(context.meta['featureMemory']).toBe(true);
    expect(context.meta['featureSkills']).toBe(true);
    expect(context.meta['featureModelsRegistry']).toBe(true);
  });

  it('disables features when configured', () => {
    const context = { meta: {} };
    seedContextMeta(
      makeConfig({
        features: {
          mcp: false,
          plugins: false,
          memory: false,
          skills: false,
          modelsRegistry: false,
        },
      }),
      context,
    );
    expect(context.meta['featureMcp']).toBe(false);
    expect(context.meta['featurePlugins']).toBe(false);
    expect(context.meta['featureMemory']).toBe(false);
    expect(context.meta['featureSkills']).toBe(false);
    expect(context.meta['featureModelsRegistry']).toBe(false);
  });

  it('sets indexOnStart default to true', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['indexOnStart']).toBe(true);
  });

  it('sets indexOnStart to false when configured', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ indexing: { onSessionStart: false } }), context);
    expect(context.meta['indexOnStart']).toBe(false);
  });

  it('sets contextAutoCompact default to true', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['contextAutoCompact']).toBe(true);
  });

  it('sets contextStrategy default to hybrid', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['contextStrategy']).toBe('hybrid');
  });

  it('sets logLevel default to info', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['logLevel']).toBe('info');
  });

  it('sets auditLevel default to standard', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['auditLevel']).toBe('standard');
  });

  it('sets maxIterations default to 500', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['maxIterations']).toBe(500);
  });

  it('sets contextMode default to balanced', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['contextMode']).toBe('balanced');
  });

  it('sets tokenSavingTier to off by default', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['tokenSavingTier']).toBe('off');
  });

  it('handles tokenSavingMode string values', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ features: { tokenSavingMode: 'aggressive' } }), context);
    expect(context.meta['tokenSavingTier']).toBe('aggressive');
  });

  it('handles tokenSavingMode true -> medium', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ features: { tokenSavingMode: true } }), context);
    expect(context.meta['tokenSavingTier']).toBe('medium');
  });

  it('sets maxConcurrent default to 10', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['maxConcurrent']).toBe(10);
  });

  it('reads maxConcurrent from config', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ maxConcurrent: 5 }), context);
    expect(context.meta['maxConcurrent']).toBe(5);
  });

  it('sets titleAnimation default to true', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['titleAnimation']).toBe(true);
  });

  it('handles modelRuntime reasoning settings', () => {
    const context = { meta: {} };
    seedContextMeta(
      makeConfig({
        modelRuntime: {
          reasoning: { mode: 'manual', effort: 'medium', preserve: true },
          cache: { ttl: '5m' },
        },
      }),
      context,
    );
    expect(context.meta['reasoningMode']).toBe('manual');
    expect(context.meta['reasoningEffort']).toBe('medium');
    expect(context.meta['reasoningPreserve']).toBe(true);
    expect(context.meta['cacheTtl']).toBe('5m');
  });

  it('sets default reasoning values when modelRuntime is empty', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['reasoningMode']).toBe('auto');
    expect(context.meta['reasoningEffort']).toBe('high');
    expect(context.meta['reasoningPreserve']).toBe(false);
    expect(context.meta['cacheTtl']).toBe('default');
  });

  it('handles hq config', () => {
    const context = { meta: {} };
    seedContextMeta(
      makeConfig({
        hq: { enabled: true, url: 'https://hq.example.com', token: 'secret', rawContent: true },
      }),
      context,
    );
    expect(context.meta['hqEnabled']).toBe(true);
    expect(context.meta['hqUrl']).toBe('https://hq.example.com');
    expect(context.meta).not.toHaveProperty('hqToken');
    expect(context.meta['hqRawContent']).toBe(true);
  });

  it('handles hq config defaults', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['hqEnabled']).toBe(false);
    expect(context.meta['hqUrl']).toBe('');
    expect(context.meta).not.toHaveProperty('hqToken');
    expect(context.meta['hqRawContent']).toBe(false);
  });

  it('handles telegram extension settings', () => {
    const context = { meta: {} };
    seedContextMeta(
      makeConfig({
        extensions: {
          telegram: {
            botToken: 'tg-token-here',
            notifyOnSessionEnd: true,
            notifyOnDelegate: false,
            longToolThresholdMs: 60000,
          },
        },
      }),
      context,
    );
    expect(context.meta['tgConfigured']).toBe(true);
    expect(context.meta['tgSessionEnd']).toBe(true);
    expect(context.meta['tgDelegate']).toBe(false);
    expect(context.meta['tgLongToolMs']).toBe(60000);
  });

  it('handles telegram with missing bot token', () => {
    const context = { meta: {} };
    seedContextMeta(
      makeConfig({
        extensions: { telegram: { botToken: '' } },
      }),
      context,
    );
    expect(context.meta['tgConfigured']).toBe(false);
  });

  it('handles no telegram extension', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['tgConfigured']).toBe(false);
    expect(context.meta['tgSessionEnd']).toBe(false);
    expect(context.meta['tgDelegate']).toBe(true);
    expect(context.meta['tgLongToolMs']).toBe(30000);
  });

  it('handles missing extensions field entirely', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig({ extensions: undefined } as any), context);
    expect(context.meta['tgConfigured']).toBe(false);
  });
});

// The settings panel used to render each switch from the browser's own
// localStorage guess, so a plugin the config had already decided (especially
// via a plugins[] entry, which outranks extensions.<name>.enabled) showed the
// wrong state on connect.
describe('seedContextMeta — per-plugin effective state', () => {
  const seed = (config: Record<string, unknown>): Record<string, unknown> | undefined => {
    const context = { meta: {} as Record<string, unknown> };
    seedContextMeta(makeConfig(config), context);
    return context.meta['pluginsEnabled'] as Record<string, unknown> | undefined;
  };

  it('reports a plugins[] entry as the winner over an opposing extension', () => {
    expect(
      seed({
        plugins: [{ name: 'type-gate', enabled: false }],
        extensions: { 'type-gate': { enabled: true } },
      }),
    ).toEqual({ 'type-gate': false });
  });

  it('reports an extensions-only plugin', () => {
    expect(
      seed({ plugins: [], extensions: { 'duplicate-code-detector': { enabled: true } } }),
    ).toEqual({ 'duplicate-code-detector': true });
  });

  it('reports a bare string entry as enabled', () => {
    expect(seed({ plugins: ['todo-listener'], extensions: {} })).toEqual({
      'todo-listener': true,
    });
  });

  it('reports everything disabled when features.plugins is false', () => {
    expect(seed({ plugins: ['todo-listener'], features: { plugins: false } })).toEqual({
      'todo-listener': false,
    });
  });

  it('skips extensions that carry no boolean enabled flag', () => {
    expect(seed({ plugins: [], extensions: { telegram: { token: 'x' } } })).toBeUndefined();
  });

  it('omits the key entirely when the config decides no plugin', () => {
    expect(seed({ plugins: [], extensions: {} })).toBeUndefined();
  });

  it('does not let a __proto__ plugin name reach the meta object', () => {
    const config = JSON.parse('{"plugins":["__proto__"],"extensions":{}}') as Record<
      string,
      unknown
    >;
    expect(seed(config)).toBeUndefined();
    expect(({} as Record<string, unknown>)['enabled']).toBeUndefined();
  });

  // WrongProxy / WrongTrace: the boot-read path in `seedContextMeta` must
  // project `config.tools.wrongProxy.{enabled,url}` onto the flat meta
  // keys the WebUI panel reads. Without this projection, a restart boots
  // with the panel showing defaults (toggle off, default URL) even though
  // the persisted config has the values — the symptom the persist-layer
  // fix alone would leave behind. Mirrors the CLI's
  // `tui-settings-adapter.ts:266-268` read path so TUI and WebUI agree.
  it('seeds wrongProxyEnabled + wrongProxyUrl from config.tools.wrongProxy', () => {
    const context = { meta: {} };
    seedContextMeta(
      makeConfig({ tools: { wrongProxy: { enabled: true, url: 'http://proxy.local:9000' } } }),
      context,
    );
    expect(context.meta['wrongProxyEnabled']).toBe(true);
    expect(context.meta['wrongProxyUrl']).toBe('http://proxy.local:9000');
  });

  it('defaults wrongProxyEnabled to false and wrongProxyUrl to empty when config has no nested entry', () => {
    const context = { meta: {} };
    seedContextMeta(makeConfig(), context);
    expect(context.meta['wrongProxyEnabled']).toBe(false);
    expect(context.meta['wrongProxyUrl']).toBe('');
  });

  it('preserves a sibling tools.* key when seeding wrongProxy', () => {
    const context = { meta: {} };
    seedContextMeta(
      makeConfig({
        tools: {
          maxIterations: 80,
          wrongProxy: { enabled: true, url: 'http://p:1' },
        },
      }),
      context,
    );
    expect(context.meta['wrongProxyEnabled']).toBe(true);
    expect(context.meta['wrongProxyUrl']).toBe('http://p:1');
    expect(context.meta['maxIterations']).toBe(80);
  });
});
