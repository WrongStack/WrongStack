// Per-plugin detail data for the plugin detail pages.
// Generated from packages/plugins/src/*/index.ts, packages/core/src/plugins/*,
// packages/plug-lsp, packages/telegram, and packages/plugins/README.md.
// Keys match pluginCatalog entry names in ./runtime-catalog.ts.

import type { PluginDetail } from './plugin-detail-types';

export const pluginDetailsPart2: Record<string, PluginDetail> = {
  'shell-check': {
    version: '0.2.0',
    longDescription:
      'Runs shellcheck static analysis on shell scripts via the shellcheck tool. Two modes: lint specific files, or recursively scan a directory with a glob pattern. Findings are surfaced with severity levels and a CSV report is written.',
    tools: [
      {
        name: 'shellcheck',
        category: 'Code Quality',
        mutating: true,
        permission: 'auto',
        summary:
          'Run shellcheck analysis on shell script files. Pass `files` for specific files, or `directory` (optionally with `pattern`) to recursively scan for .sh files. Returns issues with file, line, column, severity, code, and message.',
        params: [
          {
            name: 'files',
            type: 'string[]',
            description: 'Shell script files to check. Mutually exclusive with `directory`.',
          },
          {
            name: 'directory',
            type: 'string',
            description:
              'Directory to recursively scan for .sh files. Used when `files` is omitted.',
          },
          {
            name: 'pattern',
            type: 'string',
            description:
              'Filename pattern to match when scanning a directory (default: all .sh files).',
          },
          {
            name: 'severity',
            type: '"error" | "warning" | "info" | "style"',
            description: 'Minimum severity level to report',
          },
          {
            name: 'fix',
            type: 'boolean',
            description: 'Apply safe automatic fixes where possible',
          },
        ],
      },
    ],
    configOptions: [
      {
        name: 'severity',
        type: '"error" | "warning" | "info" | "style"',
        defaultValue: '"warning"',
      },
      {
        name: 'severityThreshold',
        type: '"error" | "warning" | "info" | "style"',
        defaultValue: '"warning"',
      },
      { name: 'ignoredCodes', type: 'string[]', defaultValue: '[]' },
      { name: 'autoScanOnBash', type: 'boolean', defaultValue: 'false' },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example: 'shellcheck({ directory: "scripts", pattern: "*.sh" })',
  },
  'cost-tracker': {
    version: '0.1.0',
    longDescription:
      'Tracks token usage and estimated USD cost per session by listening to provider.response events. Pricing resolves through a three-layer chain: per-model pricingOverrides in config, the models.dev-backed model registry, then a bundled baseline table. cost_summary reports per-model breakdowns, cost_reset zeroes the counters, and cost_export dumps the raw data.',
    tools: [
      {
        name: 'cost_summary',
        category: 'Meta',
        mutating: false,
        permission: 'auto',
        summary:
          "Returns the current session's token usage breakdown by model, total cost estimate, and budget status.",
      },
      {
        name: 'cost_reset',
        mutating: true,
        permission: 'auto',
        summary: 'Resets all token usage and cost counters for the current session.',
      },
      {
        name: 'cost_export',
        mutating: false,
        permission: 'auto',
        summary: 'Export the cost report as JSON or CSV.',
        params: [
          { name: 'format', type: '"json" | "csv"' },
          { name: 'includeModel', type: 'boolean' },
        ],
      },
    ],
    configOptions: [
      { name: 'trackPerModel', type: 'boolean', defaultValue: 'true' },
      { name: 'trackPerUser', type: 'boolean', defaultValue: 'false' },
      {
        name: 'budgetLimit',
        type: 'number',
        defaultValue: '0',
        description: 'Budget limit in USD (0 = no limit)',
      },
      {
        name: 'warningThreshold',
        type: 'number',
        defaultValue: '80',
        description: 'Warning threshold as percentage of budget',
      },
      {
        name: 'pricingOverrides',
        type: 'object',
        defaultValue: '{}',
        description:
          'Per-model pricing overrides in USD per 1M tokens. Keys are lowercased model names; values are { input, output }. Takes precedence over the bundled PRICING table.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "cost-tracker": {\n      "pricingOverrides": {\n        "gpt-4o": { "input": 7, "output": 21 }\n      }\n    }\n  }\n}',
  },
  'file-watcher': {
    version: '0.1.0',
    longDescription:
      'Watches project files with node:fs.watch and emits change events (add, change, delete) into the session. watch_start, watch_stop, and watch_list manage watchers at runtime; the CLI bridges these events to the per-project mailbox so dependency-manifest changes (package.json, go.mod, ...) can trigger tech-stack audits.',
    tools: [
      {
        name: 'watch_start',
        category: 'Filesystem',
        mutating: false,
        permission: 'confirm',
        summary:
          'Start watching one or more file paths for changes (add, change, delete). Returns a watch ID for stopping the watch later.',
        params: [
          { name: 'paths', type: 'string[]', description: 'File or directory paths to watch' },
          { name: 'events', type: 'string[]', description: 'Event types to watch for' },
          { name: 'recursive', type: 'boolean', description: 'Watch directories recursively' },
        ],
      },
      {
        name: 'watch_stop',
        mutating: false,
        permission: 'auto',
        summary: 'Stop a file watch by its ID. Releases all resources.',
        params: [
          { name: 'watch_id', type: 'string', description: 'Watch ID returned by watch_start' },
        ],
      },
      {
        name: 'watch_list',
        mutating: false,
        permission: 'auto',
        summary:
          'List all currently active file watches with their IDs, paths, and creation times.',
      },
    ],
    configOptions: [
      { name: 'debounceMs', type: 'number', defaultValue: '500' },
      { name: 'watchOnStartup', type: 'string[]', defaultValue: '[]' },
      { name: 'autoUnwatchOnExit', type: 'boolean', defaultValue: 'true' },
      {
        name: 'autoIndex',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'When true, automatically reindex changed .ts/.tsx/.js/.jsx files via codebase-index (incremental)',
      },
      {
        name: 'indexProjectRoot',
        type: 'string',
        defaultValue: '""',
        description: 'Project root directory for the indexer. Defaults to cwd when empty.',
      },
      {
        name: 'depWatcher',
        type: 'object',
        defaultValue: '{"enabled":false}',
        description:
          'Bridge dependency file changes (package.json, go.mod, etc.) to the inter-agent mailbox for tech-stack audits. Requires the mailbox tool to be registered.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
  },
  cron: {
    version: '0.1.0',
    longDescription:
      "Schedules recurring in-session tasks on timers driven by the agent loop's beforeIteration extension hook. cron_schedule registers a job, cron_list shows active jobs, and cron_cancel removes one. All timers are tracked in module state and torn down on plugin unload so hot reloads do not leak handles.",
    tools: [
      {
        name: 'cron_schedule',
        category: 'Session',
        mutating: false,
        permission: 'confirm',
        summary:
          'Schedule a recurring action to fire at a fixed interval (in milliseconds). The action is emitted as a custom event for downstream handlers.',
        params: [
          { name: 'name', type: 'string', description: 'Unique name for this cron job' },
          {
            name: 'intervalMs',
            type: 'number',
            description: 'Interval between runs in milliseconds (minimum 1000)',
          },
          {
            name: 'action',
            type: 'string',
            description: 'Action identifier or description of what to run',
          },
          { name: 'enabled', type: 'boolean' },
        ],
      },
      {
        name: 'cron_list',
        mutating: false,
        permission: 'auto',
        summary:
          'List all registered cron jobs with their intervals, next run times, and execution counts.',
      },
      {
        name: 'cron_cancel',
        mutating: false,
        permission: 'auto',
        summary: 'Cancel and remove a cron job by name.',
        params: [{ name: 'name', type: 'string', description: 'Name of the cron job to cancel' }],
      },
    ],
    configOptions: [
      { name: 'maxConcurrentJobs', type: 'number', defaultValue: '5' },
      { name: 'timezone', type: 'string', defaultValue: '"UTC"' },
      { name: 'persistSchedules', type: 'boolean', defaultValue: 'false' },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
  },
  'template-engine': {
    version: '0.1.0',
    longDescription:
      'Expands file templates with {{var}} substitution, {{#if}} conditionals, and {{#each}} loops. template_expand and template_render produce expanded content, template_create registers a new template, and template_list shows the store. The template store is in-memory and session-scoped.',
    tools: [
      {
        name: 'template_expand',
        category: 'Project',
        mutating: true,
        permission: 'auto',
        summary:
          'Expand a template string with variable substitution. Supports {{variable}}, {{#if var}}...{{/if}} conditionals, and {{#each items}}...{{/each}} loops.',
        params: [
          {
            name: 'template',
            type: 'string',
            description: 'Template string with {{variable}} placeholders',
          },
          {
            name: 'variables',
            type: 'object',
            description: 'Variables to substitute into the template',
          },
          {
            name: 'output_path',
            type: 'string',
            description: 'Optional path to write the expanded result',
          },
          { name: 'raw', type: 'boolean', description: 'Disable HTML auto-escaping' },
        ],
      },
      {
        name: 'template_render',
        mutating: true,
        permission: 'auto',
        summary: 'Read a template file from disk and expand it with the given variables.',
        params: [
          { name: 'template_path', type: 'string', description: 'Path to the template file' },
          { name: 'variables', type: 'object', description: 'Variables to substitute' },
          {
            name: 'output_path',
            type: 'string',
            description: 'Optional path to write the rendered result',
          },
          { name: 'raw', type: 'boolean' },
        ],
      },
      {
        name: 'template_create',
        mutating: false,
        permission: 'auto',
        summary: "Save a named template to the plugin's template store for later use.",
        params: [
          { name: 'name', type: 'string', description: 'Unique name for this template' },
          {
            name: 'content',
            type: 'string',
            description: 'Template content with {{variable}} placeholders',
          },
          {
            name: 'description',
            type: 'string',
            description: 'Optional description of what this template is for',
          },
        ],
      },
      {
        name: 'template_list',
        mutating: false,
        permission: 'auto',
        summary: "List all templates saved in the plugin's template store.",
      },
    ],
    configOptions: [
      { name: 'autoEscapeHtml', type: 'boolean', defaultValue: 'true' },
      { name: 'templateDir', type: 'string', defaultValue: '"./templates"' },
      { name: 'strictVariables', type: 'boolean', defaultValue: 'false' },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
  },
  'semver-bump': {
    version: '0.1.0',
    longDescription:
      'Reads the git log since the last tag, infers the next semantic version (major/minor/patch) from conventional-commit types, and can create the tag (semver_bump, confirm permission). semver_current reports the current version and semver_changelog generates a markdown changelog between two refs.',
    tools: [
      {
        name: 'semver_bump',
        mutating: true,
        permission: 'confirm',
        summary:
          'Determine the next version bump from conventional commits since the last tag, or force a specific bump. Creates a git tag.',
        params: [
          {
            name: 'cwd',
            type: 'string',
            description: 'Working directory (defaults to project root)',
          },
          { name: 'dry_run', type: 'boolean' },
          {
            name: 'part',
            type: '"major" | "minor" | "patch" | "auto"',
            description:
              'Version part to bump. Omitted → the configured default (/settings semver-part, factory default: patch). Use auto to infer from commits.',
          },
        ],
      },
      {
        name: 'semver_current',
        mutating: false,
        permission: 'auto',
        summary: 'Return the current version from package.json and the latest git tag.',
        params: [{ name: 'cwd', type: 'string', description: 'Working directory' }],
      },
      {
        name: 'semver_changelog',
        mutating: false,
        permission: 'auto',
        summary:
          'Generate a changelog (in markdown) between two version tags or from a tag to HEAD.',
        params: [
          { name: 'from', type: 'string', description: 'Starting tag (exclusive)' },
          { name: 'to', type: 'string', description: 'Ending tag or "HEAD"' },
          { name: 'cwd', type: 'string', description: 'Working directory' },
          { name: 'format', type: '"markdown" | "json"' },
        ],
      },
    ],
    configOptions: [
      { name: 'tagPrefix', type: 'string', defaultValue: '"v"' },
      { name: 'changelogFile', type: 'string', defaultValue: '"CHANGELOG.md"' },
      { name: 'autoTag', type: 'boolean', defaultValue: 'true' },
      { name: 'tagMessage', type: 'string', defaultValue: '"Release {{version}}"' },
      {
        name: 'defaultPart',
        type: '"major" | "minor" | "patch" | "auto"',
        defaultValue: '"patch"',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
  },
  'secret-scanner': {
    version: '0.1.0',
    longDescription:
      "Blocks or redacts plaintext credentials before they reach tools, and detects leaks in tool output afterwards. The PreToolUse hook (bash|write|edit) mirrors 21 credential patterns from the core secret scrubber (provider keys, GitHub PATs, AWS, JWT, PEM keys, database URIs, ...) plus any customPatterns; modes are block (default), redact, and allow. The PostToolUse hook scans every tool's output and injects a warning so the model does not echo, store, or commit a leaked value.",
    tools: [
      {
        name: 'secret_scanner_status',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports the current secret-scanner state: pattern count, last block (if any), and per-mode invocation counters.',
      },
      {
        name: 'secret_scanner_test',
        mutating: false,
        permission: 'auto',
        summary:
          'Run the scanner against a user-supplied string and report which patterns matched. Useful for verifying config and tuning the matcher.',
        params: [
          { name: 'text', type: 'string', description: 'Text to scan for credential patterns' },
        ],
      },
    ],
    configOptions: [
      {
        name: 'matcher',
        type: 'string',
        defaultValue: '"bash|write|edit"',
        description: 'PreToolUse: Tool-name matcher (pipe-delimited case-insensitive, or "*")',
      },
      {
        name: 'postToolUseMatcher',
        type: 'string',
        defaultValue: '"*"',
        description:
          'PostToolUse: Tool-name matcher for output leak detection. Default "*" scans all tool outputs.',
      },
      {
        name: 'mode',
        type: '"block" | "redact" | "allow"',
        defaultValue: '"block"',
        description:
          'PreToolUse action on a match: "block" refuses the tool call, "redact" rewrites the input with [REDACTED:type], "allow" only logs',
      },
      { name: 'enabled', type: 'boolean', defaultValue: 'true' },
      {
        name: 'customPatterns',
        type: 'object[]',
        defaultValue: '[]',
        description:
          'User-supplied custom credential patterns. Each entry is { type: string, regex: string, description?: string }. Appended to the 20 built-in patterns at setup() time.',
      },
    ],
    hooks: ['PreToolUse (bash|write|edit)', 'PostToolUse (*)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "secret-scanner": {\n      "mode": "block",\n      "matcher": "bash|write|edit",\n      "postToolUseMatcher": "*"\n    }\n  }\n}',
  },
  'todo-tracker': {
    version: '0.1.0',
    longDescription:
      "Persistent per-project todo backlog that survives across sessions, filling the gap left by the session-scoped built-in todo tool. Items live in a project JSON file written atomically (temp + rename); todo_tracker_pull returns active items so the LLM can re-register them with the built-in todo tool at session start. Requires a file path from the host's project wiring or the filePath config field.",
    tools: [
      {
        name: 'todo_tracker_list',
        mutating: false,
        permission: 'auto',
        summary:
          'List persistent todo-tracker items. Filterable by status, priority, and tag. By default only pending + in_progress items are shown.',
        params: [
          {
            name: 'status',
            type: '"pending" | "in_progress" | "completed" | "dropped" | "all"',
            description:
              "Filter by status. 'all' returns every item; default is pending+in_progress.",
          },
          { name: 'priority', type: '"low" | "normal" | "high"' },
          { name: 'tag', type: 'string', description: 'Filter by exact tag match' },
          {
            name: 'limit',
            type: 'number',
            description: 'Max items to return (default 50, max 200)',
          },
        ],
      },
      {
        name: 'todo_tracker_add',
        mutating: true,
        permission: 'auto',
        summary: 'Append a new item to the persistent todo-tracker backlog.',
        params: [
          { name: 'content', type: 'string', description: 'What needs doing (required)' },
          { name: 'priority', type: '"low" | "normal" | "high"' },
          { name: 'tags', type: 'string[]', description: 'Optional tags for filtering' },
          {
            name: 'sourceSessionId',
            type: 'string',
            description: 'Session that created this item',
          },
          { name: 'notes', type: 'string', description: 'Optional free-form notes' },
        ],
      },
      {
        name: 'todo_tracker_complete',
        mutating: true,
        permission: 'auto',
        summary: 'Mark a tracked item as completed. Idempotent.',
        params: [{ name: 'id', type: 'string', description: 'Item id' }],
      },
      {
        name: 'todo_tracker_drop',
        mutating: true,
        permission: 'auto',
        summary:
          'Mark a tracked item as dropped (skipped/obsolete). The row is kept for audit. Idempotent.',
        params: [{ name: 'id', type: 'string', description: 'Item id' }],
      },
      {
        name: 'todo_tracker_remove',
        mutating: true,
        permission: 'confirm',
        summary:
          'Permanently delete a tracked item by id. Use todo_tracker_drop instead if you want to keep the audit row.',
        params: [{ name: 'id', type: 'string', description: 'Item id' }],
      },
      {
        name: 'todo_tracker_pull',
        mutating: false,
        permission: 'auto',
        summary:
          'Return all pending + in_progress items. The LLM is expected to take this list and re-register each entry with the session-local `todo` tool (which mutates ctx.todos). After pull, the LLM may also choose to call todo_tracker_complete on items it finishes mid-session.',
        params: [
          {
            name: 'limit',
            type: 'number',
            description: 'Max items to return (default 50, max 200)',
          },
        ],
      },
      {
        name: 'todo_tracker_status',
        mutating: false,
        permission: 'auto',
        summary:
          'Report todo-tracker counters (per-status totals) + the file path + last update timestamp.',
      },
    ],
    configOptions: [
      {
        name: 'filePath',
        type: 'string',
        defaultValue: '""',
        description:
          'Override the auto-derived per-project path. Defaults to <projectDir>/todo-tracker.json when `paths.projectDir` is provided by the host.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "todo-tracker": {\n      "filePath": "/abs/path/to/todo-tracker.json"\n    }\n  }\n}',
  },
  'token-budget': {
    version: '0.1.0',
    longDescription:
      "Enforces a hard per-session token budget, complementing cost-tracker's USD tracking. When usage crosses warnPercent a one-shot PostToolUse injection tells the model to start wrapping up, and at stopPercent a Stop hook blocks the agent loop. The default limit of 0 means tracking only; token_budget_status reports the consumed/remaining breakdown.",
    tools: [
      {
        name: 'token_budget_status',
        category: 'Meta',
        mutating: false,
        permission: 'auto',
        summary:
          'Shows the current token budget status: limit, consumed, remaining, percentage, and whether warning/stop thresholds have been crossed.',
      },
    ],
    configOptions: [
      {
        name: 'limit',
        type: 'number',
        defaultValue: '0',
        description:
          'Hard token limit (prompt + completion combined). 0 = disabled (tracking only).',
      },
      {
        name: 'warnPercent',
        type: 'number',
        defaultValue: '80',
        description: 'Percentage of limit at which to inject a "wrap up" context signal.',
      },
      {
        name: 'stopPercent',
        type: 'number',
        defaultValue: '100',
        description: 'Percentage of limit at which to trigger Stop (end the agent loop).',
      },
      {
        name: 'model',
        type: 'string',
        defaultValue: '""',
        description:
          'Restrict counting to a specific model. Supports "*" trailing wildcard (e.g. "gpt-4*" matches gpt-4o, gpt-4o-mini). Empty string = count all models.',
      },
    ],
    hooks: ['Stop', 'PostToolUse (*)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "token-budget": {\n      "limit": 500000,\n      "warnPercent": 80,\n      "stopPercent": 100\n    }\n  }\n}',
  },
  'lint-gate': {
    version: '0.1.0',
    longDescription:
      'Runs biome or eslint on the would-be file content before a write or edit commits it: write content is linted via a temp file, and edits are applied in memory first. Modes: block refuses the tool call, warn (default) injects lint errors as context, and fix auto-applies fixes and substitutes the corrected content (write only), optionally limited to fixRules.',
    tools: [
      {
        name: 'lint_gate_status',
        category: 'Code Quality',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports lint-gate state: linter detected, mode, severity threshold, and per-session invocation/hit/error counters.',
      },
    ],
    configOptions: [
      {
        name: 'linter',
        type: '"biome" | "eslint" | "auto"',
        defaultValue: '"auto"',
        description: 'Which linter to use. "auto" tries biome first, then eslint.',
      },
      {
        name: 'mode',
        type: '"block" | "warn" | "fix"',
        defaultValue: '"warn"',
        description:
          '"block" refuses the write/edit; "warn" injects lint errors as context; "fix" auto-runs the linter with --write/--fix and substitutes the fixed content (write: full file; edit: new_string snippet in isolation — file-level rules like import sorting are not checked on snippets).',
      },
      {
        name: 'severity',
        type: '"error" | "warning"',
        defaultValue: '"error"',
        description:
          'Minimum severity to act on. "error" = only errors; "warning" = errors + warnings.',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        defaultValue: '10000',
        description: 'Linter process timeout in milliseconds.',
      },
      {
        name: 'fixRules',
        type: 'string[]',
        defaultValue: '[]',
        description:
          'When mode=fix, only auto-fix issues matching these rule IDs (e.g. "lint/style/useImportType", "format"). Empty = fix everything the linter can.',
      },
    ],
    hooks: ['PreToolUse (write|edit)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "lint-gate": {\n      "mode": "fix",\n      "fixRules": ["format", "lint/style/useImportType"]\n    }\n  }\n}',
  },
  'branch-guard': {
    version: '0.1.0',
    longDescription:
      'PreToolUse hook that blocks (or warns about) git commit, push, and merge on protected branches - default main and master - covering bash commands, the structured git tool, and git_autocommit calls. When the working tree is dirty, the block reason includes a safe stash, feature-branch, retry workflow. Each operation type can be toggled individually.',
    tools: [
      {
        name: 'branch_guard_status',
        category: 'Git',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports branch-guard state: protected branches, mode, and per-session invocation/block/warn counters.',
      },
    ],
    configOptions: [
      {
        name: 'branches',
        type: 'string[]',
        defaultValue: '["main","master"]',
        description: 'Branch names that are protected.',
      },
      {
        name: 'mode',
        type: '"block" | "warn"',
        defaultValue: '"block"',
        description: '"block" refuses the call; "warn" injects context but lets it through.',
      },
      {
        name: 'blockCommit',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Block commits on protected branches.',
      },
      {
        name: 'blockPush',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Block pushes from protected branches.',
      },
      {
        name: 'blockMerge',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Block merges into protected branches.',
      },
    ],
    hooks: ['PreToolUse (bash|git|git_autocommit)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "branch-guard": {\n      "branches": ["main", "master"],\n      "mode": "block"\n    }\n  }\n}',
  },
  'diff-summary': {
    version: '0.1.0',
    longDescription:
      'After every write or edit, runs git diff on the touched file and injects a capped unified diff as additional context, giving the model immediate visibility into what its change actually did. Modes: diff (body plus "+N -M" header), stat (counts only), or off. New files diff against /dev/null; non-git projects are silently skipped.',
    tools: [
      {
        name: 'diff_summary_status',
        category: 'Meta',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports diff-summary state: mode, maxLines, and per-session invocation/injected/fallback counters.',
      },
    ],
    configOptions: [
      {
        name: 'maxLines',
        type: 'number',
        defaultValue: '50',
        description: 'Cap diff context at N lines to avoid blowing up the context window.',
      },
      {
        name: 'showStat',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Include "+N -M" summary line.',
      },
      {
        name: 'mode',
        type: '"diff" | "stat" | "off"',
        defaultValue: '"diff"',
        description:
          '"diff" injects unified diff; "stat" injects only +N -M counts; "off" disables the hook.',
      },
      {
        name: 'includeContext',
        type: 'number',
        defaultValue: '3',
        description:
          'Context lines around each change (git -U<N>). 0 = compact (no surrounding lines), 3 = git default, higher = more orientation.',
      },
      {
        name: 'minIntervalMs',
        type: 'number',
        defaultValue: '1000',
        description:
          'Per-path throttle: minimum interval (ms) between two diff-summary injections for the same file. Skips `git diff` when the model re-touches a file within the window. Set to 0 to disable.',
      },
      {
        name: 'enableContentHashCache',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'When true, fingerprints the PostToolUse payload content and skips `git diff` when the hash matches the previously injected hash for the same path. Catches "edit retry" loops.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "diff-summary": {\n      "maxLines": 50,\n      "showStat": true,\n      "mode": "diff"\n    }\n  }\n}',
  },
};
