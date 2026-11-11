/** Metadata that can be consumed without importing plugin implementations. */
export interface OfficialPluginManifestEntry {
  name: string;
  exportName: string;
  packageSubpath: string;
  sourcePath: string;
  importSpecifier: string;
  audit: {
    risk: 'low' | 'medium' | 'high';
    defaultState: 'active' | 'inactive';
    canDisable: true;
  };
}

const OFFICIAL_PLUGIN_NAMES = [
  'agent-handoff',
  'cost-tracker',
  'file-watcher',
  'git-autocommit',
  'auto-doc',
  'shell-check',
  'template-engine',
  'semver-bump',
  'secret-scanner',
  'token-budget',
  'lint-gate',
  'branch-guard',
  'diff-summary',
  'commit-validator',
  'format-on-save',
  'test-runner-gate',
  'import-organizer',
  'todo-listener',
  'session-recap',
  'spec-linker',
  'loop-breaker',
  'gitignore-guard',
  'path-guard',
  'process-guard',
  'context-pins',
  'checkpoint',
  'error-lens',
  'dep-guard',
  'config-validator',
  'notify-hub',
  'changelog-writer',
  'injection-shield',
  'prompt-firewall',
  'llm-cache',
  'model-router',
  'pr-drafter',
  'auto-escalate',
  'test-coverage-gate',
  'type-gate',
  'token-throttle',
  'plugin-stack-observer',
  'dependency-vulnerability-gate',
  'migration-planner',
  'auto-i18n-extractor',
  'doc-sync-guard',
  'api-compatibility-gate',
  'performance-regression-gate',
  'test-flake-detector',
  'schema-evolution-guard',
  'license-audit-gate',
  'accessibility-auditor',
  'security-hotspot-scanner',
  'duplicate-code-detector',
  'test-generator',
  'release-notes-generator',
  'workspace-health',
  'test-impact-analyzer',
  'ci-failure-triage',
  'env-contract-guard',
  'dependency-drift-detector',
  'release-readiness',
  'bundle-budget-guard',
  'public-api-auditor',
  'lockfile-consistency-guard',
  'change-risk-classifier',
  'bug-reproducer',
  'verification-ledger',
  'acceptance-verifier',
  'runtime-trace-explorer',
  'workspace-recipe-runner',
  'architecture-boundary-checker',
  'monorepo-change-planner',
  'config-migration-assistant',
  'feature-flag-lifecycle',
  'generated-artifact-tracker',
  'api-consumer-replay',
  'migration-rehearsal',
  'failure-injection-lab',
  'concurrency-scenario-tester',
  'resource-lifecycle-inspector',
  'visual-regression-reviewer',
  'responsive-journey-tester',
  'localization-completeness',
  'executable-documentation',
  'dependency-upgrade-sandbox',
  'developer-environment-doctor',
  'service-topology-inspector',
  'decision-journal',
  'plugin-workbench',
  'adversary-mode',
] as const;

const MEDIUM_RISK_PLUGINS = new Set<string>([
  'api-consumer-replay',
  'concurrency-scenario-tester',
  'service-topology-inspector',
  'decision-journal',
  'agent-handoff',
  'auto-doc',
  'accessibility-auditor',
  'file-watcher',
  'template-engine',
  'token-budget',
  'lint-gate',
  'commit-validator',
  'format-on-save',
  'test-runner-gate',
  'import-organizer',
  'path-guard',
  'checkpoint',
  'dep-guard',
  'api-compatibility-gate',
  'notify-hub',
  'llm-cache',
  'model-router',
  'auto-escalate',
  'token-throttle',
  'test-coverage-gate',
  'test-flake-detector',
  'performance-regression-gate',
  'type-gate',
  'workspace-health',
  'test-impact-analyzer',
  'ci-failure-triage',
  'env-contract-guard',
  'dependency-drift-detector',
  'release-readiness',
  'bundle-budget-guard',
  'public-api-auditor',
  'lockfile-consistency-guard',
  'change-risk-classifier',
  'adversary-mode',
]);

