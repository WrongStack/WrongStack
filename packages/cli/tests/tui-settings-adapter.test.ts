import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import type { Config } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { createSettingsAdapter } from '../src/boot/tui-settings-adapter.js';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'test',
    model: 'test-model',
    maxConcurrent: 4,
    context: {
      warnThreshold: 0.7,
      softThreshold: 0.8,
      hardThreshold: 0.95,
      preserveK: 10,
      eliseThreshold: 2000,
      autoCompact: true,
      strategy: 'hybrid',
      mode: 'balanced',
    },
    tools: {
      defaultExecutionStrategy: 'smart',
      maxIterations: 100,
      iterationTimeoutMs: 300_000,
      sessionTimeoutMs: 1_800_000,
      perIterationOutputCapBytes: 100_000,
      descriptionMode: {},
      autoExtendLimit: true,
      restrictToProjectRoot: false,
    },
    log: { level: 'info' },
    features: {
      mcp: true,
      plugins: true,
      memory: true,
      modelsRegistry: true,
      skills: true,
      tokenSavingMode: 'off',
      allowOutsideProjectRoot: true,
    },
    autonomy: {
      autoProceedDelayMs: 45_000,
    },
    indexing: {
      onSessionStart: true,
      onEdit: true,
      watchExternal: true,
      debounceMs: 400,
    },
    session: {
      auditLevel: 'standard',
    },
    modelRuntime: {
      reasoning: { mode: 'auto', effort: 'high', preserve: false },
      cache: { ttl: '1h' },
      parameters: { user: 'kept' },
    },
    ...overrides,
  };
}

function makeAdapter(initial = baseConfig()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wstack-tui-settings-'));
  const globalConfig = path.join(dir, 'global', 'config.json');
  const inProjectConfig = path.join(dir, 'project', '.wrongstack', 'config.json');
  mkdirSync(path.dirname(globalConfig), { recursive: true });
  writeFileSync(globalConfig, JSON.stringify(initial, null, 2), 'utf8');

  const configStore = new DefaultConfigStore(initial);
  const applied: unknown[] = [];
  const adapter = createSettingsAdapter({
    configStore,
    wpaths: { globalConfig, profileConfig: () => globalConfig, inProjectConfig } as never,
    fleetStreamController: undefined,
    applyLiveSettings: (settings) => {
      applied.push(settings);
    },
  });

  return { adapter, configStore, globalConfig, inProjectConfig, applied };
}

