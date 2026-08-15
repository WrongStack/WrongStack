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
  'cron',
  'template-engine',
  'semver-bump',
  'secret-scanner',
  'todo-tracker',
  'token-budget',
  'lint-gate',
  'branch-guard',
  'diff-summary',
  'commit-validator',
  'format-on-save',
  'test-runner-gate',
  'import-organizer',
  'knowledge-graph',
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
  'semantic-search-indexer',
  'auto-i18n-extractor',
  'doc-sync-guard',
  'api-compatibility-gate',
  'performance-regression-gate',
  'test-flake-detector',
  'schema-evolution-guard',
  'license-audit-gate',
  'accessibility-auditor',
  'security-hotspot-scanner',
  'dead-code-detector',
  'duplicate-code-detector',
  'code-metrics',
  'refactor-suggester',
  'test-generator',
  'release-notes-generator',
  'smart-rename',
  'feature-flag-tracker',
  'interface-contract-guard',
] as const;

const MEDIUM_RISK_PLUGINS = new Set<string>([
  'agent-handoff',
  'auto-doc',
  'accessibility-auditor',
  'file-watcher',
  'cron',
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
  'interface-contract-guard',
  'smart-rename',
]);

const HIGH_RISK_PLUGINS = new Set<string>([
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

const DEFAULT_ACTIVE_PLUGINS = new Set<string>([
  'cost-tracker',
  'secret-scanner',
  'todo-tracker',
  'token-budget',
  'diff-summary',
  'knowledge-graph',
  'loop-breaker',
  'process-guard',
  'context-pins',
  'error-lens',
  'dep-guard',
  'config-validator',
  'injection-shield',
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