const HIGH_RISK_PLUGINS = new Set<string>([
  'bug-reproducer',
  'verification-ledger',
  'acceptance-verifier',
  'workspace-recipe-runner',
  'migration-rehearsal',
  'failure-injection-lab',
  'resource-lifecycle-inspector',
  'responsive-journey-tester',
  'executable-documentation',
  'dependency-upgrade-sandbox',
  'developer-environment-doctor',
  'plugin-workbench',
  'git-autocommit',
  'semver-bump',
  'secret-scanner',
  'branch-guard',
  'process-guard',
  'dependency-vulnerability-gate',
  'license-audit-gate',
  'security-hotspot-scanner',
  'schema-evolution-guard',
  'prompt-firewall',
]);

/**
 * Plugins that boot without the user asking for them.
 *
 * The bar is deliberately high, because every entry here is paid for on
 * EVERY session by EVERY user: a default-active plugin adds its tools to
 * the wire description of every prompt, and a hook it registers runs on
 * every matching tool call — foreground PostToolUse hooks are awaited
 * before the turn continues (`core/hooks/runner.ts`). A plugin earns a
 * place only if it is a bounded safety check whose absence is a real
 * hazard, or a passive diagnostic that costs approximately nothing.
 *
 * Eight plugins were removed from this set in the 2026-09-17 review:
 *
 *  - `cost-tracker` — `setup()` awaits `modelsRegistry.load()`, and the
 *    loader runs setups SERIALLY (`core/plugin/loader.ts`), so a cold
 *    models.dev fetch stalled every later plugin behind it.
 *  - `token-budget` — ships `limit: 0`, which enforces nothing; it only
 *    re-counts what cost-tracker already counts.
 *  - `loop-breaker` — its own `enabled` defaulted to false, so three
 *    wildcard hooks were registered and returned on their first line.
 *    The internal switch now defaults ON, which is what makes opting in
 *    here meaningful; see `plugin-enable-double-gate`.
 *  - `process-guard` — observability only. Kill commands are actually
 *    refused by `tools/src/bash-kill-guard.ts` and `exec-kill-guard.ts`,
 *    which run whether or not this plugin is loaded.
 *  - `diff-summary`, `config-validator` — useful, but they spawn git /
 *    read and parse the written file on every write. Opt-in.
 *  - `knowledge-graph`, `todo-tracker` — 11 tools between them on every
 *    prompt, for state only some projects keep. Both were then deleted
 *    from the catalog outright in the follow-up review: the built-in
 *    memory tools and `todo` + `kanban` already own this ground.
 *
 * What stayed: the bounded safety checks (`secret-scanner`,
 * `injection-shield`, `dep-guard`, and `adversary-mode` — which stays
 * zero-LLM-cost/dormant until an `adversary.md` file exists), plus two
 * passive, near-free diagnostics (`error-lens`, `context-pins`).
 */
const DEFAULT_ACTIVE_PLUGINS = new Set<string>([
  'secret-scanner',
  'context-pins',
  'error-lens',
  'dep-guard',
  'injection-shield',
  'adversary-mode',
]);

function auditRisk(name: string): 'low' | 'medium' | 'high' {
  if (HIGH_RISK_PLUGINS.has(name)) return 'high';
  if (MEDIUM_RISK_PLUGINS.has(name)) return 'medium';
  return 'low';
}

function exportName(name: string): string {
  return `${name.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())}Plugin`;
}

export const OFFICIAL_PLUGIN_MANIFEST: readonly OfficialPluginManifestEntry[] = Object.freeze(
  OFFICIAL_PLUGIN_NAMES.map((name) =>
    Object.freeze({
      name,
      exportName: exportName(name),
      packageSubpath: `./${name}`,
      sourcePath: `./src/${name}`,
      importSpecifier: `@wrongstack/plugins/${name}`,
      audit: Object.freeze({
        risk: auditRisk(name),
        defaultState: DEFAULT_ACTIVE_PLUGINS.has(name) ? 'active' : 'inactive',
        canDisable: true as const,
      }),
    }),
  ),
);

export const OFFICIAL_PLUGIN_NAME_SET: ReadonlySet<string> = new Set(OFFICIAL_PLUGIN_NAMES);