describe('TUI settings adapter', () => {
  it('returns the runtime default maxConcurrent when config has no setting', () => {
    const initial = baseConfig({ maxConcurrent: undefined as never });
    const { adapter } = makeAdapter(initial);

    expect(adapter.getSettings().maxConcurrent).toBe(4);
  });

  it('partial saves preserve existing autonomy fields', async () => {
    const { adapter, configStore, globalConfig } = makeAdapter(
      baseConfig({
        autonomy: {
          defaultMode: 'suggest',
          autoProceedDelayMs: 30_000,
          terminalTitleAnimation: false,
        },
      }),
    );

    const err = await adapter.saveSettings({ contextMode: 'deep' });

    expect(err).toBeNull();
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.defaultMode).toBe('suggest');
    expect(written.autonomy.autoProceedDelayMs).toBe(30_000);
    expect(written.autonomy.terminalTitleAnimation).toBe(false);
    expect(written.context.mode).toBe('deep');
    expect(configStore.get().autonomy?.defaultMode).toBe('suggest');
    expect(configStore.get().autonomy?.autoProceedDelayMs).toBe(30_000);
  });

  it('cacheTtl default removes cache TTL from disk and the live config store', async () => {
    const { adapter, configStore, globalConfig } = makeAdapter(
      baseConfig({
        modelRuntime: {
          reasoning: { mode: 'auto', effort: 'high', preserve: false },
          cache: { ttl: '5m' },
        },
      }),
    );

    const err = await adapter.saveSettings({ cacheTtl: 'default' });

    expect(err).toBeNull();
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.modelRuntime.cache).toBeUndefined();
    expect(configStore.get().modelRuntime?.cache).toBeUndefined();
  });

  it('persists all TUI settings rows that are saved through the picker', async () => {
    const { adapter, configStore, globalConfig, applied } = makeAdapter();

    const err = await adapter.saveSettings({
      mode: 'auto',
      delayMs: 15_000,
      yolo: true,
      featureTokenSaving: 'light',
      allowOutsideProjectRoot: false,
      contextAutoCompact: false,
      contextStrategy: 'selective',
      contextMode: 'deep',
      maxConcurrent: 25,
      logLevel: 'debug',
      auditLevel: 'full',
      indexOnStart: false,
      maxIterations: 200,
      autoProceedMaxIterations: 10,
      enhanceDelayMs: 15_000,
      enhanceEnabled: false,
      enhanceLanguage: 'english',
      reasoningMode: 'off',
      reasoningEffort: 'minimal',
      reasoningPreserve: true,
      cacheTtl: '5m',
      showAgentSwarmPanel: 'off',
    });

    expect(err).toBeNull();
    expect(applied).toHaveLength(1);

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.autoProceedDelayMs).toBe(15_000);
    expect(written.yolo).toBe(true);
    expect(written.autonomy.yolo).toBe(true);
    expect(written.autonomy.autoProceedMaxIterations).toBe(10);
    expect(written.autonomy.enhanceDelayMs).toBe(15_000);
    expect(written.autonomy.enhance).toBe(false);
    expect(written.autonomy.enhanceLanguage).toBe('english');
    expect(written.autonomy.showAgentSwarmPanel).toBe('off');
    expect(written.features.tokenSavingMode).toBe('light');
    expect(written.features.allowOutsideProjectRoot).toBe(false);
    expect(written.tools.restrictToProjectRoot).toBe(true);
    expect(written.context.autoCompact).toBe(false);
    expect(written.context.strategy).toBe('selective');
    expect(written.context.mode).toBe('deep');
    expect(written.maxConcurrent).toBe(25);
    expect(written.log.level).toBe('debug');
    expect(written.session.auditLevel).toBe('full');
    expect(written.indexing.onSessionStart).toBe(false);
    expect(written.modelRuntime.reasoning).toEqual({
      mode: 'off',
      effort: 'minimal',
      preserve: true,
    });
    expect(written.modelRuntime.cache.ttl).toBe('5m');

    const live = configStore.get();
    expect(live.yolo).toBe(true);
    expect(live.context.mode).toBe('deep');
    expect(live.maxConcurrent).toBe(25);
    expect(live.features.allowOutsideProjectRoot).toBe(false);
    expect(live.tools.restrictToProjectRoot).toBe(true);
    expect(live.autonomy?.enhanceDelayMs).toBe(15_000);
    expect(live.modelRuntime?.reasoning?.mode).toBe('off');
    expect(live.modelRuntime?.cache?.ttl).toBe('5m');
    expect(live.modelRuntime?.parameters?.user).toBe('kept');

    const settings = adapter.getSettings();
    expect(settings['contextMode']).toBe('deep');
    expect(settings['maxConcurrent']).toBe(25);
    expect(settings['reasoningMode']).toBe('off');
    expect(settings['cacheTtl']).toBe('5m');
    expect(settings['showAgentSwarmPanel']).toBe('off');
  });

  it('restrictFsToRoot=true alone keeps both fs-access keys consistent', async () => {
    // Regression: the previous implementation wrote `tools.restrictToProjectRoot`
    // and `features.allowOutsideProjectRoot` from three separate sites and
    // could leave them out of sync. Saving only restrictFsToRoot=true must
    // set features.allowOutsideProjectRoot=false (the inverse) and the live
    // config store must reflect both.
    const { adapter, configStore, globalConfig } = makeAdapter();

    const err = await adapter.saveSettings({ restrictFsToRoot: true });

    expect(err).toBeNull();
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.tools.restrictToProjectRoot).toBe(true);
    expect(written.features.allowOutsideProjectRoot).toBe(false);
    const live = configStore.get();
    expect(live.tools?.restrictToProjectRoot).toBe(true);
    expect(live.features?.allowOutsideProjectRoot).toBe(false);
  });

  it('restrictFsToRoot=false alone keeps both fs-access keys consistent', async () => {
    const { adapter, configStore, globalConfig } = makeAdapter(
      baseConfig({ tools: { restrictToProjectRoot: true, maxIterations: 100, iterationTimeoutMs: 300_000, sessionTimeoutMs: 1_800_000, perIterationOutputCapBytes: 100_000, descriptionMode: {}, autoExtendLimit: true, defaultExecutionStrategy: 'smart' } }),
    );

    const err = await adapter.saveSettings({ restrictFsToRoot: false });

    expect(err).toBeNull();
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.tools.restrictToProjectRoot).toBe(false);
    expect(written.features.allowOutsideProjectRoot).toBe(true);
    const live = configStore.get();
    expect(live.tools?.restrictToProjectRoot).toBe(false);
    expect(live.features?.allowOutsideProjectRoot).toBe(true);
  });

  it('contradictory allowOutsideProjectRoot and restrictFsToRoot: allow wins', async () => {
    // The picker should not produce this state, but if a defensive code path
    // sets both with conflicting polarities, the contract is:
    // allowOutsideProjectRoot is the source of truth, restrictToProjectRoot
    // is its inverse. Both must agree on disk after the save.
    const { adapter, globalConfig } = makeAdapter();

    // allowOutsideProjectRoot=false implies restrictToProjectRoot=true;
    // restrictFsToRoot=false contradicts that. allow wins, so the file
    // must have features.allowOutsideProjectRoot=false AND
    // tools.restrictToProjectRoot=true (not the user's restrictFsToRoot).
    const err = await adapter.saveSettings({
      allowOutsideProjectRoot: false,
      restrictFsToRoot: false,
    });

    expect(err).toBeNull();
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.features.allowOutsideProjectRoot).toBe(false);
    expect(written.tools.restrictToProjectRoot).toBe(true);
  });

  it('round-trip: getSettings() returns consistent allowOutsideProjectRoot and restrictFsToRoot after a save', async () => {
    // Regression: after toggling either knob, the picker's two readings
    // must agree (allowOutsideProjectRoot === !restrictFsToRoot). A drift
    // here meant the picker could "snap back" or display contradictory
    // values for the same underlying setting.
    const { adapter } = makeAdapter();

    await adapter.saveSettings({ allowOutsideProjectRoot: false });
    let s = adapter.getSettings();
    expect(s['allowOutsideProjectRoot']).toBe(false);
    expect(s['restrictFsToRoot']).toBe(true);

    await adapter.saveSettings({ allowOutsideProjectRoot: true });
    s = adapter.getSettings();
    expect(s['allowOutsideProjectRoot']).toBe(true);
    expect(s['restrictFsToRoot']).toBe(false);

    await adapter.saveSettings({ restrictFsToRoot: true });
    s = adapter.getSettings();
    expect(s['restrictFsToRoot']).toBe(true);
    expect(s['allowOutsideProjectRoot']).toBe(false);
  });

  it('creates the project config when config scope changes to project', async () => {
    const { adapter, configStore, inProjectConfig } = makeAdapter();

    const err = await adapter.saveSettings({
      mode: 'auto',
      delayMs: 15_000,
      configScope: 'project',
      contextMode: 'frugal',
      enhanceDelayMs: 15_000,
      enhanceEnabled: false,
      reasoningMode: 'on',
      cacheTtl: '5m',
    });

    expect(err).toBeNull();
    const written = JSON.parse(readFileSync(inProjectConfig, 'utf8'));
    expect(written.configScope).toBe('project');
    expect(written.autonomy.defaultMode).toBe('auto');
    expect(written.autonomy.autoProceedDelayMs).toBe(15_000);
    expect(written.autonomy.enhanceDelayMs).toBe(15_000);
    expect(written.autonomy.enhance).toBe(false);
    expect(written.context.mode).toBe('frugal');
    expect(written.modelRuntime.reasoning.mode).toBe('on');
    expect(written.modelRuntime.cache.ttl).toBe('5m');
    expect(configStore.get().configScope).toBe('project');
    expect(configStore.get().autonomy?.defaultMode).toBe('auto');
    expect(configStore.get().autonomy?.autoProceedDelayMs).toBe(15_000);
    expect(configStore.get().context.mode).toBe('frugal');
    expect(configStore.get().modelRuntime?.reasoning?.mode).toBe('on');
  });

  // ── getSettings() filesystem-access pair resolution ────────────────────
  //
  // The picker reads TWO knobs from the config (allowOutsideProjectRoot +
  // restrictFsToRoot). The save side already derives them from one
  // input — `deriveFsAccessPair`. The read side used to read them as
  // independent values, which meant a legacy config that ONLY carried
  // `tools.restrictToProjectRoot=true` would surface in the picker as
  // `allow=true, restrict=true` (contradictory) and a save would silently
  // flip the user's restriction. These tests pin the read-side fix.

  it('legacy config with only tools.restrictToProjectRoot=true resolves as allow=false, restrict=true', () => {
    const { adapter } = makeAdapter(
      baseConfig({
        // Force-restrict. The "new" features.allowOutsideProjectRoot is
        // explicitly absent so the read side has to fall back to tools.
        tools: {
          defaultExecutionStrategy: 'smart',
          maxIterations: 100,
          iterationTimeoutMs: 300_000,
          sessionTimeoutMs: 1_800_000,
          perIterationOutputCapBytes: 100_000,
          descriptionMode: {},
          autoExtendLimit: true,
          restrictToProjectRoot: true,
        },
        features: {
          mcp: true,
          plugins: true,
          memory: true,
          modelsRegistry: true,
          skills: true,
          tokenSavingMode: 'off',
          // allowOutsideProjectRoot intentionally absent
        },
      }),
    );

    const s = adapter.getSettings();
    // Both knobs must agree — the picker's whole point is that they're
    // inverses of each other.
    expect(s['allowOutsideProjectRoot']).toBe(false);
    expect(s['restrictFsToRoot']).toBe(true);
  });

  it('features.allowOutsideProjectRoot=false alone overrides absent tools.restrictToProjectRoot', () => {
    const { adapter } = makeAdapter(
      baseConfig({
        // allow explicitly set; tools.restrictToProjectRoot absent.
        features: {
          mcp: true,
          plugins: true,
          memory: true,
          modelsRegistry: true,
          skills: true,
          tokenSavingMode: 'off',
          allowOutsideProjectRoot: false,
        },
        tools: {
          defaultExecutionStrategy: 'smart',
          maxIterations: 100,
          iterationTimeoutMs: 300_000,
          sessionTimeoutMs: 1_800_000,
          perIterationOutputCapBytes: 100_000,
          descriptionMode: {},
          autoExtendLimit: true,
          // restrictToProjectRoot intentionally absent
        },
      }),
    );

    const s = adapter.getSettings();
    expect(s['allowOutsideProjectRoot']).toBe(false);
    expect(s['restrictFsToRoot']).toBe(true);
  });

  it('legacy config with both sides set consistently stays consistent after a save+getSettings', async () => {
    // Pre-fix: this would silently flip on save because the picker would
    // display allow=true (from default), restrict=true (from legacy).
    // Post-fix: the read resolves allow=false, restrict=true. A save of
    // restrictFsToRoot=true leaves both sides in agreement.
    const { adapter, globalConfig } = makeAdapter(
      baseConfig({
        tools: {
          defaultExecutionStrategy: 'smart',
          maxIterations: 100,
          iterationTimeoutMs: 300_000,
          sessionTimeoutMs: 1_800_000,
          perIterationOutputCapBytes: 100_000,
          descriptionMode: {},
          autoExtendLimit: true,
          restrictToProjectRoot: true,
        },
        features: {
          mcp: true,
          plugins: true,
          memory: true,
          modelsRegistry: true,
          skills: true,
          tokenSavingMode: 'off',
        },
      }),
    );

    let s = adapter.getSettings();
    expect(s['allowOutsideProjectRoot']).toBe(false);
    expect(s['restrictFsToRoot']).toBe(true);

    // Now the user saves the same intent through the picker. Both knobs
    // must round-trip as inverses; the file must NOT regress to default.
    const err = await adapter.saveSettings({ restrictFsToRoot: true });
    expect(err).toBeNull();

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.tools.restrictToProjectRoot).toBe(true);
    expect(written.features.allowOutsideProjectRoot).toBe(false);

    s = adapter.getSettings();
    expect(s['allowOutsideProjectRoot']).toBe(false);
    expect(s['restrictFsToRoot']).toBe(true);
  });

  it('legacy config where both sides disagree: features.allowOutsideProjectRoot wins on read', () => {
    // Defensive: a hand-edited config with contradictory values. The
    // source-of-truth order matches `deriveFsAccessPair` —
    // features.allowOutsideProjectRoot wins.
    const { adapter } = makeAdapter(
      baseConfig({
        tools: {
          defaultExecutionStrategy: 'smart',
          maxIterations: 100,
          iterationTimeoutMs: 300_000,
          sessionTimeoutMs: 1_800_000,
          perIterationOutputCapBytes: 100_000,
          descriptionMode: {},
          autoExtendLimit: true,
          restrictToProjectRoot: false,
        },
        features: {
          mcp: true,
          plugins: true,
          memory: true,
          modelsRegistry: true,
          skills: true,
          tokenSavingMode: 'off',
          allowOutsideProjectRoot: false,
        },
      }),
    );

    const s = adapter.getSettings();
    expect(s['allowOutsideProjectRoot']).toBe(false);
    expect(s['restrictFsToRoot']).toBe(true);
  });

  it('neither side set: picker defaults to allow=true, restrict=false', () => {
    const { adapter } = makeAdapter(
      baseConfig({
        tools: {
          defaultExecutionStrategy: 'smart',
          maxIterations: 100,
          iterationTimeoutMs: 300_000,
          sessionTimeoutMs: 1_800_000,
          perIterationOutputCapBytes: 100_000,
          descriptionMode: {},
          autoExtendLimit: true,
          // restrictToProjectRoot intentionally absent
        },
        features: {
          mcp: true,
          plugins: true,
          memory: true,
          modelsRegistry: true,
          skills: true,
          tokenSavingMode: 'off',
          // allowOutsideProjectRoot intentionally absent
        },
      }),
    );

    const s = adapter.getSettings();
    expect(s['allowOutsideProjectRoot']).toBe(true);
    expect(s['restrictFsToRoot']).toBe(false);
  });
});
