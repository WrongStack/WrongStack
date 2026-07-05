/**
 * @wrongstack/plugins — Official WrongStack Plugin Suite
 *
 * Exported plugins (36 total; 1–31 use PreToolUse/PostToolUse/Stop or
 * tools, 32–36 are deep-hook plugins that register a full AgentExtension
 * — wrapProviderRunner / onError — wrapping the provider call itself):
 *  1. auto-doc         — Auto-generates JSDoc/TSDoc (dryRun for preview)
 *  2. git-autocommit  — AI-powered commit messages (git_autocommit/status_summary removed)
 *  3. shell-check     — Runs shellcheck on files or directories (merged)
 *  4. cost-tracker    — Tracks LLM token usage and estimated cost per session
 *  5. file-watcher    — Watches project files and emits events on changes
 *  6. cron            — Schedules recurring tasks via extension hooks
 *  7. template-engine — Expands file templates with variable substitution
 *  8. semver-bump     — Conventional-commit-driven semver version bumps
 *  9. secret-scanner  — Pre+post-tool hooks that block, redact, or warn
 *                        about plaintext credentials flowing into/out of tools
 * 10. todo-tracker    — Persistent, project-scoped todo backlog that
 *                        survives across sessions
 * 11. token-budget    — Enforces a per-session token budget — warns at a
 *                        threshold and stops the agent loop when the limit is hit
 * 12. lint-gate       — Pre-tool hook that runs biome/eslint on would-be
 *                        file content before write or edit commits it
 * 13. branch-guard    — Pre-tool hook that blocks commits, pushes, and
 *                        merges to protected branches (default: main, master)
 * 14. diff-summary    — Post-tool hook that injects a compact git diff
 *                        into the LLM context after every write or edit
 * 15. commit-validator — Pre-tool hook that validates conventional-commit
 *                        format before git_autocommit or bash git commit runs
 * 16. format-on-save   — Post-tool hook that runs biome format --write
 *                        on the file after every write or edit
 * 17. test-runner-gate — Post-tool hook that runs the relevant test
 *                        file after every write or edit to a source file
 * 18. import-organizer — Post-tool hook that runs biome check --write --unsafe
 *                        on the file after write or edit, re-sorting imports
 *                        and applying safe fixes (falls back to eslint --fix)
 * 19. todo-listener   — Post-tool hook on `todo` that broadcasts the new list
 *                        to the project mailbox (api.mailbox.send) so other
 *                        agents can see what this one is working on
 * 20. session-recap   — Stop hook that posts a one-page session summary
 *                        (tokens, tool calls, commits, transcript tail) to
 *                        the project mailbox when the agent loop ends
 * 21. spec-linker     — Post-tool hook on write/edit that scans markdown
 *                        files for unlinked plugin references and surfaces
 *                        them to the LLM via additionalContext
 * 22. loop-breaker    — Pre-tool hook that detects runaway tool-call loops
 *                        (identical repeats + A-B-A-B oscillation), warns
 *                        the model, then blocks
 * 23. path-guard      — Pre-tool hook that blocks writes/edits/destructive
 *                        shell commands touching protected paths (lockfiles,
 *                        .env, .git, migrations)
 * 24. context-pins    — pin_add/pin_remove/pin_list tools + system prompt
 *                        contributor: pinned facts survive compaction and
 *                        persist across sessions
 * 25. checkpoint      — In-session file snapshots: auto-captures content
 *                        before write/edit; checkpoint_restore rolls any
 *                        file back to a pre-edit state
 * 26. error-lens      — Post-tool hook that distills failed command output
 *                        into a compact digest (error line + project stack
 *                        frames) and flags repeated failures
 * 27. dep-guard       — Pre-tool hook that supervises dependency installs:
 *                        deny list, typosquat lookalike warnings, unpinned
 *                        version warnings
 * 28. config-validator — Post-tool hook that validates JSON/JSONC/YAML/TOML
 *                        files right after write/edit and reports syntax
 *                        problems in the same turn
 * 29. notify-hub      — POSTs session events (stop, tool errors, budget
 *                        thresholds) and ad-hoc notify_send messages to a
 *                        configurable webhook
 * 30. changelog-writer — Collects session work (commits, edits, manual
 *                        notes) and writes Keep-a-Changelog entries under
 *                        [Unreleased] on demand
 * 31. injection-shield — Post-tool hook that scans tool output for
 *                        prompt-injection patterns and warns the model that
 *                        content is data, not instructions
 * 32. llm-cache       — wrapProviderRunner: caches identical deterministic
 *                        provider requests and short-circuits the call on a hit
 * 33. model-router    — wrapProviderRunner: routes each call to a different
 *                        model by declarative size/tool rules (within the provider)
 * 34. prompt-firewall — wrapProviderRunner: detects/redacts/blocks credential
 *                        leaks on the provider wire (warn/redact/block)
 * 35. auto-escalate   — onError: retries with the next model in an escalation
 *                        ladder on transient provider errors
 * 36. token-throttle  — wrapProviderRunner: rolling-window tokens/min budget
 *                        that delays provider calls to stay under a rate limit
 *
 * Plugins 32–36 are OPT-IN (enabled:false by default) because they change
 * provider-call semantics.
 *
 * Removed (use the equivalent built-in tools instead — see
 * `DEPRECATED_PLUGIN_NAMES` in `packages/cli/src/wiring/plugins.ts`
 * for the loader-level migration warning):
 *  - web-search      → built-in `search` + `fetch`
 *  - json-path       → built-in `json` tool (action: query|validate|transform|merge)
 *
 * Usage in WrongStack config:
 * ```json
 * {
 *   "plugins": {
 *     "auto-doc": { "enabled": true },
 *     "git-autocommit": { "conventionalCommits": true }
 *   }
 * }
 * ```
 */

