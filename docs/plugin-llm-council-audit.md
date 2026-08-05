# Plugin LLM and Council audit

Verified against the production plugin factories and source on 2026-08-05.
The runtime and audit catalogs contain the same 71 plugins: 64 official package
plugins and 7 host plugins.

## Classification

- 12 plugins can make a host-routed One Shot request.
- 2 of those 12 prefer Council for consequential analysis and fall back through
  Council -> One Shot -> deterministic behavior.
- 2 additional host plugins orchestrate subagents; they do not call One Shot or
  Council directly.
- The remaining 57 plugins are deterministic and make no model call.

`api.llm.complete()` is not a raw provider shortcut in the production CLI. It
uses the shared `OneShotOrchestrator`, live model-matrix routing, provider/model
health state, configured fallback profiles, cancellation, and bounded timeouts.
Minimal test or embedded hosts can retain the bounded direct-provider
compatibility path.

## Plugins that use One Shot or Council

| Plugin | Activation | Primary path | Model role | Failure behavior |
|---|---|---|---|---|
| `auto-doc` | `useLlm` / `use_llm` | One Shot | `document` | Deterministic documentation placeholders |
| `changelog-writer` | `polish` | One Shot | `document` | Original changelog block |
| `commit-validator` | `suggestFix` | One Shot | `reviewer` | Deterministic validation remains authoritative |
| `dep-guard` | `confirmTyposquatsWithLlm` | Council `risk-review` -> One Shot | `security-reviewer` fallback | Edit-distance warning remains; AI cannot promote it to a block |
| `error-lens` | `aiHints` | One Shot | `reviewer` | Deterministic error digest |
| `git-autocommit` | `generate` / `useLlm` | One Shot | `document` | Deterministic commit-message generation |
| `migration-planner` | `useLlm` / `use_llm` | Council `risk-review` -> One Shot | `planner` fallback | Changelog-derived or generic deterministic migration plan |
| `pr-drafter` | `aiSummary` | One Shot | `document` | Deterministic PR facts and sections |
| `release-notes-generator` | `useLlm` / `use_llm` | One Shot | `document` | Deterministic notes; invalid output is rejected |
| `session-recap` | `aiSummary` | One Shot | `document` | Deterministic session recap |
| `test-generator` | `useLlm` / `use_llm` | One Shot | `test` | Deterministic test skeleton |
| `wstack-prompts` | `/prompts extend` | One Shot | `prompt-refiner` | Saved prompt is preserved and the command reports failure |

## Subagent orchestration, not One Shot or Council

| Plugin | Behavior |
|---|---|
| `wstack-chimera` | Runs the Chimera multi-agent review workflow. |
| `wstack-auto-review` | Schedules bounded Chimera reviews after a quiet window. |

These are model-backed indirectly through the agent runtime, but must not be
reported as One Shot or Council consumers.

## Plugins with no model call

`wstack-sync`, `wstack-skills`, `@wrongstack/plug-lsp`, `telegram`,
`agent-handoff`, `cost-tracker`, `file-watcher`, `shell-check`, `cron`,
`template-engine`, `semver-bump`, `secret-scanner`, `todo-tracker`,
`token-budget`, `lint-gate`, `branch-guard`, `diff-summary`, `format-on-save`,
`test-runner-gate`, `import-organizer`, `knowledge-graph`, `todo-listener`,
`spec-linker`, `loop-breaker`, `path-guard`, `process-guard`, `context-pins`,
`checkpoint`, `config-validator`, `notify-hub`, `injection-shield`, `llm-cache`,
`model-router`, `prompt-firewall`, `auto-escalate`, `test-coverage-gate`,
`type-gate`, `token-throttle`, `plugin-stack-observer`,
`dependency-vulnerability-gate`, `semantic-search-indexer`,
`auto-i18n-extractor`, `doc-sync-guard`, `api-compatibility-gate`,
`performance-regression-gate`, `test-flake-detector`,
`schema-evolution-guard`, `license-audit-gate`, `accessibility-auditor`,
`security-hotspot-scanner`, `dead-code-detector`, `duplicate-code-detector`,
`code-metrics`, `refactor-suggester`, `smart-rename`, `feature-flag-tracker`, and
`interface-contract-guard`.

## Catalog corrections made during the audit

- Added the real host plugin `wstack-auto-review`.
- Removed stale host entries `wstack-git`, `wstack-observability`, and
  `wstack-plan`; those capabilities exist as host commands, not runtime plugin
  factories.
- Added an automated parity test between actual host factories and the audit
  catalog.
- Allowed default-inactive host plugins to be explicitly enabled through their
  documented `config.extensions[plugin].enabled` setting.
