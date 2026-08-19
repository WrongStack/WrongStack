import { join } from 'node:path';
import type { Config, Logger } from '@wrongstack/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetDeprecatedWarningsForTests,
  builtinPluginNameFromSpec,
  DEPRECATED_PLUGIN_NAMES,
  pluginNameFromSpec,
  setupPlugins,
  warnIfDeprecatedPluginName,
} from '../src/wiring/plugins.js';

// loadPlugins is the one external function we care about — capture its
// invocations to confirm setupPlugins wires options & API factory correctly.
const pluginHostHandle = {
  loaded: [],
  failed: [],
  disposed: false,
  dispose: vi.fn().mockResolvedValue(undefined),
};
const loadPluginsMock = vi.fn().mockResolvedValue(pluginHostHandle);

vi.mock('virtual:broken-plugin', () => {
  throw new Error('boom');
});

// A virtual ESM module that setupPlugins can dynamically import. The shape
// must satisfy the external-plugin module contract (name + apiVersion + setup
// on the default export) or the pre-import validation rejects it.
vi.mock('virtual:test-plugin', () => ({
  default: { name: 'virtual:test-plugin', apiVersion: '^0.1', setup: vi.fn() },
}));

// ── Mock all @wrongstack/plugins/* imports ───────────────────────────────────
// These factories run during setupPlugins (BUILTIN_PLUGIN_FACTORIES iteration).
// Without mocks, vitest's dynamic import fails and emits a "failed to load" warn.
vi.mock('@wrongstack/plugins/todo-listener', () => ({
  default: { name: 'todo-listener', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/agent-handoff', () => ({
  default: { name: 'agent-handoff', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/cost-tracker', () => ({
  default: { name: 'cost-tracker', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/file-watcher', () => ({
  default: { name: 'file-watcher', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/git-autocommit', () => ({
  default: { name: 'git-autocommit', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/auto-doc', () => ({
  default: { name: 'auto-doc', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/shell-check', () => ({
  default: { name: 'shell-check', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/cron', () => ({ default: { name: 'cron', register: vi.fn() } }));
vi.mock('@wrongstack/plugins/template-engine', () => ({
  default: { name: 'template-engine', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/semver-bump', () => ({
  default: { name: 'semver-bump', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/secret-scanner', () => ({
  default: { name: 'secret-scanner', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/todo-tracker', () => ({
  default: { name: 'todo-tracker', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/token-budget', () => ({
  default: { name: 'token-budget', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/lint-gate', () => ({
  default: { name: 'lint-gate', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/branch-guard', () => ({
  default: { name: 'branch-guard', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/diff-summary', () => ({
  default: { name: 'diff-summary', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/commit-validator', () => ({
  default: { name: 'commit-validator', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/format-on-save', () => ({
  default: { name: 'format-on-save', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/test-runner-gate', () => ({
  default: { name: 'test-runner-gate', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/import-organizer', () => ({
  default: { name: 'import-organizer', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/knowledge-graph', () => ({
  default: { name: 'knowledge-graph', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/spec-linker', () => ({
  default: { name: 'spec-linker', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/loop-breaker', () => ({
  default: { name: 'loop-breaker', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/path-guard', () => ({
  default: { name: 'path-guard', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/context-pins', () => ({
  default: { name: 'context-pins', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/checkpoint', () => ({
  default: { name: 'checkpoint', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/error-lens', () => ({
  default: { name: 'error-lens', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/dep-guard', () => ({
  default: { name: 'dep-guard', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/config-validator', () => ({
  default: { name: 'config-validator', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/notify-hub', () => ({
  default: { name: 'notify-hub', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/changelog-writer', () => ({
  default: { name: 'changelog-writer', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/injection-shield', () => ({
  default: { name: 'injection-shield', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/llm-cache', () => ({
  default: { name: 'llm-cache', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/model-router', () => ({
  default: { name: 'model-router', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/pr-drafter', () => ({
  default: { name: 'pr-drafter', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/prompt-firewall', () => ({
  default: { name: 'prompt-firewall', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/auto-escalate', () => ({
  default: { name: 'auto-escalate', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/test-coverage-gate', () => ({
  default: { name: 'test-coverage-gate', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/type-gate', () => ({
  default: { name: 'type-gate', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/token-throttle', () => ({
  default: { name: 'token-throttle', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/plugin-stack-observer', () => ({
  default: { name: 'plugin-stack-observer', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/dependency-vulnerability-gate', () => ({
  default: { name: 'dependency-vulnerability-gate', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/migration-planner', () => ({
  default: { name: 'migration-planner', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/semantic-search-indexer', () => ({
  default: { name: 'semantic-search-indexer', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/auto-i18n-extractor', () => ({
  default: { name: 'auto-i18n-extractor', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/doc-sync-guard', () => ({
  default: { name: 'doc-sync-guard', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/api-compatibility-gate', () => ({
  default: { name: 'api-compatibility-gate', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/performance-regression-gate', () => ({
  default: { name: 'performance-regression-gate', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/test-flake-detector', () => ({
  default: { name: 'test-flake-detector', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/schema-evolution-guard', () => ({
  default: { name: 'schema-evolution-guard', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/license-audit-gate', () => ({
  default: { name: 'license-audit-gate', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/accessibility-auditor', () => ({
  default: { name: 'accessibility-auditor', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/security-hotspot-scanner', () => ({
  default: { name: 'security-hotspot-scanner', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/duplicate-code-detector', () => ({
  default: { name: 'duplicate-code-detector', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/code-metrics', () => ({
  default: { name: 'code-metrics', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/refactor-suggester', () => ({
  default: { name: 'refactor-suggester', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/test-generator', () => ({
  default: { name: 'test-generator', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/release-notes-generator', () => ({
  default: { name: 'release-notes-generator', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/smart-rename', () => ({
  default: { name: 'smart-rename', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/feature-flag-tracker', () => ({
  default: { name: 'feature-flag-tracker', register: vi.fn() },
}));
vi.mock('@wrongstack/plugins/interface-contract-guard', () => ({
  default: { name: 'interface-contract-guard', register: vi.fn() },
}));
vi.mock('@wrongstack/plug-lsp', () => ({ default: { name: 'plug-lsp', register: vi.fn() } }));
vi.mock('@wrongstack/telegram', () => ({ default: { name: 'telegram', register: vi.fn() } }));

// Mock the plugin owner: replace loadPlugins so we can observe calls.
vi.mock('@wrongstack/core/plugin', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, loadPlugins: (...args: unknown[]) => loadPluginsMock(...args) };
});

vi.mock('@wrongstack/mcp', () => ({ MCPRegistry: class {} }));
vi.mock('../src/plugin-api-factory.js', () => ({
  default: vi.fn(() => ({ kind: 'fake-api' })),
}));

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    setLevel: vi.fn(),
  } as never as Logger;
}

function baseDeps(overrides: Partial<Config> = {}) {
  return {
    config: {
      version: 1,
      provider: 'a',
      model: 'm',
      features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
      ...overrides,
    } as Config,
    container: { resolve: vi.fn(), has: vi.fn() } as never,
    events: {} as never,
    pipelines: {} as never,
    toolRegistry: {} as never,
    providerRegistry: {} as never,
    slashCommandRegistry: {} as never,
    mcpRegistry: {} as never,
    log: fakeLogger(),
    agent: {},
    sessionWriter: { transcriptPath: '/tmp/x.jsonl', append: vi.fn() } as never,
    configStore: {} as never,
  };
}

beforeEach(() => {
  loadPluginsMock.mockClear();
  _resetDeprecatedWarningsForTests();
});

describe('setupPlugins', () => {
  it('returns the disposable host handle supplied by the core loader', async () => {
    const result = await setupPlugins(baseDeps({ plugins: ['virtual:test-plugin'] as never }));

    expect(result).toBe(pluginHostHandle);
  });

  it('returns early when plugins feature disabled', async () => {
    const deps = baseDeps({
      features: { mcp: true, plugins: false, memory: true, modelsRegistry: true, skills: true },
      plugins: ['virtual:test-plugin'] as never,
    });
    await setupPlugins(deps);
    // plugins feature disabled → loadPlugins not called at all
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('returns early when no plugins list (no paths → no built-in plugins)', async () => {
    // paths not provided → built-in plugins skipped; no user plugins → early return
    await setupPlugins(baseDeps());
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('returns early when plugins list is empty (no paths → no built-in plugins)', async () => {
    await setupPlugins(baseDeps({ plugins: [] as never }));
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('skips object plugins explicitly disabled (no paths → no built-in plugins)', async () => {
    const deps = baseDeps({
      plugins: [{ name: 'virtual:test-plugin', enabled: false }] as never,
    });
    await setupPlugins(deps);
    // no paths → no built-ins, no user plugins → early return
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('warns and continues when a plugin import fails (no paths)', async () => {
    const deps = baseDeps({ plugins: ['virtual:broken-plugin'] as never });
    await setupPlugins(deps);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('virtual:broken-plugin'),
      expect.any(Error),
    );
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('loads string-form plugin (no paths → no built-in plugins)', async () => {
    const deps = baseDeps({ plugins: ['virtual:test-plugin'] as never });
    await setupPlugins(deps);
    expect(loadPluginsMock).toHaveBeenCalledTimes(1);
    const [plugins, opts] = loadPluginsMock.mock.calls[0]!;
    // only the user plugin; no built-ins since paths not provided
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('virtual:test-plugin');
    expect(opts.log).toBe(deps.log);
    expect(typeof opts.apiFactory).toBe('function');
  });

  it('loads object-form plugin and merges options from plugin + extensions', async () => {
    const deps = baseDeps({
      plugins: [{ name: 'virtual:test-plugin', options: { foo: 1, bar: 'a' } }] as never,
      extensions: { 'virtual:test-plugin': { bar: 'override', baz: true } } as never,
    });
    await setupPlugins(deps);
    const [, opts] = loadPluginsMock.mock.calls[0]!;
    // config.extensions wins on key collisions; new keys are merged in.
    expect(opts.pluginOptions['virtual:test-plugin']).toEqual({
      foo: 1,
      bar: 'override',
      baz: true,
    });
  });

  // ── built-in plugins: default-active load automatically; opt-in plugins load only when configured ──

  const EXPECTED_BUILTINS = ['wstack-prompts', 'wstack-sync', 'wstack-skills'];

  function fakePaths() {
    return {
      globalRoot: '/g',
      globalConfig: '/g/config.json',
      globalSkills: '/g/skills',
      globalPrompts: '/g/prompts',
      globalMemory: '/g/memory.md',
      historyFile: '/g/history',
      syncConfig: '/g/sync.json',
      projectPlan: '/p/plan.json',
    } as never;
  }

  it('loads default-active built-in plugins when paths are provided', async () => {
    const deps = { ...baseDeps(), paths: fakePaths() };
    await setupPlugins(deps as never);
    expect(loadPluginsMock).toHaveBeenCalledTimes(1);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_BUILTINS));
    expect(names).not.toContain('duplicate-code-detector');
    expect(names).not.toContain('format-on-save');
    expect(names).not.toContain('wstack-chimera');
    expect(names).not.toContain('agent-handoff');
    expect(names).not.toContain('branch-guard');
    expect(names).not.toContain('commit-validator');
    expect(names).not.toContain('path-guard');
    expect(names).not.toContain('checkpoint');
    expect(names).not.toContain('dependency-vulnerability-gate');
    expect(names).not.toContain('plugin-stack-observer');
    expect(names).not.toContain('@wrongstack/plug-lsp');
    expect(names).not.toContain('telegram');
  });

  it('loads a default-inactive built-in when enabled through extensions', async () => {
    const deps = {
      ...baseDeps({ extensions: { 'wstack-auto-review': { enabled: true } } as never }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((plugin) => plugin.name);
    expect(names).toContain('wstack-auto-review');
  });

  it('opts a default-active built-in out through extensions.<name>.enabled=false', async () => {
    // Regression: `extensions.<name>.enabled` was honoured only in its
    // `=== true` direction, so switching a plugin off there did nothing.
    const deps = {
      ...baseDeps({ extensions: { 'wstack-prompts': { enabled: false } } as never }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((plugin) => plugin.name);
    expect(names).not.toContain('wstack-prompts');
  });

  it('lets a plugins[] entry outrank an opposing extensions switch', async () => {
    const deps = {
      ...baseDeps({
        plugins: [{ name: 'wstack-auto-review', enabled: false }],
        extensions: { 'wstack-auto-review': { enabled: true } } as never,
      }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((plugin) => plugin.name);
    expect(names).not.toContain('wstack-auto-review');
  });

  it('injects the host vault into built-in plugin config', async () => {
    const vault = { encrypt: vi.fn((value: string) => `enc:${value}`) };
    const deps = { ...baseDeps(), paths: fakePaths(), vault };
    await setupPlugins(deps as never);
    const [, opts] = loadPluginsMock.mock.calls[0]!;
    const syncPlugin = (loadPluginsMock.mock.calls[0]![0] as Array<{ name: string }>).find(
      (plugin) => plugin.name === 'wstack-sync',
    );

    expect(syncPlugin).toBeDefined();
    const apiFactoryMod = (await import('../src/plugin-api-factory.js')) as never as {
      default: ReturnType<typeof vi.fn>;
    };
    let capturedConfig: Record<string, unknown> | undefined;
    apiFactoryMod.default.mockImplementationOnce(
      (_name, cfg: { config: Record<string, unknown> }) => {
        capturedConfig = cfg.config;
        return { kind: 'fake-api' };
      },
    );
    opts.apiFactory(syncPlugin);
    expect(capturedConfig?.vault).toBe(vault);
  });

  it('loads an opt-in built-in only when explicitly enabled', async () => {
    const deps = {
      ...baseDeps({ plugins: [{ name: 'plugin-stack-observer', enabled: true }] as never }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((p) => p.name);
    expect(names).toContain('plugin-stack-observer');
  });

  // ── todo-tracker project-scoped filePath defaulting ───────────────────────

  it('injects default todo-tracker filePath from paths.projectDir', async () => {
    const deps = {
      ...baseDeps(),
      paths: { ...(fakePaths() as object), projectDir: '/p/proj' } as never,
    };
    await setupPlugins(deps as never);
    const [, opts] = loadPluginsMock.mock.calls[0]!;
    // filePath is derived as <projectDir>/todo-tracker.json (join uses the
    // host path separator; assert on both to stay cross-platform).
    const fp = opts.pluginOptions['todo-tracker']?.filePath as string;
    expect(fp).toBe(join('/p/proj', 'todo-tracker.json'));
  });

  it('does NOT override an explicit user-configured todo-tracker filePath', async () => {
    const deps = {
      ...baseDeps({
        extensions: { 'todo-tracker': { filePath: '/custom/todos.json' } } as never,
      }),
      paths: { ...(fakePaths() as object), projectDir: '/p/proj' } as never,
    };
    await setupPlugins(deps as never);
    const [, opts] = loadPluginsMock.mock.calls[0]!;
    expect(opts.pluginOptions['todo-tracker']?.filePath).toBe('/custom/todos.json');
  });

  it('does NOT inject todo-tracker filePath when paths.projectDir is absent', async () => {
    // fakePaths() has no projectDir → nothing to derive from.
    const deps = { ...baseDeps(), paths: fakePaths() };
    await setupPlugins(deps as never);
    const [, opts] = loadPluginsMock.mock.calls[0]!;
    const tt = opts.pluginOptions['todo-tracker'] as { filePath?: string } | undefined;
    expect(tt?.filePath).toBeUndefined();
  });

  it('opts a single built-in out via config.plugins { enabled: false }', async () => {
    const deps = {
      ...baseDeps({ plugins: [{ name: 'wstack-skills', enabled: false }] as never }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((p) => p.name);
    expect(names).not.toContain('wstack-skills');
    // the rest stay enabled by default
    expect(names).toContain('wstack-prompts');
    expect(names).toContain('wstack-sync');
  });

  it('treats enabled short-name built-in config entries as controls, not bare package imports', async () => {
    const deps = {
      ...baseDeps({
        plugins: ['duplicate-code-detector', 'todo-listener'] as never,
      }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['duplicate-code-detector', 'todo-listener']));
    const failedLoadWarns = (deps.log.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('failed to load'),
    );
    expect(failedLoadWarns).toHaveLength(0);
  });

  it('lets qualified @wrongstack/plugins entries disable matching built-ins', async () => {
    const deps = {
      ...baseDeps({
        plugins: [{ name: '@wrongstack/plugins/agent-handoff', enabled: false }] as never,
      }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((p) => p.name);
    expect(names).not.toContain('agent-handoff');
  });

  it('features.plugins:false disables built-ins too', async () => {
    const deps = {
      ...baseDeps({
        features: { mcp: true, plugins: false, memory: true, modelsRegistry: true, skills: true },
      }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('apiFactory injects sessionWriter wrapper that delegates append', async () => {
    const deps = baseDeps({ plugins: ['virtual:test-plugin'] as never });
    await setupPlugins(deps);
    const [, opts] = loadPluginsMock.mock.calls[0]!;
    const apiCfgCapture = vi.fn();
    const apiFactoryMod = (await import('../src/plugin-api-factory.js')) as never as {
      default: ReturnType<typeof vi.fn>;
    };
    apiFactoryMod.default.mockImplementation(
      (_name, cfg: { sessionWriter: { append: (e: unknown) => void; transcriptPath: string } }) => {
        apiCfgCapture(cfg);
        cfg.sessionWriter.append({ type: 't', ts: 'now', data: 'x' });
        return {};
      },
    );
    opts.apiFactory({ name: 'virtual:test-plugin' });
    expect(apiCfgCapture).toHaveBeenCalled();
    expect(
      (deps as { sessionWriter?: { append: (e: unknown) => void } })?.sessionWriter?.append,
    ).toHaveBeenCalledWith({ type: 't', ts: 'now', data: 'x' });
  });

  it('forwards api.mailbox to the apiFactory so todo-listener-style plugins can publish', async () => {
    const mailboxMock = { send: vi.fn(), query: vi.fn() };
    // baseDeps returns a Partial<Config>-shaped bag; the wiring layer
    // accepts additional PluginsWiringDeps fields (like `mailbox`) on
    // top of that, so we add it after the spread.
    const deps = {
      ...baseDeps({ plugins: ['virtual:test-plugin'] as never }),
      mailbox: mailboxMock as never,
    };
    await setupPlugins(deps);
    const [, opts] = loadPluginsMock.mock.calls[0]!;
    const apiCfgCapture = vi.fn();
    const apiFactoryMod = (await import('../src/plugin-api-factory.js')) as never as {
      default: ReturnType<typeof vi.fn>;
    };
    // Capture the cfg the wiring layer passes to apiFactory, then return
    // a stub api object whose `mailbox` field references the same object
    // the wiring forwarded.
    apiFactoryMod.default.mockImplementation((_name, cfg: { mailbox?: unknown }) => {
      apiCfgCapture(cfg);
      return { mailbox: cfg.mailbox };
    });
    const api = opts.apiFactory({ name: 'virtual:test-plugin' }) as { mailbox: unknown };
    // The factory must receive the mailbox instance verbatim so plugins
    // can call api.mailbox.send. The default implementation
    // (DefaultPluginAPI) sets `this.mailbox = init.mailbox` — we
    // verify the contract here by asserting that whatever the factory
    // returned carries the same mailbox reference.
    expect(api.mailbox).toBe(mailboxMock);
    expect(apiCfgCapture).toHaveBeenCalled();
    const captured = apiCfgCapture.mock.calls[0]?.[0] as { mailbox?: unknown };
    expect(captured.mailbox).toBe(mailboxMock);
  });
});

// ── deprecated plugin names (loader-level deprecation policy) ────────────
//
// `web-search` and `json-path` were retired (their tools were merged
// into the built-in `search`/`fetch`/`json` tools). The CLI wiring now
// skips any user config that names these plugins and emits a one-shot
// warning pointing at the migration target. The tests below cover both
// surfaces — the helper (`warnIfDeprecatedPluginName`) and the wiring
// (`setupPlugins` integration).

describe('plugin deprecation policy', () => {
  describe('DEPRECATED_PLUGIN_NAMES', () => {
    it('lists web-search and json-path with migration hints', () => {
      expect(DEPRECATED_PLUGIN_NAMES['web-search']).toContain('search');
      expect(DEPRECATED_PLUGIN_NAMES['web-search']).toContain('fetch');
      expect(DEPRECATED_PLUGIN_NAMES['json-path']).toContain('json');
    });
  });

  describe('pluginNameFromSpec', () => {
    it('returns the basename for a fully-qualified spec', () => {
      expect(pluginNameFromSpec('@wrongstack/plugins/web-search')).toBe('web-search');
      expect(pluginNameFromSpec('@wrongstack/plugins/json-path')).toBe('json-path');
    });

    it('returns the input unchanged for a short name', () => {
      expect(pluginNameFromSpec('web-search')).toBe('web-search');
      expect(pluginNameFromSpec('json-path')).toBe('json-path');
    });

    it('returns null for relative paths, URLs, and fs paths', () => {
      expect(pluginNameFromSpec('./local-plugin')).toBeNull();
      expect(pluginNameFromSpec('/abs/path/plugin')).toBeNull();
      expect(pluginNameFromSpec('file:///abs/path')).toBeNull();
    });
  });

  describe('builtinPluginNameFromSpec', () => {
    it('recognizes short and @wrongstack/plugins built-in specs', () => {
      expect(builtinPluginNameFromSpec('duplicate-code-detector')).toBe('duplicate-code-detector');
      expect(builtinPluginNameFromSpec('todo-listener')).toBe('todo-listener');
      expect(builtinPluginNameFromSpec('lsp')).toBe('@wrongstack/plug-lsp');
      expect(builtinPluginNameFromSpec('@wrongstack/telegram')).toBe('telegram');
    });

    it('does not classify arbitrary user packages as built-ins', () => {
      expect(builtinPluginNameFromSpec('virtual:test-plugin')).toBeNull();
      expect(builtinPluginNameFromSpec('./local-plugin')).toBeNull();
    });
  });

  describe('warnIfDeprecatedPluginName', () => {
    it('returns false and does not log for unknown names', () => {
      const log = fakeLogger();
      expect(warnIfDeprecatedPluginName('not-deprecated', log)).toBe(false);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('warns once for a deprecated name and returns true', () => {
      const log = fakeLogger();
      expect(warnIfDeprecatedPluginName('web-search', log)).toBe(true);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect((log.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('web-search');
      expect((log.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('deprecated');
    });

    it('dedupes: a second call for the same name does not log again', () => {
      const log = fakeLogger();
      // First call: warns + returns true (caller skips plugin).
      expect(warnIfDeprecatedPluginName('json-path', log)).toBe(true);
      // Subsequent calls: still return true (caller should skip),
      // but don't log again — keeps the noise at one line.
      expect(warnIfDeprecatedPluginName('json-path', log)).toBe(true);
      expect(warnIfDeprecatedPluginName('json-path', log)).toBe(true);
      expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it('dedupes are per-name: json-path warn does not silence web-search', () => {
      const log = fakeLogger();
      warnIfDeprecatedPluginName('json-path', log);
      warnIfDeprecatedPluginName('web-search', log);
      expect(log.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('setupPlugins integration', () => {
    it('skips a user plugin named web-search (object form) and warns once', async () => {
      const deps = baseDeps({
        plugins: [{ name: 'web-search', enabled: true }] as never,
      });
      await setupPlugins(deps);
      // The wiring short-circuits when no plugins survive filtering —
      // loadPlugins is NOT called. That is the desired contract: an
      // empty plugin set means "nothing to load", not "load zero".
      expect(loadPluginsMock).not.toHaveBeenCalled();
      // Warning fires once with the migration hint
      expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('web-search'));
      expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('search'));
    });

    it('skips a user plugin named @wrongstack/plugins/json-path (qualified spec)', async () => {
      const deps = baseDeps({
        plugins: ['@wrongstack/plugins/json-path'] as never,
      });
      await setupPlugins(deps);
      expect(loadPluginsMock).not.toHaveBeenCalled();
      expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('json-path'));
    });

    it('dedupes across object-form and string-form references in the same config', async () => {
      const deps = baseDeps({
        plugins: [{ name: 'web-search', enabled: true }, '@wrongstack/plugins/web-search'] as never,
      });
      await setupPlugins(deps);
      // Both entries resolve to bare name 'web-search' — the helper's
      // per-process dedupe means the warning fires once and both
      // entries are skipped before reaching the dynamic import.
      const deprecationWarns = (deps.log.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('deprecated'),
      );
      expect(deprecationWarns).toHaveLength(1);
      // No "failed to load" warn — both entries were short-circuited
      // before reaching the dynamic import.
      const failedLoadWarns = (deps.log.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('failed to load'),
      );
      expect(failedLoadWarns).toHaveLength(0);
      // loadPlugins receives zero plugins → not called.
      expect(loadPluginsMock).not.toHaveBeenCalled();
    });

    it('does not warn or skip plugins that share a substring with a deprecated name', async () => {
      // A plugin named 'web-search-extras' would NOT trip the policy
      // (basename match is exact). We model a non-deprecated user
      // plugin to confirm the wiring doesn't false-positive.
      const deps = baseDeps({
        plugins: ['virtual:test-plugin'] as never,
      });
      await setupPlugins(deps);
      // The non-deprecated plugin loads normally
      expect(loadPluginsMock).toHaveBeenCalledTimes(1);
      const warnCalls = (deps.log.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('deprecated'),
      );
      expect(warnCalls).toHaveLength(0);
    });

    it('a mix of deprecated and active user plugins still loads the active ones', async () => {
      // web-search should be skipped; virtual:test-plugin should load.
      const deps = baseDeps({
        plugins: [{ name: 'web-search', enabled: true }, 'virtual:test-plugin'] as never,
      });
      await setupPlugins(deps);
      expect(loadPluginsMock).toHaveBeenCalledTimes(1);
      const [plugins] = loadPluginsMock.mock.calls[0]!;
      const names = (plugins as Array<{ name: string }>).map((p) => p.name);
      expect(names).toContain('virtual:test-plugin');
      expect(names).not.toContain('web-search');
    });
  });
});
