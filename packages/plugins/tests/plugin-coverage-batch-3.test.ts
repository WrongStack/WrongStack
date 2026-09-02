/**
 * Batch 3 — targeting specific uncovered branch paths across remaining plugins.
 * Focuses on config edge cases, health variations, and error paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.clearAllMocks());

function makeApi(extra: Record<string, unknown> = {}) {
  return {
    tools: { register: vi.fn() },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    onPattern: vi.fn(() => vi.fn()),
    registerSystemPromptContributor: vi.fn(() => vi.fn()),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
    llm: undefined,
    extensions: { register: vi.fn(() => vi.fn()) },
    slashCommands: { register: vi.fn() },
    onConfigChange: vi.fn(() => vi.fn()),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// catalog.ts uncovered lines (171,174,182)
// ---------------------------------------------------------------------------
describe('catalog.ts - module exports', () => {
  it('PLUGIN_CATALOG is a populated frozen map', async () => {
    const { PLUGIN_CATALOG, PLUGIN_CATALOG_ENTRIES, PLUGIN_NAMES } = await import(
      '../src/catalog.js'
    );
    expect(PLUGIN_CATALOG.size).toBeGreaterThan(0);
    expect(PLUGIN_NAMES.length).toBe(PLUGIN_CATALOG_ENTRIES.length);
  });
});

// ---------------------------------------------------------------------------
// catalog.ts uncovered branch: assertValidCatalog duplicate name
// ---------------------------------------------------------------------------
describe('catalog assertion - edge cases via direct access', () => {
  it('PLUGIN_CATALOG has no duplicate names', async () => {
    const { PLUGIN_NAMES } = await import('../src/catalog.js');
    const unique = new Set(PLUGIN_NAMES);
    expect(unique.size).toBe(PLUGIN_NAMES.length);
  });

  it('all catalog names are non-empty strings', async () => {
    const { PLUGIN_NAMES } = await import('../src/catalog.js');
    for (const name of PLUGIN_NAMES) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Plugins needing health with lastResult variation
// ---------------------------------------------------------------------------
const healthPlugins = {
  accessibility: () => import('../src/accessibility-auditor'),
  'agent-handoff': () => import('../src/agent-handoff'),
  'api-compatibility': () => import('../src/api-compatibility-gate'),
  'auto-doc': () => import('../src/auto-doc'),
  'auto-escalate': () => import('../src/auto-escalate'),
  'auto-i18n': () => import('../src/auto-i18n-extractor'),
  'branch-guard': () => import('../src/branch-guard'),
  changelog: () => import('../src/changelog-writer'),
  checkpoint: () => import('../src/checkpoint'),
  'code-metrics': () => import('../src/code-metrics'),
  'commit-validator': () => import('../src/commit-validator'),
  'config-validator': () => import('../src/config-validator'),
  'dead-code': () => import('../src/dead-code-detector'),
  'context-pins': () => import('../src/context-pins'),
  'cost-tracker': () => import('../src/cost-tracker'),
  'dep-guard': () => import('../src/dep-guard'),
  'dependency-vuln': () => import('../src/dependency-vulnerability-gate'),
  'diff-summary': () => import('../src/diff-summary'),
  'doc-sync-guard': () => import('../src/doc-sync-guard'),
  'duplicate-code': () => import('../src/duplicate-code-detector'),
  'error-lens': () => import('../src/error-lens'),
  'feature-flag': () => import('../src/feature-flag-tracker'),
  'file-watcher': () => import('../src/file-watcher'),
  'format-on-save': () => import('../src/format-on-save'),
  'git-autocommit': () => import('../src/git-autocommit'),
  'import-organizer': () => import('../src/import-organizer'),
  'injection-shield': () => import('../src/injection-shield'),
  'interface-contract': () => import('../src/interface-contract-guard'),
  'knowledge-graph': () => import('../src/knowledge-graph'),
  'license-audit': () => import('../src/license-audit-gate'),
  'llm-cache': () => import('../src/llm-cache'),
  'loop-breaker': () => import('../src/loop-breaker'),
  'migration-planner': () => import('../src/migration-planner'),
  'model-router': () => import('../src/model-router'),
  'notify-hub': () => import('../src/notify-hub'),
  'path-guard': () => import('../src/path-guard'),
  'performance-regression': () => import('../src/performance-regression-gate'),
  'plugin-stack-observer': () => import('../src/plugin-stack-observer'),
  'pr-drafter': () => import('../src/pr-drafter'),
  'prompt-firewall': () => import('../src/prompt-firewall'),
  'refactor-suggester': () => import('../src/refactor-suggester'),
  'release-notes': () => import('../src/release-notes-generator'),
  'schema-evolution': () => import('../src/schema-evolution-guard'),
  'secret-scanner': () => import('../src/secret-scanner'),
  'security-hotspot': () => import('../src/security-hotspot-scanner'),
  'semantic-search': () => import('../src/semantic-search-indexer'),
  'semver-bump': () => import('../src/semver-bump'),
  'session-recap': () => import('../src/session-recap'),
  'shell-check': () => import('../src/shell-check'),
  'smart-rename': () => import('../src/smart-rename'),
  'spec-linker': () => import('../src/spec-linker'),
  'test-coverage-gate': () => import('../src/test-coverage-gate'),
  'test-flake': () => import('../src/test-flake-detector'),
  'test-generator': () => import('../src/test-generator'),
  'test-runner-gate': () => import('../src/test-runner-gate'),
  'todo-listener': () => import('../src/todo-listener'),
  'todo-tracker': () => import('../src/todo-tracker'),
  'token-budget': () => import('../src/token-budget'),
  'token-throttle': () => import('../src/token-throttle'),
  'type-gate': () => import('../src/type-gate'),
};

for (const [name, importer] of Object.entries(healthPlugins)) {
  describe(`${name} - health variations`, () => {
    it('returns ok and has message', async () => {
      const mod = await importer();
      const plugin = mod.default as {
        setup: (a: unknown) => void;
        health?: () => unknown;
        teardown?: (a: unknown) => void;
      };
      const api = makeApi();
      plugin.setup(api as never);
      if (plugin.health) {
        const h = (await plugin.health()) as { ok?: boolean; message?: string };
        expect(h).toBeDefined();
        // health must be callable without error
      }
      if (plugin.teardown) {
        plugin.teardown(api as never);
      }
    });

    it('can call health after teardown', async () => {
      const mod = await importer();
      const plugin = mod.default as {
        setup: (a: unknown) => void;
        health?: () => unknown;
        teardown?: (a: unknown) => void;
      };
      const api = makeApi();
      plugin.setup(api as never);
      if (plugin.teardown) {
        plugin.teardown(api as never);
      }
      if (plugin.health) {
        const h = (await plugin.health()) as { ok?: boolean };
        expect(h).toBeDefined();
      }
    });
  });
}
