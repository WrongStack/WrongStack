// Per-plugin detail data for the plugin detail pages.
// Generated from packages/plugins/src/*/index.ts, packages/core/src/plugins/*,
// packages/plug-lsp, packages/telegram, and packages/plugins/README.md.
// Keys match pluginCatalog entry names in ./runtime-catalog.ts.

import type { PluginDetail } from './plugin-detail-types';

export const pluginDetailsPart6: Record<string, PluginDetail> = {
  'performance-regression-gate': {
    version: '0.1.0',
    longDescription:
      'Compares benchmark results to catch performance regressions: perf_regression_status reads a bench-results.json (Vitest bench format) and either pairs "(old)"/"(new)"-suffixed benchmarks within one file or matches names across a separate baseline file, reporting entries whose mean time grew beyond thresholdPercent.',
    tools: [
      {
        name: 'perf_regression_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reads bench-results.json and reports performance regressions. Without baselinePath, pairs benchmarks named with (old) and (new) suffixes. With baselinePath, compares matching benchmarks across the two files.',
        params: [
          {
            name: 'resultsPath',
            type: 'string',
            description: 'Path to current benchmark results (JSON).',
          },
          {
            name: 'baselinePath',
            type: 'string',
            description:
              'Optional path to baseline/previous results. If omitted, (old)/(new) pairs within resultsPath are compared.',
          },
          {
            name: 'thresholdPercent',
            type: 'number',
            description: 'Override the configured threshold percentage.',
          },
        ],
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Master switch.',
      },
      {
        name: 'thresholdPercent',
        type: 'number',
        defaultValue: '10',
        description: 'Percentage increase in mean execution time that counts as a regression.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
  },
  'type-gate': {
    version: '0.1.0',
    longDescription:
      'Runs TypeScript type-checking (npx tsc --noEmit or a custom command) after every write or edit to a source file and injects the first few errors as context so the model fixes type regressions in the same turn. failSeverity "block" refuses instead of warning; lint-gate covers style while this plugin covers types.',
    tools: [
      {
        name: 'type_gate_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports type-gate state: command, tsconfig, severity, and per-session pass/fail/error counters.',
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Master switch.',
      },
      {
        name: 'command',
        type: 'string',
        defaultValue: '""',
        description:
          'Custom type-check command (overrides tsc default). Empty = "npx tsc --noEmit -p tsConfigPath".',
      },
      {
        name: 'tsConfigPath',
        type: 'string',
        defaultValue: '"tsconfig.json"',
        description: 'Path to the tsconfig used when command is empty.',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        defaultValue: '60000',
        description: 'Type-check process timeout in milliseconds.',
      },
      {
        name: 'failSeverity',
        type: '"warn" | "block"',
        defaultValue: '"warn"',
        description:
          'warn = inject errors as additionalContext; block = refuse the mutating tool when type errors appear.',
      },
      {
        name: 'maxErrors',
        type: 'number',
        defaultValue: '5',
        description: 'Maximum number of type errors shown in context.',
      },
      {
        name: 'runOnChange',
        type: 'string[]',
        defaultValue: '[".ts",".tsx",".js",".jsx",".mts",".cts"]',
        description: 'Only run type-check when the edited file has one of these extensions.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'duplicate-code-detector': {
    version: '0.1.0',
    longDescription:
      'Finds duplicated or near-duplicated code blocks across source files using normalized-line fingerprinting (detect_duplicate_code), and a PostToolUse hook warns when a just-changed file introduces blocks that duplicate existing code elsewhere. Minimum block size and similarity threshold are configurable.',
    tools: [
      {
        name: 'detect_duplicate_code',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Scan source files for duplicated code blocks. Uses normalized-line fingerprinting to find identical multi-line blocks across files.',
        params: [{ name: 'path', type: 'string', description: 'Directory or file path to scan.' }],
      },
      {
        name: 'duplicate_code_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary: 'Reports duplicate-code-detector state: config + counters.',
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Master switch.',
      },
      {
        name: 'minLines',
        type: 'number',
        defaultValue: '8',
        description: 'Minimum number of consecutive lines to form a block.',
      },
      {
        name: 'threshold',
        type: 'number',
        defaultValue: '0.8',
        description: 'Similarity threshold (currently exact-match only).',
      },
      {
        name: 'extensions',
        type: 'string[]',
        defaultValue: '[".ts",".tsx",".js",".jsx"]',
        description: 'File extensions to scan.',
      },
      {
        name: 'excludeDirs',
        type: 'string[]',
        defaultValue: '["node_modules","dist",".git","coverage"]',
        description: 'Directory names to skip while scanning.',
      },
      {
        name: 'maxFindings',
        type: 'number',
        defaultValue: '20',
        description: 'Maximum duplicate groups reported per scan.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'release-notes-generator': {
    version: '0.2.0',
    longDescription:
      'Generates traceable release-notes Markdown from conventional commits between two resolved Git refs. The deterministic path groups commits by type and scope. Optional api.llm polishing targets users, developers, or operators, but is accepted only when every short commit hash survives exactly once; otherwise the original grouped notes are returned.',
    tools: [
      {
        name: 'generate_release_notes',
        category: 'Development',
        mutating: false,
        permission: 'auto',
        summary:
          'Generate release notes by grouping conventional commits between two git refs. Defaults to the latest tag..HEAD.',
        params: [
          {
            name: 'from',
            type: 'string',
            description:
              'Starting git ref (tag, commit, branch). Defaults to the configured defaultFrom.',
          },
          { name: 'to', type: 'string', description: 'Ending git ref.' },
          {
            name: 'use_llm',
            type: 'boolean',
            description: 'Polish deterministic notes through api.llm for this call.',
          },
          {
            name: 'audience',
            type: '"users" | "developers" | "operators"',
            description: 'Audience for optional LLM wording.',
          },
        ],
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Master switch.',
      },
      {
        name: 'includeScope',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Include commit scopes in the formatted notes.',
      },
      {
        name: 'defaultFrom',
        type: 'string',
        defaultValue: '"latest-tag"',
        description:
          'Default starting ref when `from` is omitted. Use "latest-tag" to discover the most recent tag.',
      },
      {
        name: 'useLlm',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Rewrite deterministic notes through api.llm while preserving every commit hash.',
      },
      {
        name: 'audience',
        type: '"users" | "developers" | "operators"',
        defaultValue: '"users"',
        description: 'Default audience for optional LLM wording.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "release-notes-generator": {\n      "useLlm": true,\n      "audience": "users"\n    }\n  }\n}\n\ngenerate_release_notes({ from: "v1.4.0", to: "HEAD", use_llm: true })',
  },
  'test-generator': {
    version: '0.2.0',
    longDescription:
      'Generates a framework-correct test file beside the source by detecting exported functions, classes, arrow functions, values, and named exports while preserving the source extension. Deterministic templates support Vitest, Jest, and node:test with the right imports and assertion style. Optional api.llm authoring receives bounded source context and falls back to the skeleton on cancellation, provider failure, or invalid output.',
    tools: [
      {
        name: 'generate_unit_tests',
        category: 'Development',
        mutating: false,
        permission: 'auto',
        summary:
          'Generate a test skeleton for a source file. Detects exported functions, arrow functions, classes, and named exports. Returns the test content as a string; it does not write to disk.',
        params: [
          {
            name: 'path',
            type: 'string',
            description: 'Source file path (relative to project root).',
          },
          {
            name: 'use_llm',
            type: 'boolean',
            description: 'Generate behavior-focused tests through api.llm for this call.',
          },
        ],
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Master switch.',
      },
      {
        name: 'framework',
        type: '"vitest" | "jest" | "node:test"',
        defaultValue: '"vitest"',
        description: 'Test framework to target.',
      },
      {
        name: 'testSuffix',
        type: 'string',
        defaultValue: '".test"',
        description: 'Suffix inserted before the extension of the generated test filename.',
      },
      {
        name: 'includeImports',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Emit import statements for detected exports.',
      },
      {
        name: 'useLlm',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Ask api.llm for behavior-focused tests; the deterministic skeleton remains the fallback.',
      },
      {
        name: 'maxSourceChars',
        type: 'number',
        defaultValue: '20000',
        description: 'Maximum source characters included in an optional LLM request.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "test-generator": {\n      "framework": "vitest",\n      "useLlm": true,\n      "maxSourceChars": 20000\n    }\n  }\n}\n\ngenerate_unit_tests({ path: "src/math.ts", use_llm: true })',
  },
  '@wrongstack/plug-lsp': {
    version: '0.1.0',
    longDescription:
      'Language Server Protocol bridge: manages LSP server processes per language and exposes semantic code intelligence as tools - diagnostics, go-to-definition, completions, workspace-wide semantic rename, and a deprecated LSP-backed search superseded by the built-in codebase-search. The /lsp slash command installs, starts, stops, restarts, and inspects servers. Servers can be auto-discovered from the project and are started lazily on first use by default.',
    tools: [
      {
        name: 'lsp_diagnostics',
        mutating: false,
        permission: 'auto',
        summary: 'Get diagnostics from configured language servers.',
        params: [
          { name: 'path', type: 'string' },
          { name: 'limit', type: 'integer' },
        ],
      },
      {
        name: 'lsp_definition',
        mutating: false,
        permission: 'auto',
        summary: 'Find where a symbol is defined.',
        params: [
          { name: 'path', type: 'string' },
          { name: 'line', type: 'integer' },
          { name: 'character', type: 'integer' },
        ],
      },
      {
        name: 'lsp_completion',
        mutating: false,
        permission: 'auto',
        summary: 'Get semantic code completions from a configured language server.',
        params: [
          { name: 'path', type: 'string' },
          { name: 'line', type: 'integer' },
          { name: 'character', type: 'integer' },
          { name: 'content', type: 'string' },
          { name: 'limit', type: 'integer' },
          { name: 'trigger_character', type: 'string' },
          { name: 'format', type: '"text" | "json"' },
        ],
      },
      {
        name: 'codebase-lsp-search',
        mutating: false,
        permission: 'auto',
        summary:
          'DEPRECATED — use `codebase-search` with `preferLsp: true` instead. This tool remains for backward compatibility but is superseded by the built-in codebase-search tool.',
        params: [
          { name: 'query', type: 'string', description: 'Search query string' },
          {
            name: 'limit',
            type: 'integer',
            description: 'Maximum number of results to return (default 20, max 100)',
          },
          {
            name: 'preferLsp',
            type: 'boolean',
            description:
              'If true, skip the index and query LSP servers directly. Useful for live precision when the index may be stale.',
          },
        ],
      },
      {
        name: 'lsp_rename',
        mutating: true,
        permission: 'confirm',
        summary: 'Rename a symbol semantically across the workspace.',
        params: [
          { name: 'path', type: 'string' },
          { name: 'line', type: 'integer' },
          { name: 'character', type: 'integer' },
          { name: 'new_name', type: 'string' },
        ],
      },
    ],
    configOptions: [
      {
        name: 'servers',
        type: 'object',
        description: 'Per-language LSP server definitions (command, args, file types).',
      },
      {
        name: 'autoStart',
        type: '"lazy" | "eager" | "never"',
        defaultValue: '"lazy"',
        description: 'When to start configured servers.',
      },
      {
        name: 'diagnosticsAfterEdit',
        type: '"background" | "manual"',
        defaultValue: '"background"',
        description:
          'Whether diagnostics are collected in the background after edits or only on demand.',
      },
      {
        name: 'diagnosticsWaitMs',
        type: 'integer',
        defaultValue: '1500',
        description: 'How long to wait for diagnostics after an edit.',
      },
      {
        name: 'severityFilter',
        type: 'string[]',
        defaultValue: '["error","warning"]',
        description: 'Diagnostic severities to report.',
      },
      {
        name: 'maxDiagnosticsPerFile',
        type: 'integer',
        defaultValue: '5',
        description: 'Cap on diagnostics reported per file.',
      },
      {
        name: 'maxDiagnosticsTotal',
        type: 'integer',
        defaultValue: '50',
        description: 'Cap on total diagnostics reported.',
      },
      {
        name: 'autoDiscover',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Auto-discover installed language servers for the project.',
      },
      {
        name: 'logServerOutput',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Log raw LSP server output for debugging.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.1',
    example: '/lsp install typescript\n/lsp start\nlsp_diagnostics({ path: "src/index.ts" })',
  },
  telegram: {
    version: '0.3.4',
    longDescription:
      'Telegram bridge built on the Bot API: telegram_send posts messages to a chat (confirm permission), telegram_read returns buffered incoming messages from allowed users and chats, and telegram_approve posts a yes/no inline-keyboard prompt and waits for a tap - enabling remote human approval of risky steps. Unread incoming messages are surfaced through a system-prompt contributor, session-end and long-running-tool notifications are optional, and a single-instance lock elects one poller per bot token across wstack processes. Set up via /telegram-setup and /telegram-settings.',
    tools: [
      {
        name: 'telegram_send',
        category: 'Telegram',
        mutating: true,
        permission: 'confirm',
        summary:
          'Send a message to a Telegram chat. The message is written in natural prose for a human reader; raw JSON or tool-output dumps are discouraged.',
        params: [
          {
            name: 'chat_id',
            type: 'string | integer',
            description: 'Target chat or user ID. Uses the plugin default when omitted.',
          },
          {
            name: 'message',
            type: 'string',
            description: 'Message text in natural, human-readable prose.',
          },
        ],
      },
      {
        name: 'telegram_read',
        category: 'Telegram',
        mutating: false,
        permission: 'auto',
        summary:
          'Read recent incoming Telegram messages the bot has received, newest first, with sender, text, and timestamp. Acknowledge with ack_last to clear them.',
        params: [
          {
            name: 'chat_id',
            type: 'string | integer',
            description: 'Read messages only from this chat/user.',
          },
          { name: 'limit', type: 'integer', description: 'Max messages to return (default: 10).' },
          {
            name: 'ack_last',
            type: 'integer',
            description:
              'After processing messages, pass the highest message_id to clear them from the buffer.',
          },
        ],
      },
      {
        name: 'telegram_approve',
        category: 'Telegram',
        mutating: false,
        permission: 'auto',
        summary:
          'Post a yes/no approval prompt to a Telegram chat with inline keyboard buttons and wait for the user to tap one. Returns approved=false on timeout or explicit deny.',
        params: [
          {
            name: 'prompt',
            type: 'string',
            description: 'Short label for what is being approved. Shown as the prompt heading.',
          },
          { name: 'details', type: 'string', description: 'Optional context under the heading.' },
          {
            name: 'chat_id',
            type: 'string | integer',
            description: 'Chat to post the prompt to. Uses the plugin default when omitted.',
          },
          {
            name: 'timeout_ms',
            type: 'integer',
            description: 'How long to wait before auto-denying. Default 60000 ms, max 600000 ms.',
          },
        ],
      },
    ],
    configOptions: [
      {
        name: 'botToken',
        type: 'string',
        description: 'Telegram Bot API token from @BotFather',
      },
      {
        name: 'notifyChatId',
        type: 'string | integer',
        description: 'Default chat ID for outgoing notifications',
      },
      {
        name: 'allowedUsers',
        type: '(string | integer)[]',
        description: 'User IDs allowed to interact with the bot',
      },
      {
        name: 'allowedChats',
        type: '(string | integer)[]',
        description: 'Chat IDs the bot is allowed to read from',
      },
      {
        name: 'pollIntervalSec',
        type: 'integer',
        defaultValue: '2',
        description: 'Polling interval in seconds',
      },
      { name: 'notifyOnSessionEnd', type: 'boolean', defaultValue: 'false' },
      { name: 'longToolThresholdMs', type: 'integer', defaultValue: '30000' },
      { name: 'notifyOnDelegate', type: 'boolean' },
      { name: 'maxMessageLength', type: 'integer', defaultValue: '4000' },
      {
        name: 'singleInstanceLock',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'Elect a single getUpdates poller per bot token across wstack instances (default true)',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      'telegram_approve({ prompt: "Delete build artifacts?", details: "Frees 2.3 GB.", timeout_ms: 60000 })',
  },
  'process-guard': {
    version: '0.1.0',
    longDescription:
      'Three-layer kill defense for all WrongStack processes. The process-guard plugin provides observability via a PreToolUse hook that detects kill-related bash/exec commands and a process_guard_status tool. Actual blocking is enforced by the tool-level kill guards (bash-kill-guard.ts, exec-kill-guard.ts) in the bash and exec tools. All layers consult PersistentProcessRegistry for cross-instance PID protection.',
    tools: [
      {
        name: 'process_guard_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports process-guard state: mode, counters, and last detected kill-related command.',
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Master switch.',
      },
      {
        name: 'mode',
        type: '"block" | "warn" | "off"',
        defaultValue: '"block"',
        description: 'block = refuse the operation; warn = inject context; off = disable.',
      },
    ],
    hooks: [
      'preToolUse — Detects and logs kill-related bash/exec commands (kill, pkill, taskkill, Stop-Process, killall, tskill, wmic). Does not block directly; actual blocking is enforced by the tool-level kill guards in bash.ts and exec.ts.',
    ],
    apiVersion: '^0.1.10',
    example:
      'process_guard_status — reports { enabled, mode, platform, selfPid, parentPid, counters: { invocations, detections, warns }, lastDetection }',
  },
  'gitignore-guard': {
    version: '0.1.0',
    longDescription:
      "PostToolUse write|edit hook that suggests (mode: 'suggest', default) or auto-appends (mode: 'append') a .gitignore entry for build-artifact-looking paths. Configurable via artifactPatterns (regex array) and ignorePatterns (regex array); maxAppendPerCall caps lines appended per hook invocation. Deliberately orthogonal to path-guard (which blocks protected paths; gitignore-guard never blocks, only suggests/appends). Default state active per audit catalog (risk: medium) — toggle `enabled: false` to disable.",
    tools: [
      {
        name: 'gitignore_guard_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports gitignore-guard state: mode, active pattern lists, per-session suggest/append/skip counters.',
      },
      {
        name: 'gitignore_guard_append',
        category: 'Files',
        mutating: true,
        permission: 'confirm',
        summary:
          'Append a .gitignore entry for a path (or an explicit gitignore pattern). Walks parent directories for the first existing .gitignore and appends missing pattern lines.',
        params: [
          {
            name: 'path',
            type: 'string',
            description: 'File or directory path whose artifact pattern should be appended.',
          },
          {
            name: 'pattern',
            type: 'string',
            description:
              'Optional explicit gitignore pattern to append. When omitted, the pattern is derived from the path via artifactPatterns.',
          },
        ],
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Master switch. When false, the hook is a no-op.',
      },
      {
        name: 'mode',
        type: '"suggest" | "append"',
        defaultValue: '"suggest"',
        description:
          "'suggest' injects a notice into the tool result; 'append' writes the missing pattern to a .gitignore automatically.",
      },
      {
        name: 'artifactPatterns',
        type: 'string[]',
        description:
          'Regex array matching basename (no slash) or anchored glob (with slash) of build-artifact-looking paths.',
      },
      {
        name: 'ignorePatterns',
        type: 'string[]',
        description: 'Regex array of paths to skip entirely.',
      },
      {
        name: 'maxAppendPerCall',
        type: 'number',
        defaultValue: '5',
        description: 'Maximum number of lines appended per hook invocation.',
      },
    ],
    hooks: ['PostToolUse (write|edit) — lifecycle: hot'],
    apiVersion: '^0.1.10',
  },
  'adversary-mode': {
    version: '0.1.0',
    longDescription:
      'Independent natural-language pre-tool intent and task-drift reviewer inspired by Goose adversary.md. Dormant at zero LLM cost until ~/.wrongstack/adversary.md (or additive <project>/.wrongstack/adversary.md) is created; once active, PreToolUse compares the user original task, recent prompts, and untrusted external data taint against your plain-language rules via BrainArbiter, Jev, Council, or One-Shot LLM to block contextual task hijacking.',
    tools: [
      {
        name: 'adversary_mode_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports Adversary Mode state: whether adversary.md policy is active, loaded policy sources, watched tools, session external-data taint, and decision counters.',
        params: [
          {
            name: 'sessionId',
            type: 'string',
            description:
              'Optional session id to inspect external-data taint and captured user task.',
          },
          {
            name: 'cwd',
            type: 'string',
            description: 'Optional working directory to resolve project .wrongstack/adversary.md.',
          },
        ],
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Master switch for Adversary Mode hooks.',
      },
      {
        name: 'alwaysOn',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Enforce the built-in baseline adversary rules even when no adversary.md file exists on disk.',
      },
      {
        name: 'mode',
        type: '"block" | "warn"',
        defaultValue: '"block"',
        description: 'Deny flagged tool calls ("block") or allow with warning context ("warn").',
      },
      {
        name: 'engine',
        type: '"auto" | "brain" | "jev" | "council" | "llm"',
        defaultValue: '"auto"',
        description:
          'Reviewer decision engine ("auto" routes through BrainArbiter, Jev, Council on tainted sessions, and One-Shot LLM).',
      },
      {
        name: 'failurePolicy',
        type: '"open" | "closed"',
        defaultValue: '"open"',
        description:
          'Fallback when no reviewer tier is reachable ("open" allows, "closed" blocks).',
      },
      {
        name: 'projectPolicy',
        type: '"additive" | "ignore"',
        defaultValue: '"additive"',
        description:
          'How repository .wrongstack/adversary.md is handled ("additive" adds extra BLOCK rules only; "ignore" skips repo files).',
      },
      {
        name: 'onlyAfterExternal',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Run semantic pre-tool checks only after untrusted external/web/MCP data or injection signals enter the session.',
      },
      {
        name: 'expandToolsAfterExternalData',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'Automatically expand watched tools to outbound network, browser, and package-install tools once a session is tainted by external data.',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        defaultValue: '8000',
        description: 'Maximum wall-clock milliseconds per pre-tool adversary check.',
      },
      {
        name: 'cacheVerdicts',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'Cache identical (policy, task, taint, tool, arguments) verdicts for 5 minutes.',
      },
    ],
    hooks: [
      'UserPromptSubmit (*) — captures user stated task and recent prompts',
      'PostToolUse (*) — tracks untrusted external data taint (web/MCP/injection signals)',
      'PreToolUse (*) — validates watched tool calls against adversary.md policy',
    ],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "adversary-mode": {\n      "enabled": true,\n      "mode": "block",\n      "engine": "auto"\n    }\n  }\n}\n\n# Initialize ~/.wrongstack/adversary.md:\n/adversary init',
  },
};
