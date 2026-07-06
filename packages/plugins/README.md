# @wrongstack/plugins

First-party plugin collection for [WrongStack](https://github.com/WrongStack/WrongStack).
Sixty-three focused, single-purpose plugins ship in this package. Core safety
plugins load automatically for every `wstack` session; provider-wire plugins
are opt-in because they can change model-call semantics.

## What this is

Each plugin is a self-contained ESM module under `src/<name>/` that
exports a default `Plugin` object. The host's plugin loader
(`@wrongstack/core/plugin/loader`) accepts, validates, and
`setup()`s them. Plugins register **tools** on the host's
`ToolRegistry` and may also register **hooks** (e.g.
`secret-scanner` registers `PreToolUse` + `PostToolUse` hooks).

Plugins are loaded lazily by `packages/cli/src/wiring/plugins.ts`
under the `BUILTIN_PLUGIN_FACTORIES` array. To opt out, add
`{ name: '<plugin>', enabled: false }` to `config.plugins`.

## Plugin catalog

| # | Plugin | Tools | Hooks | Notes |
|---|---|---|---|---|
| 1 | [`auto-doc`](./src/auto-doc) | `auto_doc` | — | JSDoc/TSDoc generation with `dry_run` preview |
| 2 | [`git-autocommit`](./src/git-autocommit) | `git_autocommit` | — | AI-written conventional commits; warns on simultaneous worktrees |
| 3 | [`shell-check`](./src/shell-check) | `shellcheck` | — | Runs `shellcheck` on files or directories |
| 4 | [`cost-tracker`](./src/cost-tracker) | `cost_summary`, `cost_reset`, `cost_export` | — | Tracks per-model token usage and estimated USD cost |
| 5 | [`file-watcher`](./src/file-watcher) | `watch_start`, `watch_stop`, `watch_list` | — | Watches project files and emits debounced change events |
| 6 | [`cron`](./src/cron) | `cron_schedule`, `cron_list`, `cron_cancel` | — | Schedules recurring in-session actions |
| 7 | [`template-engine`](./src/template-engine) | `template_expand`, `template_render`, `template_create`, `template_list` | — | Expands templates with variables, conditionals, and loops |
| 8 | [`semver-bump`](./src/semver-bump) | `semver_bump`, `semver_current`, `semver_changelog` | — | Infers version bumps and changelogs from conventional commits |
| 9 | [`secret-scanner`](./src/secret-scanner) | `secret_scanner_status`, `secret_scanner_test` | `PreToolUse` + `PostToolUse` | Blocks/redacts input secrets and warns on output leaks |
| 10 | [`todo-tracker`](./src/todo-tracker) | `todo_tracker_*` | — | Persistent project-scoped backlog that survives sessions |
| 11 | [`token-budget`](./src/token-budget) | `token_budget_status` | `Stop` + `PostToolUse` | Tracks token use and can warn/stop at configured limits |
| 12 | [`lint-gate`](./src/lint-gate) | `lint_gate_status` | `PreToolUse` | Lints would-be write/edit content before mutation |
| 13 | [`branch-guard`](./src/branch-guard) | `branch_guard_status` | `PreToolUse` | Blocks or warns on commits, pushes, and merges on protected branches |
| 14 | [`diff-summary`](./src/diff-summary) | `diff_summary_status` | `PostToolUse` | Injects compact git diff context after write/edit |
| 15 | [`commit-validator`](./src/commit-validator) | `commit_validator_status` | `PreToolUse` | Validates conventional-commit messages |
| 16 | [`format-on-save`](./src/format-on-save) | `format_on_save_status` | `PostToolUse` | Runs formatter after write/edit |
| 17 | [`test-runner-gate`](./src/test-runner-gate) | `test_gate_status` | `PostToolUse` | Runs relevant tests after source edits |
| 18 | [`import-organizer`](./src/import-organizer) | `import_organizer_status` | `PostToolUse` | Organizes imports and applies safe fixes after write/edit |
| 19 | [`todo-listener`](./src/todo-listener) | `todo_listener_status` | `PostToolUse` | Broadcasts todo status changes to the project mailbox |
| 20 | [`session-recap`](./src/session-recap) | `session_recap_status` | `Stop` | Posts a compact session recap to the project mailbox |
| 21 | [`spec-linker`](./src/spec-linker) | `spec_linker_status` | `PreToolUse` + `PostToolUse` | Detects unlinked plugin references in markdown docs |
| 22 | [`loop-breaker`](./src/loop-breaker) | `loop_breaker_status` | `PreToolUse` | Detects repeated tool-call loops and oscillations |
| 23 | [`path-guard`](./src/path-guard) | `path_guard_status` | `PreToolUse` | Guards protected paths from writes and destructive shell commands |
| 24 | [`context-pins`](./src/context-pins) | `pin_add`, `pin_remove`, `pin_list` | System prompt contributor | Persists short pinned facts across compaction/session boundaries |
| 25 | [`checkpoint`](./src/checkpoint) | `checkpoint_create`, `checkpoint_list`, `checkpoint_restore` | `PreToolUse` | Captures file snapshots before risky edits and restores them on demand |
| 26 | [`error-lens`](./src/error-lens) | `error_lens_history` | `PostToolUse` | Summarizes failed tool output and repeated failure patterns |
| 27 | [`dep-guard`](./src/dep-guard) | `dep_guard_status` | `PreToolUse` | Supervises dependency installs for deny-list and supply-chain warnings |
| 28 | [`config-validator`](./src/config-validator) | `config_validator_status` | `PostToolUse` | Validates edited JSON/JSONC/YAML/TOML config files |
| 29 | [`notify-hub`](./src/notify-hub) | `notify_send`, `notify_hub_status` | `Stop` + event subscriptions | Sends session/tool notifications to a configured webhook |
| 30 | [`changelog-writer`](./src/changelog-writer) | `changelog_add`, `changelog_preview`, `changelog_write` | — | Collects and writes Keep-a-Changelog entries |
| 31 | [`injection-shield`](./src/injection-shield) | `injection_shield_status` | `PostToolUse` | Warns when tool output contains prompt-injection patterns |
| 32 | [`llm-cache`](./src/llm-cache) | `llm_cache_status`, `llm_cache_clear` | Provider runner wrapper | Opt-in cache for deterministic provider requests |
| 33 | [`model-router`](./src/model-router) | `model_router_status` | Provider runner wrapper | Opt-in routing of provider calls by declarative rules |
| 34 | [`prompt-firewall`](./src/prompt-firewall) | `prompt_firewall_status` | Provider runner wrapper | Opt-in provider-wire prompt/secret scanning and redaction/blocking |
| 35 | [`auto-escalate`](./src/auto-escalate) | `auto_escalate_status` | `onError` extension | Opt-in retry/escalation ladder for transient provider errors |
| 36 | [`token-throttle`](./src/token-throttle) | `token_throttle_status` | Provider runner wrapper | Opt-in rolling-window token throttling for provider calls |
| 37 | [`type-gate`](./src/type-gate) | `type_gate_status` | `PostToolUse` | Runs `tsc --noEmit` after `write`/`edit` to catch type regressions |
| 38 | [`test-coverage-gate`](./src/test-coverage-gate) | `coverage_gate_status` | `PostToolUse` | Detects test-coverage regressions after source-file edits |
| 39 | [`pr-drafter`](./src/pr-drafter) | `pr_draft` | `Stop` + event subscriptions | Drafts a pull-request description from session commits/files/diff |
| 40 | [`agent-handoff`](./src/agent-handoff) | `handoff_note`, `handoff_status` | `subagent.done` event listener | Posts structured handoff notes when subagents finish |
| 41 | [`knowledge-graph`](./src/knowledge-graph) | `kg_add_fact`, `kg_query`, `kg_remove_fact`, `kg_status` | System prompt contributor | Persistent structured (subject, relation, object) project facts |
| 42 | [`dead-code-detector`](./src/dead-code-detector) | `dead_code_scan` | `PostToolUse` | Regex-based scan for exported identifiers that appear unused |
| 43 | [`dependency-vulnerability-gate`](./src/dependency-vulnerability-gate) | `dependency_audit_status` | `PostToolUse` | Runs `npm/pnpm audit` after installs and blocks on severe vulnerabilities |
| 44 | [`migration-planner`](./src/migration-planner) | `migration_plan`, `migration_status` | `PostToolUse` | Reads changelogs and produces version-migration checklists |
| 45 | [`semantic-search-indexer`](./src/semantic-search-indexer) | `semantic_search`, `semantic_index_status` | — | Lightweight keyword index over project source files |
| 46 | [`auto-i18n-extractor`](./src/auto-i18n-extractor) | `i18n_extract`, `i18n_status` | `PostToolUse` | Detects hardcoded user-facing strings and suggests i18n keys |
| 47 | [`doc-sync-guard`](./src/doc-sync-guard) | `doc_sync_status` | `PostToolUse` | Warns when README/docs edits omit recently changed source files |
| 48 | [`api-compatibility-gate`](./src/api-compatibility-gate) | `api_compat_status` | `PostToolUse` | Detects removed exports in entry-point files as breaking changes |
| 49 | [`performance-regression-gate`](./src/performance-regression-gate) | `perf_regression_status` | — | Compares benchmark results and reports regressions |
| 50 | [`test-flake-detector`](./src/test-flake-detector) | `flake_detect`, `flake_status` | — | Runs a test command N times to identify flaky tests |
| 51 | [`schema-evolution-guard`](./src/schema-evolution-guard) | `schema_evolution_status` | `PostToolUse` | Detects destructive patterns in DB/API schema files |
| 52 | [`license-audit-gate`](./src/license-audit-gate) | `license_audit_status` | `PostToolUse` | Audits newly added dependency licenses against an allowlist |
| 53 | [`accessibility-auditor`](./src/accessibility-auditor) | `a11y_audit`, `a11y_status` | `PostToolUse` | Audits UI files for missing alt, labels, button text, duplicate ids |
| 54 | [`security-hotspot-scanner`](./src/security-hotspot-scanner) | `security_hotspot_scan`, `security_hotspot_status` | `PostToolUse` | Scans source for security anti-patterns after writes/edits |
| 55 | [`duplicate-code-detector`](./src/duplicate-code-detector) | `detect_duplicate_code`, `duplicate_code_status` | `PostToolUse` | Detects duplicate/similar code blocks using normalized-line fingerprints |
| 56 | [`code-metrics`](./src/code-metrics) | `measure_code_metrics`, `metrics_status` | `PostToolUse` | Computes LOC, comment ratio, function count, and approximate cyclomatic complexity |
| 57 | [`refactor-suggester`](./src/refactor-suggester) | `suggest_refactors`, `refactor_status` | `PostToolUse` | Flags long functions, deep nesting, many parameters, magic numbers, console.log |
| 58 | [`test-generator`](./src/test-generator) | `generate_unit_tests` | — | Generates a unit-test skeleton from exported functions/classes |
| 59 | [`release-notes-generator`](./src/release-notes-generator) | `generate_release_notes` | — | Groups conventional commits into a release-notes markdown draft |
| 60 | [`smart-rename`](./src/smart-rename) | `smart_rename` | — | Whole-word symbol rename with preview and optional apply |
| 61 | [`feature-flag-tracker`](./src/feature-flag-tracker) | `scan_feature_flags`, `feature_flag_status` | `PostToolUse` | Scans source files for feature-flag usage and reports flag inventory |
| 62 | [`interface-contract-guard`](./src/interface-contract-guard) | `check_interface_contracts`, `interface_contract_status` | `PostToolUse` | Warns when TypeScript interfaces change or lack implementers |

### Removed plugins (use built-in tools instead)

| Removed | Replacement | Why |
|---|---|---|
| `web-search` (removed in `e03e39d1`) | Built-in `search` + `fetch` tools in `@wrongstack/tools` | The built-in tools have native caching, dedup, ranking, DNS-pinned SSRF protection, TurndownService markdown, binary-content rejection, and structured errors. |
| `json-path` (removed in `e03e39d1`) | Built-in `json` tool in `@wrongstack/tools` (action: `query` \| `validate` \| `transform` \| `merge`) | The built-in `json` tool already supports JMESPath queries, schema validation, transforms, and deep-merge via a single `action` parameter. |

If a user lists either name in `config.plugins`, the loader emits a
one-shot `log.warn` and skips loading. See
[`DEPRECATED_PLUGIN_NAMES`](../../cli/src/wiring/plugins.ts)
in `packages/cli/src/wiring/plugins.ts` for the canonical list and
migration hints.

## Per-plugin quick reference

### 1. `auto-doc` — JSDoc/TSDoc generation

**Tools**: `auto_doc` (mutating)

Generates JSDoc/TSDoc comments and either writes them to the file or
returns a preview. Pass `dry_run: true` to see what would change
without writing — the same tool, no separate preview tool.

```jsonc
// Generate doc comments for every export in src/agent.ts, preview only
auto_doc({ files: ["src/agent.ts"], style: "tsdoc", dry_run: true })
```

### 2. `git-autocommit` — AI commit messages

**Tools**: `git_autocommit` (mutating, `confirm` permission)

Stages the listed files (or all changed files when `files: []`) and
creates a commit with a conventional-commit message derived from the
diff. Warns when other worktrees are active (likely parallel agents
editing the same repo) so the user can verify the diff before commit.

```jsonc
git_autocommit({ type: "fix", scope: "session", message: "..." })
```

### 3. `shell-check` — bash script linting

**Tools**: `shellcheck` (mutating — writes the CSV report)

Two modes: pass `files: ['scripts/deploy.sh']` to lint specific files
or `directory: 'scripts', pattern: '*.sh'` to recursively scan.

### 4. `cost-tracker` — token + USD tracking

**Tools**: `cost_summary`, `cost_reset`, `cost_export`

Listens to the `provider.response` event, computes cost from the
models.dev-backed `api.modelsRegistry` (Layer 2 of the lookup chain),
with a bundled `PRICING` table as the baseline (Layer 3) and a
`pricingOverrides` config field as the top-priority escape hatch
(Layer 1). The `pricingOverrides` field is the user-facing tool for
correcting a specific model's price without waiting for a plugin
release. See the [`cost-tracker`](./src/cost-tracker) source for
the full lookup chain.

```jsonc
// Per-model override (USD per 1M tokens, lowercased model id)
{
  "extensions": {
    "cost-tracker": {
      "pricingOverrides": {
        "gpt-4o": { "input": 7, output: 21 },
        "anthropic-test-model": { "input": 4, output: 20 }
      }
    }
  }
}
```

### 5. `file-watcher` — filesystem events

**Tools**: `watch_start`, `watch_stop`, `watch_list`

Wires `node:fs.watch` listeners and stores the handles in module
scope. The CLI hooks these events to the per-project mailbox via
the `dep-watcher` bridge so dependency-manifest changes
(`package.json`, `go.mod`, etc.) trigger tech-stack audits.

### 6. `cron` — in-session recurring tasks

**Tools**: `cron_schedule`, `cron_list`, `cron_cancel`

Schedules timers with `api.extensions.register('beforeIteration', ...)`.
All timers are tracked in module-scope state and torn down on plugin
unload so a hot-reload cycle doesn't leak `setTimeout` handles
(audited 2026-06-03, see "H1 audit pattern" below).

### 7. `template-engine` — file templates

**Tools**: `template_expand`, `template_render`, `template_create`, `template_list`

Three template forms: `{{var}}` substitution, `{{#if var}}…{{/if}}`
conditionals, `{{#each items}}…{{/each}}` loops. The store is in-memory
and module-scoped (audited 2026-06-03).

### 8. `semver-bump` — conventional commits → version

**Tools**: `semver_bump`, `semver_current`, `semver_changelog`

Reads the git log since the last tag, infers the next version
(major/minor/patch) from the conventional-commit types, and can
tag the new commit. `changelog` generates a markdown changelog
between two refs.

### 9. `secret-scanner` — credential blocker + output leak detector

**Tools**: `secret_scanner_status`, `secret_scanner_test`
**Hooks**:
- `PreToolUse` with matcher `bash|write|edit` (configurable via `matcher`)
- `PostToolUse` with matcher `*` (configurable via `postToolUseMatcher`)

**PreToolUse** (prevention — before the tool runs):
Mirrors 21 simple patterns from `core/src/security/secret-scrubber.ts`
(LLM provider keys, GitHub PATs v1+v2, AWS, GCP, Slack, Stripe,
Twilio, Telegram, JWT, PEM private keys, HuggingFace/Replicate/
Perplexity/Groq, Bearer tokens, mongo/postgres/mysql/redis URIs).
Read-only tools (`read`, `fetch`) are excluded from PreToolUse by
default since secrets flowing IN to them are fine.

**PostToolUse** (detection — after the tool runs):
Scans tool OUTPUT for secrets that leaked through. Since the tool
has already run, the hook cannot block — instead it injects
`additionalContext` so the LLM knows not to echo, store, or commit
the leaked value.

Three modes (`config.extensions['secret-scanner'].mode`) for [`secret-scanner`](./src/secret-scanner):
- **`block` (default)**: returns `HookOutcome{ decision: 'block', reason }`
- **`redact`**: returns `HookOutcome{ decision: 'allow', modifiedInput, additionalContext }` with the offending strings replaced by `[REDACTED:type]`
- **`allow`**: only logs; never blocks

```jsonc
// Basic config
{
  "extensions": {
    "secret-scanner": {
      "mode": "block",
      "matcher": "bash|write|edit",
      "postToolUseMatcher": "*"
    }
  }
}
```

**Custom patterns** (`customPatterns`): Append your own credential
patterns alongside the 21 built-in ones. Each entry is a
`{ type, regex, description? }`. Invalid regex entries are silently
skipped.

```jsonc
{
  "extensions": {
    "secret-scanner": {
      "customPatterns": [
        {
          "type": "internal_api_key",
          "regex": "IAK-[A-F0-9]{40}",
          "description": "Internal API key format"
        },
        {
          "type": "custom_jwt",
          "regex": "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"
        },
        {
          "type": "vault_token",
          "regex": "hvs\\.[A-Za-z0-9_-]{90,}"
        }
      ]
    }
  }
}
```

Custom patterns are detected by all hooks (PreToolUse block/redact,
PostToolUse leak detection) and by the `secret_scanner_test` tool.
They are reset to base-only on teardown (H1 pattern).

The `high_entropy_env` pattern from the output scrubber is
intentionally omitted — too slow and too false-positive prone
for a synchronous pre-tool gate.

### 10. `todo-tracker` — persistent backlog

**Tools**: `todo_tracker_list`, `todo_tracker_add`, `todo_tracker_complete`, `todo_tracker_drop`, `todo_tracker_remove`, `todo_tracker_pull`, `todo_tracker_status`

Closes a gap that no existing tool fills: a **per-project backlog**
that survives across sessions. The built-in `todo` tool mutates
`ctx.todos` (session-scoped, auto-clears when all items complete);
`PlanFile` and `TaskFile` are also session-scoped. This plugin
writes a per-project JSON file with atomic write (temp + rename).

**Cross-session bridge**: `todo_tracker_pull` returns active items
for the LLM to re-register with the built-in `todo` tool (which
mutates `ctx.todos`). The plugin never touches `ctx.todos` directly
— that separation respects the existing session/tool boundary.

**Storage**: per-project JSON at the path provided by
`paths.projectDir` (via the host's wiring) or via the explicit
[`todo-tracker`](./src/todo-tracker) `filePath` config field.

```jsonc
// Explicit override (use when the host doesn't supply paths.projectDir)
{
  "extensions": {
    "todo-tracker": {
      "filePath": "/abs/path/to/todo-tracker.json"
    }
  }
}
```

### 11. `token-budget` — per-session token enforcement

**Tools**: `token_budget_status`
**Hooks**: `Stop` + `PostToolUse` (matcher `*`)

Complements `cost-tracker` (which tracks cost in USD) by enforcing a
**hard token budget**. When usage crosses `warnPercent`, a one-shot
`PostToolUse` injection tells the LLM to start wrapping up. When it
crosses `stopPercent`, the `Stop` hook blocks the agent loop.

```jsonc
{
  "extensions": {
    "token-budget": {
      "limit": 500000,       // hard token limit (prompt + completion)
      "warnPercent": 80,     // inject "wrap up" at this %
      "stopPercent": 100,    // trigger Stop at this %
      "model": ""            // "" = all models; or restrict to one
    }
  }
}
```

`limit: 0` (default) = tracking only (no enforcement). The
`token_budget_status` tool reports the exact consumed/remaining
breakdown.

### 12. `lint-gate` — pre-write lint enforcement

**Tools**: `lint_gate_status`
**Hooks**: `PreToolUse` (matcher `write|edit`)

Runs biome (or eslint) on the would-be file content **before** the
write or edit commits it. For `write`, the full content is linted
via a temp file. For `edit`, the current file is read, the
`old_string → new_string` replacement is applied in-memory, and the
result is linted.

```jsonc
{
  "extensions": {
    "lint-gate": {
      "linter": "auto",       // "biome" | "eslint" | "auto"
      "mode": "warn",         // "block" | "warn" | "fix"
      "severity": "error",    // "error" | "warning"
      "timeoutMs": 10000,     // linter process timeout
      "fixRules": []          // when mode=fix, limit auto-fix to these rules only
    }
  }
}
```

**Modes**:
- **`block`**: refuses the write/edit; LLM must fix lint errors first
- **`warn`** (default): injects lint errors as context; write proceeds
- **`fix`**: auto-runs `biome check --write` / `eslint --fix`, substitutes
  the fixed content via `modifiedInput` (`write` only; `edit` falls back
  to `warn`). Use `fixRules` to limit which rules are auto-fixed:

```jsonc
// Only auto-fix formatting and import types; leave noExplicitAny as warning
{
  "extensions": {
    "lint-gate": {
      "mode": "fix",
      "fixRules": ["format", "lint/style/useImportType"]
    }
  }
}
```

### 13. `branch-guard` — protected branch enforcement

**Tools**: `branch_guard_status`
**Hooks**: `PreToolUse` (matcher `bash|git_autocommit`)

Blocks `git commit`, `git push`, and `git merge` on protected branches
(default: `main`, `master`). Checks the current branch via
`git branch --show-current`. When the working tree is dirty, the
block reason includes a safe stash workflow:

```
git stash → git checkout -b feat/my-change → git stash pop → git commit ...
```

```jsonc
{
  "extensions": {
    "branch-guard": {
      "branches": ["main", "master", "release/*"],
      "mode": "block",         // "block" | "warn"
      "blockCommit": true,
      "blockPush": true,
      "blockMerge": true
    }
  }
}
```

Each operation type can be individually toggled. `git_autocommit`
tool calls are treated as commits.

### 14. `diff-summary` — post-write/edit diff injection

**Tools**: `diff_summary_status`
**Hooks**: `PostToolUse` (matcher `write|edit`)

After every `write` or `edit` completes, runs `git diff -- <path>`
and injects a capped unified diff into the LLM's context as
`additionalContext`. Gives the LLM immediate visibility into what its
change actually did to the file — confirming the edit applied correctly
and showing surrounding context.

```jsonc
{
  "extensions": {
    "diff-summary": {
      "maxLines": 50,       // cap diff context at N lines
      "showStat": true,     // include "+N -M" summary line
      "mode": "diff"        // "diff" | "stat" | "off"
    }
  }
}
```

**Modes**:
- **`diff`** (default): injects unified diff body (capped at `maxLines`) + `+N -M` header
- **`stat`**: injects only `+N -M` counts (no diff body)
- **`off`**: disabled entirely

For untracked/new files: uses `git diff --no-index /dev/null <path>`.
For non-git repos: silent fallback (no injection). Skips on tool errors.

### 15. `commit-validator` — conventional-commit enforcement

**Tools**: `commit_validator_status`
**Hooks**: `PreToolUse` (matcher `bash|git_autocommit`)

Parses the commit message from `git commit -m "..."` (bash) or the
`message` field (git_autocommit) and validates it against the
conventional-commit format:

```
<type>[(scope)][!]: <description>
```

**Checks**:
- Valid format (type + colon + subject)
- Type is in `allowedTypes` (if configured; empty = allow all standard + custom)
- Scope is present (if `requireScope: true`)
- Subject ≤ `maxSubjectLength` (default: 72)
- Subject does not end with a period

```jsonc
{
  "extensions": {
    "commit-validator": {
      "mode": "block",          // "block" | "warn"
      "requireScope": false,    // require (scope) in message
      "allowedTypes": [],       // empty = all; or ["feat", "fix", "docs"]
      "maxSubjectLength": 72
    }
  }
}
```

Standard types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, `revert`.

### 16. `format-on-save` — automatic biome formatting

**Tools**: `format_on_save_status`
**Hooks**: `PostToolUse` (matcher `write|edit`)

After every `write` or `edit` completes, runs
`biome format --write <path>` on the file on disk. Silently reformats —
no blocking, no warnings, just clean code. If the file changed
(formatting was applied), injects `additionalContext` so the LLM knows
the file was reformatted.

```jsonc
{
  "extensions": {
    "format-on-save": {
      "enabled": true,       // master switch
      "timeoutMs": 5000      // biome process timeout
    }
  }
}
```

Biome detection runs once at setup(). If biome is not installed, the
hook is a silent no-op. Works alongside [`lint-gate`](./src/lint-gate)
(which lints BEFORE the write) and [`diff-summary`](./src/diff-summary)
(which shows the diff AFTER) — together they form a complete write
pipeline: lint → write → format → diff.

### 17. `test-runner-gate` — automatic test execution

**Tools**: `test_gate_status`
**Hooks**: `PostToolUse` (matcher `write|edit`)

After every `write` or `edit` to a source file, maps the source path
to its test file (using configurable patterns), runs
`vitest run <test-file> --reporter=json`, and injects the result.
On failure, injects failure details (test name + error, up to 5) so
the LLM knows immediately what broke.

```jsonc
{
  "extensions": {
    "test-runner-gate": {
      "enabled": true,
      "command": "npx vitest run",
      "timeoutMs": 30000,
      "testFilePatterns": [
        "tests/{name}.test.ts",
        "src/{name}.test.ts",
        "tests/{name}-exec.test.ts"
      ],
      "injectOnPass": false
    }
  }
}
```

Patterns use `{name}` (basename), `{path}` (path-no-ext), `{dir}` (dirname).
Skips test files themselves, tool errors, and missing test files (silent).

### 18 — `import-organizer`

**Tools**: `import_organizer_status`
**Hooks**: `PostToolUse` (matcher `write|edit`)

After every `write` or `edit`, runs `biome check --write --unsafe`
(or `eslint --fix` if biome is not installed) on the just-saved file.
The `--unsafe` flag enables auto-organizing imports: re-sorts them
alphabetically within import groups, merges duplicate imports from
the same module, and removes unused ones. Other safe fixes (formatting,
style) are applied alongside.

The hook runs **after** the tool completes (PostToolUse) and reads the
file from disk — so `write` tool's `content` parameter and `edit` tool's
post-edit disk state are both handled correctly. If the file no longer
exists at hook time (e.g. immediately deleted), the hook silently skips.

The hook is **idempotent**: running biome twice on the same file produces
the same result. Lint issues that biome cannot auto-fix are reported in
`additionalContext` so the LLM knows to clean them up manually.

```jsonc
{
  "extensions": {
    "import-organizer": {
      "enabled": true,
      "command": "npx @biomejs/biome check --write --unsafe",
      "fallbackCommand": "npx eslint --fix",
      "timeoutMs": 10000
    }
  }
}
```

Use the `--unsafe` flag with care: it enables rules that can change
runtime behavior (e.g. `useImportType` may force `import type` for
type-only imports, which is a no-op at runtime but can break tooling
that introspects import statements). If you prefer the safe-only mode,
omit `--unsafe`.

### 19 — `todo-listener`

**Tools**: `todo_listener_status`
**Hooks**: `PostToolUse` (matcher `todo`)

When the built-in `todo` tool is called, broadcasts a structured
status update to the project mailbox so other agents (terminals,
WebUIs, shadow agents) can see what this agent is working on in
real time.

```jsonc
{
  "extensions": {
    "todo-listener": {
      "enabled": true,
      "subjectPrefix": "todo: ",
      "broadcastOnChange": true,
      "cooldownMs": 5000
    }
  }
}
```

**Payload shape** (mailbox body, JSON):
```json
{
  "count": 4,
  "inProgress": { "id": "auth-flow", "content": "implement OAuth callback" },
  "pending": 2,
  "completed": 1,
  "items": [
    { "id": "auth-flow", "status": "in_progress", "content": "..." }
  ]
}
```

**Dedup + rate limiting**:
- `broadcastOnChange: true` (default) — identical consecutive payloads
  (FNV-1a hash over `id|status|content`) are suppressed. Re-issuing
  the same list doesn't spam the inbox.
- `cooldownMs: 5000` (default) — minimum interval between two
  consecutive broadcasts. Prevents the agent loop from flooding the
  mailbox on every iteration.

**Host requirements**:
- Requires `api.mailbox` (added in this commit) on the host's
  `PluginAPI`. Minimal hosts (tests, the LSP server, the standalone
  TUI without a coordinator) don't construct a mailbox — the hook
  logs a one-shot warning and silently no-ops.
- Subject is truncated to 200 chars to keep the inbox readable.

### 20 — `session-recap`

**Tools**: `session_recap_status`
**Hooks**: `Stop`

When the agent loop ends, the hook posts a one-page session summary
to the project mailbox. Other agents (terminals, WebUIs, shadow
agents) can read the recap stream to see what the previous session
finished — useful for end-of-day handoff and audit.

The plugin accumulates lightweight metrics from the EventBus during
the session:

- `provider.response` events → tokens per model
- `tool.*` events → tool-call counts (top-5 reported)
- `tool.result` events → commit count (via `git_autocommit` success)
- First/last activity timestamp → wall-clock duration

```jsonc
{
  "extensions": {
    "session-recap": {
      "enabled": true,
      "subjectPrefix": "session recap: ",
      "includeTranscriptTail": 3,
      "maxBodyChars": 8000
    }
  }
}
```

**Recap payload** (mailbox body, JSON):
```json
{
  "session": {
    "id": "sess-42",
    "cwd": "/home/user/proj",
    "startedAt": "2026-06-30T10:00:00Z",
    "endedAt": "2026-06-30T10:32:18Z",
    "duration": "32m18s"
  },
  "tokens": {
    "total": { "input": 12345, "output": 6789 },
    "perModel": [
      { "model": "gpt-4o", "input": 8000, "output": 5000, "invocations": 12 }
    ]
  },
  "tools": {
    "totalCalls": 47,
    "uniqueTools": 8,
    "top": [["read", 18], ["bash", 12], ["edit", 9]]
  },
  "commits": 2,
  "transcriptTail": [
    { "type": "user", "ts": "...", "preview": "last user prompt..." }
  ]
}
```

**Transcript tail**: by default the recap includes the last 3 events
from `api.session.transcriptPath` (the JSONL session log) for
context. Increase `includeTranscriptTail` for more history.

**Host requirements**:
- `api.mailbox` — same as `todo-listener`. Without it, the hook
  logs a one-shot warn and no-ops.
- `api.session.transcriptPath` — when missing the transcript tail
  is empty but the metrics summary still publishes.

### 21 — `spec-linker`

**Tools**: `spec_linker_status`
**Hooks**: `PostToolUse` (`write|edit`) + `PreToolUse` (`write`, when `autoFix: true`)

Two hooks working together:

**PostToolUse** (always active when the plugin is enabled):
scans markdown files for *unlinked* references to one of the 62
known plugins and surfaces them to the LLM via
`additionalContext`. The plugin does NOT modify the file — it
only injects a low-noise context block listing the unlinked
references and their canonical paths so the LLM can fix the file
in a follow-up edit.

**PreToolUse** (only when `autoFix: true`): scans the would-be
content of a `write` call and returns a `modifiedInput.content`
where each unlinked plugin reference is wrapped in a markdown
link. The tool executor then writes the fixed content instead of
the original. The fix preserves the original casing
(`Secret-Scanner` becomes `[Secret-Scanner](./src/secret-scanner)`)
and leaves markdown-link / inline-code references untouched.

**Why `write` only and not `edit`**: the `edit` tool's input is
`{ path, old_string, new_string }` — `new_string` is a small
patch, not the whole file. Auto-fixing `edit` cleanly would
require re-deriving the new `old_string` after substitution
(a hard string-diff problem), so `edit` stays read-only and
the PostToolUse context tells the LLM what to fix.

**Detection rules** (both hooks):
- Source matches `config.fileGlobs` (default: `**/*.md`, `**/*.mdx`)
- The reference matches one of the 62 known plugin names
  (case-insensitive)
- It is NOT already wrapped in a markdown link `[name](...)` or
  inline code `` `name` ``
- It is NOT a hyphenated/dotted continuation
  (`secret-scanner-config.json` does not match `secret-scanner`)

```jsonc
{
  "extensions": {
    "spec-linker": {
      "enabled": true,
      "fileGlobs": ["**/*.md", "**/*.mdx"],
      "maxReferences": 8,
      "autoFix": false   // set true to enable PreToolUse auto-link
    }
  }
}
```

**Injected context** (sample, when 2 unlinked references are found):
```
🔗 spec-linker: 2 unlinked plugin reference(s) in 'docs/feature-matrix.md'.
Consider wrapping them in markdown links to keep the docs navigable:
- `secret-scanner` → `[secret-scanner](./src/secret-scanner)`
- `token-budget` → `[token-budget](./src/token-budget)`
```

**Why read-only by default**: the file might be referenced
elsewhere or under review. Surfacing a suggestion lets the
LLM (or the user) decide whether to fix it, instead of
silently rewriting the file on every save. Opt into `autoFix`
once you're confident in the rewrite.

### 22 — `loop-breaker`

**Tools**: `loop_breaker_status`
**Hooks**: `PreToolUse`

Detects repeated tool calls before they execute. It tracks exact-repeat
streaks and A-B-A-B oscillations, then either blocks the call or injects a
warning depending on `mode`.

```jsonc
{
  "extensions": {
    "loop-breaker": {
      "enabled": true,
      "mode": "block",        // "block" | "warn"
      "repeatThreshold": 3,
      "oscillationThreshold": 2
    }
  }
}
```

### 23 — `path-guard`

**Tools**: `path_guard_status`
**Hooks**: `PreToolUse`

Protects sensitive paths from accidental writes/edits and destructive shell
commands. Defaults cover lockfiles, `.env`, `.git`, and migration-like paths;
use `mode: "warn"` for advisory-only enforcement.

```jsonc
{
  "extensions": {
    "path-guard": {
      "enabled": true,
      "mode": "block",
      "protected": [".env*", ".git/**", "**/migrations/**"]
    }
  }
}
```

### 24 — `context-pins`

**Tools**: `pin_add`, `pin_remove`, `pin_list`
**Hooks**: system prompt contributor

Stores short durable facts and injects them into the system prompt so they
survive context compaction. When the host supplies a project directory, pins
persist to a per-project JSON file; otherwise the plugin falls back to
in-memory state.

```jsonc
pin_add({ label: "api", text: "Use the v2 billing endpoint for invoices." })
```

### 25 — `checkpoint`

**Tools**: `checkpoint_create`, `checkpoint_list`, `checkpoint_restore`
**Hooks**: `PreToolUse`

Captures file snapshots before risky write/edit operations and lets the agent
restore a snapshot later. Restore never deletes files that did not exist at
capture time; it reports them instead.

```jsonc
checkpoint_create({ paths: ["src/service.ts"], label: "before refactor" })
```

### 26 — `error-lens`

**Tools**: `error_lens_history`
**Hooks**: `PostToolUse`

Distills failed command/tool output into compact diagnostics: likely error
line, source frames, repeat count, and a capped history for follow-up
inspection.

```jsonc
{
  "extensions": {
    "error-lens": { "enabled": true, "maxFrames": 5, "historyLimit": 10 }
  }
}
```

### 27 — `dep-guard`

**Tools**: `dep_guard_status`
**Hooks**: `PreToolUse`

Supervises dependency installs before they run. It can block deny-listed
packages, warn on typosquat lookalikes, and flag unpinned versions or risky
install sources.

```jsonc
{
  "extensions": {
    "dep-guard": {
      "enabled": true,
      "mode": "block",
      "deny": ["event-stream"],
      "warnUnpinned": true
    }
  }
}
```

### 28 — `config-validator`

**Tools**: `config_validator_status`
**Hooks**: `PostToolUse`

Validates edited config files immediately after write/edit. Supported formats
include JSON, JSONC, YAML, and TOML-like files depending on extension.

```jsonc
{
  "extensions": {
    "config-validator": {
      "enabled": true,
      "extensions": [".json", ".jsonc", ".yaml", ".yml", ".toml"]
    }
  }
}
```

### 29 — `notify-hub`

**Tools**: `notify_send`, `notify_hub_status`
**Hooks**: `Stop` + event subscriptions

Sends compact JSON notifications to a configured webhook for session stops,
tool errors, budget threshold events, and manual `notify_send` calls. Empty
`webhookUrl` means the plugin idles.

```jsonc
{
  "extensions": {
    "notify-hub": {
      "webhookUrl": "https://hooks.example.test/wrongstack",
      "events": ["session.stop", "tool.error"],
      "timeoutMs": 5000
    }
  }
}
```

### 30 — `changelog-writer`

**Tools**: `changelog_add`, `changelog_preview`, `changelog_write`

Collects pending Keep-a-Changelog entries during a session and writes them
under `## [Unreleased]`. It can also collect conventional-commit subjects and
map them to changelog sections.

```jsonc
changelog_add({ section: "Fixed", text: "Prevent template path traversal." })
```

### 31 — `injection-shield`

**Tools**: `injection_shield_status`
**Hooks**: `PostToolUse`

Scans tool output for prompt-injection patterns such as attempts to override
instructions, exfiltrate secrets, or treat retrieved content as higher-priority
commands. It warns via additional context; it does not modify tool output.

```jsonc
{
  "extensions": {
    "injection-shield": { "enabled": true, "tools": "*", "maxFindings": 5 }
  }
}
```

### 32 — `llm-cache`

**Tools**: `llm_cache_status`, `llm_cache_clear`
**Hooks**: provider runner wrapper (opt-in)

Caches identical deterministic provider requests and short-circuits the
provider call on a hit. It is disabled by default because caching changes
provider-call semantics; sampled/high-temperature calls are intentionally not
cached.

```jsonc
{
  "extensions": {
    "llm-cache": { "enabled": true, "maxEntries": 256, "ttlMs": 300000 }
  }
}
```

### 33 — `model-router`

**Tools**: `model_router_status`
**Hooks**: provider runner wrapper (opt-in)

Routes provider calls to alternate models based on declarative rules such as
input size, tool usage, or dry-run mode. Disabled by default because it changes
which model serves a turn.

```jsonc
{
  "extensions": {
    "model-router": {
      "enabled": true,
      "dryRun": false,
      "rules": []
    }
  }
}
```

### 34 — `prompt-firewall`

**Tools**: `prompt_firewall_status`
**Hooks**: provider runner wrapper (opt-in)

Scans provider requests and, optionally, responses for credential leaks and
prompt-risk patterns. Modes are `warn`, `redact`, and `block`; the plugin is
disabled by default because redact/block can alter or stop provider calls.

```jsonc
{
  "extensions": {
    "prompt-firewall": { "enabled": true, "mode": "redact", "scanResponse": true }
  }
}
```

### 35 — `auto-escalate`

**Tools**: `auto_escalate_status`
**Hooks**: `onError` extension (opt-in)

Retries transient provider failures with the next model in a configured
escalation ladder. Disabled by default because it changes error-recovery
behavior and can increase cost.

```jsonc
{
  "extensions": {
    "auto-escalate": {
      "enabled": true,
      "escalation": ["gpt-5-mini", "gpt-5.5"]
    }
  }
}
```

### 36 — `token-throttle`

**Tools**: `token_throttle_status`
**Hooks**: provider runner wrapper (opt-in)

Applies a rolling-window token/minute budget to provider calls. When the next
request would exceed the configured rate, the wrapper delays the call instead
of failing it.

```jsonc
{
  "extensions": {
    "token-throttle": {
      "enabled": true,
      "tokensPerMinute": 120000,
      "maxDelayMs": 30000
    }
  }
}
```

## Configuration patterns

There are two surfaces for plugin configuration:

1. **Loading** — `config.plugins` controls which plugins load.
   ```jsonc
   {
     "plugins": [
       { "name": "auto-doc", "enabled": true },
       { "name": "git-autocommit", "options": { "conventionalCommits": true } }
     ]
   }
   ```
2. **Options** — `config.extensions["<plugin-name>"]` stores each
   plugin's runtime options. The plugin's `configSchema` validates
   this section before `setup()` runs.

```jsonc
{
  "plugins": {
    "auto-doc": { "enabled": true },
    "git-autocommit": { "conventionalCommits": true },
    "secret-scanner": { "mode": "block", "matcher": "bash|write|edit" }
  }
}
```

To disable a single built-in without removing its config:
```jsonc
{ "plugins": [{ "name": "secret-scanner", "enabled": false }] }
```

## H1 audit pattern

All built-in plugins that hold module-scope state follow a strict lifecycle
to survive hot-reload without leaking resources. This includes file-backed
stores, timers, watchers, hook counters, in-memory caches, provider wrappers,
and notification state. The pattern was formalized after a
2026-06-03 audit (the "H1 audit") found that several plugins kept
their state inside the `setup()` closure, where the loader's
`WeakMap<Plugin, PluginAPI>` could not reach it during teardown —
meaning timers, filesystem handles, and in-memory caches leaked
across plugin reloads.

The H1 pattern:

1. **State at module scope, not in setup() closure.** Anything the
   `teardown` needs to clean up lives in a `const state = {…}` block
   next to the `Plugin` object.
2. **`setup()` is idempotent.** It clears the state first, then
   re-initializes from config and the host's API. Calling `setup()`
   twice (e.g. across a hot-reload) leaves a clean slate.
3. **`teardown()` releases every resource.** Timers are `clearTimeout`'d,
   chokidar watchers are `close()`'d, caches are cleared. The
   unregister handle returned by `api.registerHook` is called.
4. **`teardown` does not delete on-disk state.** File-based plugins
   (e.g. `todo-tracker`) leave the file in place — the user may
   return in a moment to read it.
5. **`health()` reports per-session counters** for `/diag plugins`
   visibility.

Plugins that follow this pattern expose the same teardown contract
to the host, so the loader can clean up uniformly.

## For plugin authors

The minimum viable plugin:

```typescript
import type { Plugin } from '@wrongstack/core';

const plugin: Plugin = {
  name: 'my-plugin',
  version: '0.1.0',
  description: 'One-line summary shown in `wstack plugins list`',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: {},
  configSchema: {
    type: 'object',
    properties: { /* … */ },
  },
  setup(api) {
    api.tools.register({
      name: 'my_tool',
      description: 'What this tool does',
      inputSchema: { type: 'object', properties: { /* … */ } },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        return { ok: true };
      },
    });
    api.log.info('my-plugin loaded', { version: '0.1.0' });
  },
  teardown(api) {
    // If you hold state, clear it here (see H1 pattern).
    api.log.info('my-plugin: teardown complete');
  },
  async health() {
    return { ok: true, message: 'my-plugin: alive' };
  },
};

export default plugin;
```

Register the entry in `tsup.config.ts`, the subpath export in
`package.json#exports`, and the named re-export in `src/index.ts`.
Wire it into the CLI's `BUILTIN_PLUGIN_FACTORIES` if it should
auto-load.

For plugins that need host-level data not yet exposed in
`PluginAPI` (e.g. `paths.projectDir`), extend the type in
`packages/core/src/types/plugin.ts` and `PluginAPIInit` in
`packages/core/src/plugin/api.ts`, then thread it through
`DefaultPluginAPI` and the wiring layer. See how `modelsRegistry`
was added for `cost-tracker` (commit `9bed619f`).

## License

MIT — see top-level [`LICENSE`](../../LICENSE).
