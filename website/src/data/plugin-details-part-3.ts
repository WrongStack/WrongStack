// Per-plugin detail data for the plugin detail pages.
// Generated from packages/plugins/src/*/index.ts, packages/core/src/plugins/*,
// packages/plug-lsp, packages/telegram, and packages/plugins/README.md.
// Keys match pluginCatalog entry names in ./runtime-catalog.ts.

import type { PluginDetail } from './plugin-detail-types';

export const pluginDetailsPart3: Record<string, PluginDetail> = {
  'commit-validator': {
    version: '0.1.0',
    longDescription:
      'Validates commit messages against the conventional-commit format before git commit (bash) or git_autocommit runs: type against allowedTypes, optional required scope, subject length, and no trailing period. Mode block refuses the commit; warn lets it through with context.',
    tools: [
      {
        name: 'commit_validator_status',
        category: 'Git',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports commit-validator state: mode, allowedTypes, maxSubjectLength, and per-session valid/invalid counters.',
      },
    ],
    configOptions: [
      {
        name: 'mode',
        type: '"block" | "warn"',
        defaultValue: '"block"',
        description:
          '"block" refuses the commit; "warn" injects errors as context but lets it through.',
      },
      {
        name: 'requireScope',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Require a scope in parentheses (e.g. feat(auth): ...).',
      },
      {
        name: 'allowedTypes',
        type: 'string[]',
        defaultValue: '[]',
        description:
          'Restrict to these commit types. Empty = allow all standard types (feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert) plus any custom type.',
      },
      {
        name: 'maxSubjectLength',
        type: 'number',
        defaultValue: '72',
        description: 'Maximum subject line length in characters.',
      },
      {
        name: 'bodyRequired',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Require a non-empty commit body after the subject line.',
      },
      {
        name: 'minBodyLength',
        type: 'number',
        defaultValue: '10',
        description: 'Minimum body length in characters (when bodyRequired is true).',
      },
      {
        name: 'suggestFix',
        type: 'boolean',
        defaultValue: 'false',
        description:
          "When true and mode=warn, ask the host LLM for a corrected conventional-commit subject and include it in the warn context. Off by default (LLM calls aren't free). Ignored in block mode.",
      },
    ],
    hooks: ['PreToolUse (bash|git_autocommit)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "commit-validator": {\n      "mode": "block",\n      "allowedTypes": ["feat", "fix", "docs"],\n      "maxSubjectLength": 72\n    }\n  }\n}',
  },
  'format-on-save': {
    version: '0.1.0',
    longDescription:
      'Runs biome format --write on the file on disk after every write or edit - silent reformatting with no blocking. If formatting changed the file, additional context tells the model. Biome detection runs once at setup; without biome the hook is a silent no-op. It complements lint-gate (lints before the write) and diff-summary (shows the diff after).',
    tools: [
      {
        name: 'format_on_save_status',
        category: 'Code Quality',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports format-on-save state: biome availability, and per-session formatted/clean/error/skipped counters.',
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
        name: 'timeoutMs',
        type: 'number',
        defaultValue: '5000',
        description: 'Biome format process timeout in milliseconds.',
      },
      {
        name: 'skipWhenCoveredBy',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'Skip the format pass when another plugin (e.g. import-organizer) just touched the same path. Saves one biome invocation per write/edit when both plugins are enabled.',
      },
      {
        name: 'skipTtlMs',
        type: 'number',
        defaultValue: '30000',
        description:
          'How long (ms) to remember a path covered by another plugin. 0 disables the memory.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'test-runner-gate': {
    version: '0.1.0',
    longDescription:
      'After a write or edit to a source file, maps it to its test file via configurable {name}/{path}/{dir} patterns, runs the test command (vitest by default), and injects failure details (test name plus error, up to five) so the model immediately knows what broke. Passing runs are silent unless injectOnPass is set.',
    tools: [
      {
        name: 'test_gate_status',
        category: 'Testing',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports test-runner-gate state: command, patterns, and per-session pass/fail/error/no-test counters.',
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
        name: 'runner',
        type: '"vitest" | "jest" | "mocha" | "auto"',
        defaultValue: '"auto"',
        description: 'Which test runner to use. "auto" tries vitest first, then jest, then mocha.',
      },
      {
        name: 'command',
        type: 'string',
        defaultValue: '""',
        description:
          'Custom command prefix (overrides the runner default). Empty = use runner default.',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        defaultValue: '30000',
        description: 'Test process timeout in milliseconds.',
      },
      {
        name: 'testFilePatterns',
        type: 'string[]',
        defaultValue: '["src/{name}.test.ts","tests/{name}.test.ts","tests/{name}-exec.test.ts"]',
        description:
          'Patterns to derive test file from source. {name}=basename, {path}=path-no-ext, {dir}=dirname.',
      },
      {
        name: 'injectOnPass',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Inject additionalContext when tests pass too (default: only on failure).',
      },
      {
        name: 'enableContentHashCache',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'Skip re-running tests when the source path is touched again with the same content hash as a previous PASS in this session.',
      },
      {
        name: 'enableExtensionFilter',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'Fast-path skip for non-TS/JS files (.json, .md, .lock, .txt, ...) before the test-file resolve walk.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "test-runner-gate": {\n      "enabled": true,\n      "testFilePatterns": ["tests/{name}.test.ts", "src/{name}.test.ts"]\n    }\n  }\n}',
  },
  'import-organizer': {
    version: '0.1.0',
    longDescription:
      'Runs biome check --write --unsafe (falling back to eslint --fix) on each file just written or edited: re-sorts imports within groups, merges duplicates, and removes unused ones alongside other safe fixes. The hook is idempotent and reports remaining unfixable lint issues as context. The --unsafe flag can affect edge-case runtime behavior; adjust the command to drop it for safe-only fixes.',
    tools: [
      {
        name: 'import_organizer_status',
        category: 'Code Quality',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports import-organizer state: linter availability, config, and per-session organized/clean/error counters.',
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
        name: 'command',
        type: 'string',
        defaultValue: '"npx @biomejs/biome check --write --unsafe"',
        description:
          'Primary linter command. Use the `--write` (or `--fix`) flag and biome-specific `--unsafe` so import organization runs.',
      },
      {
        name: 'fallbackCommand',
        type: 'string',
        defaultValue: '"npx eslint --fix"',
        description:
          'Fallback command (e.g. `eslint --fix`) used when the primary linter is not installed.',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        defaultValue: '10000',
        description: 'Per-invocation linter timeout in milliseconds.',
      },
      {
        name: 'notifyFormatOnSave',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'Emit `import-organizer:done` after each successful run so `format-on-save` can skip its redundant `biome format --write` pass on the same file. Set false to keep both running unconditionally.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'knowledge-graph': {
    version: '0.1.0',
    longDescription:
      'Accumulates durable (subject, relation, object) facts about the project in a per-project JSON file so they survive across sessions. kg_add_fact, kg_query, and kg_remove_fact manage the store, and an optional system-prompt contributor injects a compact summary of relevant facts (capped by contributeMaxChars) into each session.',
    tools: [
      {
        name: 'kg_add_fact',
        category: 'Memory',
        mutating: true,
        permission: 'auto',
        summary:
          'Add a structured fact to the project knowledge graph. Facts persist across sessions.',
        params: [
          { name: 'subject', type: 'string', description: 'The entity the fact is about.' },
          {
            name: 'relation',
            type: 'string',
            description: 'Relationship, e.g. "depends_on", "owned_by".',
          },
          { name: 'object', type: 'string', description: 'The related entity or value.' },
          {
            name: 'source',
            type: 'string',
            description: 'Where this fact came from (file path, conversation, tool result).',
          },
          {
            name: 'confidence',
            type: '"low" | "medium" | "high"',
            description: 'How sure the agent is about this fact.',
          },
        ],
      },
      {
        name: 'kg_query',
        category: 'Memory',
        mutating: false,
        permission: 'auto',
        summary:
          'Query the knowledge graph by subject, relation, object, or confidence. Returns matching facts.',
        params: [
          { name: 'subject', type: 'string' },
          { name: 'relation', type: 'string' },
          { name: 'object', type: 'string' },
          { name: 'confidence', type: '"low" | "medium" | "high"' },
          { name: 'limit', type: 'number', description: 'Max results (default 20).' },
        ],
      },
      {
        name: 'kg_remove_fact',
        category: 'Memory',
        mutating: true,
        permission: 'auto',
        summary: 'Remove a fact from the knowledge graph by its id (kg-N).',
        params: [{ name: 'id', type: 'string', description: 'Fact id to remove.' }],
      },
      {
        name: 'kg_status',
        category: 'Memory',
        mutating: false,
        permission: 'auto',
        summary: 'Reports knowledge-graph state: fact count, persisted path, and counters.',
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
        name: 'filePath',
        type: 'string',
        defaultValue: '".wrongstack/knowledge-graph.json"',
        description: 'Project-local JSON file where facts persist.',
      },
      {
        name: 'maxFacts',
        type: 'number',
        defaultValue: '200',
        description: 'Maximum number of facts stored.',
      },
      {
        name: 'maxFactChars',
        type: 'number',
        defaultValue: '300',
        description: 'Per-field length cap (subject, relation, object).',
      },
      {
        name: 'contributeToSystemPrompt',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Inject a compact fact summary into the system prompt.',
      },
      {
        name: 'contributeMaxChars',
        type: 'number',
        defaultValue: '1500',
        description: 'Maximum chars contributed to the system prompt.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
  },
  'todo-listener': {
    version: '0.1.0',
    longDescription:
      'Broadcasts a structured status update to the project mailbox whenever the built-in todo tool is called, so other agents and surfaces can see what this agent is working on in real time. Identical consecutive payloads are deduplicated by hash and broadcasts are rate-limited by cooldownMs. Requires a host that wires api.mailbox; otherwise it no-ops with a one-shot warning.',
    tools: [
      {
        name: 'todo_listener_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports todo-listener state: config + per-session counters (invocations, sent, skipped, errors) and last broadcast id.',
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
        name: 'subjectPrefix',
        type: 'string',
        defaultValue: '"todo: "',
        description: 'Prepended to the broadcast `subject`. Useful for filtering the inbox.',
      },
      {
        name: 'broadcastOnChange',
        type: 'boolean',
        defaultValue: 'true',
        description: 'When true, identical consecutive payloads are suppressed.',
      },
      {
        name: 'cooldownMs',
        type: 'number',
        defaultValue: '30000',
        description: 'Minimum interval between consecutive broadcasts (ms).',
      },
    ],
    hooks: ['PostToolUse (todo)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "todo-listener": {\n      "enabled": true,\n      "cooldownMs": 30000\n    }\n  }\n}',
  },
  'session-recap': {
    version: '0.1.0',
    longDescription:
      'Posts a one-page session summary to the project mailbox when the agent loop stops: tokens per model, top tool-call counts, commit count, wall-clock duration, and optionally the last few transcript events. Useful for end-of-day handoff and audit; requires a mailbox-wired host.',
    tools: [
      {
        name: 'session_recap_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports session-recap state: config, accumulated metrics (tokens, tool calls, commits), and last recap status.',
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
        name: 'subjectPrefix',
        type: 'string',
        defaultValue: '"session recap: "',
        description: 'Prepended to the broadcast subject.',
      },
      {
        name: 'includeTranscriptTail',
        type: 'number',
        defaultValue: '3',
        description: 'Number of last transcript events to include in the recap body.',
      },
      {
        name: 'maxBodyChars',
        type: 'number',
        defaultValue: '8000',
        description: 'Hard cap on the recap body size (chars).',
      },
      {
        name: 'aiSummary',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Prepend an LLM-written natural-language summary (api.llm) to the recap. Provider/model follow extensions["session-recap"].llm, then the session default.',
      },
      {
        name: 'llm',
        type: 'object',
        description: 'Optional { provider, model } override for the AI summary.',
      },
    ],
    hooks: ['Stop'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "session-recap": {\n      "enabled": true,\n      "includeTranscriptTail": 3\n    }\n  }\n}',
  },
  'spec-linker': {
    version: '0.2.0',
    longDescription:
      'Keeps markdown docs navigable by finding references to known plugin names that are not wrapped in a link. A PostToolUse hook on write/edit lists unlinked references as context so the model can fix them, and with autoFix enabled a PreToolUse hook on write rewrites the content directly, wrapping each reference in a markdown link while preserving casing. edit calls are never auto-fixed because their input is a patch, not the whole file.',
    tools: [
      {
        name: 'spec_linker_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports spec-linker state: config, counters (post + pre hooks), and the canonical plugin catalog used for detection.',
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
        name: 'fileGlobs',
        type: 'string[]',
        defaultValue: '["**/*.md","**/*.mdx"]',
        description: 'Glob patterns to match (markdown by default).',
      },
      {
        name: 'maxReferences',
        type: 'number',
        defaultValue: '8',
        description: 'Hard cap on the number of unlinked references in the injected context.',
      },
      {
        name: 'autoFix',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'When true, the PreToolUse hook on `write` returns a `modifiedInput.content` where each unlinked plugin reference is wrapped in a markdown link. Default false (opt in).',
      },
    ],
    hooks: ['PostToolUse (write|edit)', 'PreToolUse (write)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "spec-linker": {\n      "fileGlobs": ["**/*.md", "**/*.mdx"],\n      "autoFix": false\n    }\n  }\n}',
  },
  'doc-sync-guard': {
    version: '0.1.0',
    longDescription:
      'Tracks public source files changed by write/edit during the session; when a README or docs file is later written without mentioning those files, it injects a warning listing the omissions. Purely advisory - it never blocks or rewrites.',
    tools: [
      {
        name: 'doc_sync_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports doc-sync-guard state: tracked changed files, doc-write count, and warning count.',
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
        name: 'sourceExtensions',
        type: 'string[]',
        defaultValue: '[".ts",".tsx",".js",".jsx",".mts",".cts"]',
        description: 'Extensions considered public source files.',
      },
      {
        name: 'docNames',
        type: 'string[]',
        defaultValue: '["README.md","README","CONTRIBUTING.md","CHANGELOG.md"]',
        description: 'Base file names treated as documentation.',
      },
      {
        name: 'maxTrackedFiles',
        type: 'number',
        defaultValue: '20',
        description: 'Maximum number of recently changed source files to remember.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'loop-breaker': {
    version: '0.1.0',
    longDescription:
      'Detects runaway tool-call loops before they burn the session: exact-repeat streaks, A-B-A-B oscillations, edits that produce no diff, and repeated identical errors. Thresholds first inject a warning, then block the repeating call (warn mode only ever warns). Counters and the last detection are visible via loop_breaker_status.',
    tools: [
      {
        name: 'loop_breaker_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports loop-breaker state: config, current repeat streak, and counters (warnings, blocks, oscillations).',
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
        type: '"warn" | "block"',
        defaultValue: '"warn"',
        description: 'block = refuse the repeated call; warn = only inject context.',
      },
      {
        name: 'warnAfter',
        type: 'number',
        defaultValue: '3',
        description: 'Consecutive identical calls before a warning is injected.',
      },
      {
        name: 'blockAfter',
        type: 'number',
        defaultValue: '5',
        description: 'Consecutive identical calls before the call is blocked.',
      },
      {
        name: 'oscillationWindow',
        type: 'number',
        defaultValue: '8',
        description: 'Recent-call window length used for A-B-A-B oscillation detection.',
      },
      {
        name: 'maxSteps',
        type: 'number',
        defaultValue: '200',
        description: 'Maximum tool steps before blocking; 0 disables the step budget.',
      },
      {
        name: 'noDiffWarnAfter',
        type: 'number',
        defaultValue: '6',
        description: 'Successful edit/write steps without a changed git diff before warning.',
      },
      {
        name: 'noDiffBlockAfter',
        type: 'number',
        defaultValue: '10',
        description:
          'Successful edit/write steps without a changed git diff before blocking next step; 0 disables.',
      },
      {
        name: 'repeatedErrorWarnAfter',
        type: 'number',
        defaultValue: '2',
        description: 'Consecutive identical tool errors before warning.',
      },
      {
        name: 'repeatedErrorBlockAfter',
        type: 'number',
        defaultValue: '3',
        description: 'Consecutive identical tool errors before blocking next step; 0 disables.',
      },
      {
        name: 'ignoreTools',
        type: 'string[]',
        defaultValue: '[]',
        description: 'Tool names exempt from loop detection.',
      },
    ],
    hooks: ['PreToolUse (*)', 'PostToolUse (*)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "loop-breaker": {\n      "mode": "block",\n      "warnAfter": 3,\n      "blockAfter": 5\n    }\n  }\n}',
  },
  'path-guard': {
    version: '0.1.0',
    longDescription:
      'Blocks or warns about writes, edits, and destructive shell commands touching protected paths. Defaults protect lockfiles, .env files, .git internals, and migration directories; the protect and allow lists take glob patterns, and mode "warn" switches to advisory-only enforcement.',
    tools: [
      {
        name: 'path_guard_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports path-guard state: protected globs, mode, and counters (invocations, blocks, warns).',
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
        type: '"block" | "warn"',
        defaultValue: '"block"',
        description: 'block = refuse the operation; warn = only inject context.',
      },
      {
        name: 'protect',
        type: 'string[]',
        defaultValue:
          '["pnpm-lock.yaml","package-lock.json","yarn.lock","bun.lockb","Cargo.lock","poetry.lock",".env",".env.*",".git/**","**/migrations/**"]',
        description: 'Glob patterns for protected paths. Replaces the default set when present.',
      },
      {
        name: 'allow',
        type: 'string[]',
        defaultValue: '[]',
        description: 'Glob patterns that override `protect` (exemptions).',
      },
    ],
    hooks: ['PreToolUse (write|edit|bash|exec)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "path-guard": {\n      "mode": "block",\n      "protect": [".env", ".git/**", "**/migrations/**"]\n    }\n  }\n}',
  },
  'context-pins': {
    version: '0.1.0',
    longDescription:
      'Pins short durable facts into the system prompt so they survive context compaction. pin_add, pin_remove, and pin_list manage the pins; when the host provides a project directory the pins persist to a per-project JSON file, otherwise they live in memory for the session.',
    tools: [
      {
        name: 'pin_add',
        category: 'Memory',
        mutating: true,
        permission: 'auto',
        summary:
          'Pin a short durable fact into the system prompt so it survives context compaction. Use for constraints, decisions, and preferences that must not be forgotten.',
        params: [
          { name: 'text', type: 'string', description: 'The fact to pin (short and declarative).' },
          {
            name: 'label',
            type: 'string',
            description: 'Optional short label, e.g. "api" or "style".',
          },
        ],
      },
      {
        name: 'pin_remove',
        category: 'Memory',
        mutating: true,
        permission: 'auto',
        summary: 'Remove a pinned fact by its id (pin-N) or label.',
        params: [{ name: 'id', type: 'string', description: 'Pin id (pin-N) or label to remove.' }],
      },
      {
        name: 'pin_list',
        category: 'Memory',
        mutating: false,
        permission: 'auto',
        summary: 'List all pinned facts currently injected into the system prompt.',
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
        name: 'filePath',
        type: 'string',
        defaultValue: '""',
        description:
          'JSON file where pins persist across sessions. Empty = in-memory only. Seeded by the host to <projectDir>/context-pins.json.',
      },
      {
        name: 'maxPins',
        type: 'number',
        defaultValue: '20',
        description: 'Maximum number of concurrent pins.',
      },
      {
        name: 'maxPinChars',
        type: 'number',
        defaultValue: '500',
        description: 'Per-pin text length cap (chars).',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example: 'pin_add({ label: "api", text: "Use the v2 billing endpoint for invoices." })',
  },
};