export { default as autoDocPlugin } from './auto-doc/index.js';
export { default as autoEscalatePlugin } from './auto-escalate/index.js';
export { default as branchGuardPlugin } from './branch-guard/index.js';
export { default as changelogWriterPlugin } from './changelog-writer/index.js';
export { default as checkpointPlugin } from './checkpoint/index.js';
export { default as commitValidatorPlugin } from './commit-validator/index.js';
export { default as configValidatorPlugin } from './config-validator/index.js';
export { default as contextPinsPlugin } from './context-pins/index.js';
export { default as costTrackerPlugin } from './cost-tracker/index.js';
export { default as cronPlugin } from './cron/index.js';
export { default as depGuardPlugin } from './dep-guard/index.js';
export { default as diffSummaryPlugin } from './diff-summary/index.js';
export { default as errorLensPlugin } from './error-lens/index.js';
export { default as fileWatcherPlugin } from './file-watcher/index.js';
export { default as formatOnSavePlugin } from './format-on-save/index.js';
export { default as gitAutocommitPlugin } from './git-autocommit/index.js';
export { default as importOrganizerPlugin } from './import-organizer/index.js';
export { default as injectionShieldPlugin } from './injection-shield/index.js';
export { default as lintGatePlugin } from './lint-gate/index.js';
export { default as llmCachePlugin } from './llm-cache/index.js';
export { default as loopBreakerPlugin } from './loop-breaker/index.js';
export { default as modelRouterPlugin } from './model-router/index.js';
export { default as notifyHubPlugin } from './notify-hub/index.js';
export { default as pathGuardPlugin } from './path-guard/index.js';
export { default as pluginStackObserverPlugin } from './plugin-stack-observer/index.js';
export { default as promptFirewallPlugin } from './prompt-firewall/index.js';
export { default as secretScannerPlugin } from './secret-scanner/index.js';
export { default as semverBumpPlugin } from './semver-bump/index.js';
export { default as sessionRecapPlugin } from './session-recap/index.js';
export { default as shellCheckPlugin } from './shell-check/index.js';
export { default as specLinkerPlugin } from './spec-linker/index.js';
export { default as templateEnginePlugin } from './template-engine/index.js';
export { default as testRunnerGatePlugin } from './test-runner-gate/index.js';
export { default as todoListenerPlugin } from './todo-listener/index.js';
export { default as todoTrackerPlugin } from './todo-tracker/index.js';
export { default as tokenBudgetPlugin } from './token-budget/index.js';
export { default as tokenThrottlePlugin } from './token-throttle/index.js';
