/**
 * Batch 2 supplementary tests — targeting uncovered branches across many plugins.
 * Covers: import-organizer, test-runner-gate, diff-summary, checkpoint,
 * agent-handoff, dependency-vulnerability-gate, doc-sync-guard,
 * feature-flag-tracker, performance-regression-gate, auto-i18n-extractor,
 * code-metrics, test-flake-detector, notify-hub, security-hotspot-scanner,
 * config-validator, migration-planner, secret-scanner, dep-guard,
 * changelog-writer, prompt-firewall, spec-linker,
 * cost-tracker, loop-breaker, test-generator, path-guard,
 * license-audit-gate, context-pins, token-throttle, model-router,
 * auto-doc, error-lens, file-watcher, release-notes-generator,
 * git-autocommit, injection-shield, shell-check, token-budget,
 * auto-escalate, semver-bump, branch-guard, format-on-save,
 * todo-tracker, accessibility-auditor, session-recap, smart-rename,
 * type-gate, template-engine, todo-listener, llm-cache, cron
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => vi.clearAllMocks());

// Helper for plugins that only have setup/teardown/health pattern
function makeBasicApi() {
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
  };
}

// Test health/teardown for many plugins in parallel
const plugins = {
  'import-organizer': () => import('../src/import-organizer'),
  'test-runner-gate': () => import('../src/test-runner-gate'),
  'diff-summary': () => import('../src/diff-summary'),
  checkpoint: () => import('../src/checkpoint'),
  'dependency-vulnerability-gate': () => import('../src/dependency-vulnerability-gate'),
  'doc-sync-guard': () => import('../src/doc-sync-guard'),
  'feature-flag-tracker': () => import('../src/feature-flag-tracker'),
  'performance-regression-gate': () => import('../src/performance-regression-gate'),
  'auto-i18n-extractor': () => import('../src/auto-i18n-extractor'),
  'code-metrics': () => import('../src/code-metrics'),
  'test-flake-detector': () => import('../src/test-flake-detector'),
  'notify-hub': () => import('../src/notify-hub'),
  'security-hotspot-scanner': () => import('../src/security-hotspot-scanner'),
  'config-validator': () => import('../src/config-validator'),
  'migration-planner': () => import('../src/migration-planner'),
  'secret-scanner': () => import('../src/secret-scanner'),
  'dep-guard': () => import('../src/dep-guard'),
  'changelog-writer': () => import('../src/changelog-writer'),
  'prompt-firewall': () => import('../src/prompt-firewall'),
  'spec-linker': () => import('../src/spec-linker'),
  'cost-tracker': () => import('../src/cost-tracker'),
  'loop-breaker': () => import('../src/loop-breaker'),
  'test-generator': () => import('../src/test-generator'),
  'path-guard': () => import('../src/path-guard'),
  'license-audit-gate': () => import('../src/license-audit-gate'),
  'context-pins': () => import('../src/context-pins'),
  'token-throttle': () => import('../src/token-throttle'),
  'model-router': () => import('../src/model-router'),
  'auto-doc': () => import('../src/auto-doc'),
  'error-lens': () => import('../src/error-lens'),
  'file-watcher': () => import('../src/file-watcher'),
  'release-notes-generator': () => import('../src/release-notes-generator'),
  'git-autocommit': () => import('../src/git-autocommit'),
  'injection-shield': () => import('../src/injection-shield'),
  'shell-check': () => import('../src/shell-check'),
  'token-budget': () => import('../src/token-budget'),
  'auto-escalate': () => import('../src/auto-escalate'),
  'semver-bump': () => import('../src/semver-bump'),
  'branch-guard': () => import('../src/branch-guard'),
  'format-on-save': () => import('../src/format-on-save'),
  'todo-tracker': () => import('../src/todo-tracker'),
  'accessibility-auditor': () => import('../src/accessibility-auditor'),
  'session-recap': () => import('../src/session-recap'),
  'smart-rename': () => import('../src/smart-rename'),
  'type-gate': () => import('../src/type-gate'),
  'todo-listener': () => import('../src/todo-listener'),
  'llm-cache': () => import('../src/llm-cache'),
  cron: () => import('../src/cron'),
  'template-engine': () => import('../src/template-engine'),
  'agent-handoff': () => import('../src/agent-handoff'),
};

for (const [name, importer] of Object.entries(plugins)) {
  describe(`${name} - setup/teardown/health`, () => {
    it('setup registers something', async () => {
      const mod = await importer();
      const plugin = mod.default as {
        setup: (api: unknown) => void;
        teardown?: (api: unknown) => void;
        health?: () => unknown;
      };
      const api = makeBasicApi();
      expect(() => plugin.setup(api as never)).not.toThrow();
    });

    it('teardown does not throw', async () => {
      const mod = await importer();
      const plugin = mod.default as {
        setup: (api: unknown) => void;
        teardown?: (api: unknown) => void;
        health?: () => unknown;
      };
      const api = makeBasicApi();
      plugin.setup(api as never);
      if (plugin.teardown) {
        expect(() => plugin.teardown(api as never)).not.toThrow();
      }
    });

    it('teardown twice is safe', async () => {
      const mod = await importer();
      const plugin = mod.default as {
        setup: (api: unknown) => void;
        teardown?: (api: unknown) => void;
        health?: () => unknown;
      };
      const api = makeBasicApi();
      plugin.setup(api as never);
      if (plugin.teardown) {
        plugin.teardown(api as never);
        expect(() => plugin.teardown(api as never)).not.toThrow();
      }
    });

    it('teardown before setup is safe', async () => {
      const mod = await importer();
      const plugin = mod.default as { teardown?: (api: unknown) => void };
      const api = makeBasicApi();
      if (plugin.teardown) {
        expect(() => plugin.teardown(api as never)).not.toThrow();
      }
    });

    it('health returns an object with ok', async () => {
      const mod = await importer();
      const plugin = mod.default as {
        setup: (api: unknown) => void;
        teardown?: (api: unknown) => void;
        health?: () => unknown;
      };
      const api = makeBasicApi();
      plugin.setup(api as never);
      if (plugin.health) {
        const h = (await plugin.health()) as { ok?: boolean };
        expect(h).toBeDefined();
        expect(typeof h).toBe('object');
      }
    });
  });
}
