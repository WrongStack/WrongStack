// Per-plugin detail data for the plugin detail pages.
// Generated from packages/plugins/src/*/index.ts, packages/core/src/plugins/*,
// packages/plug-lsp, packages/telegram, and packages/plugins/README.md.
// Keys match pluginCatalog entry names in ./runtime-catalog.ts.

import type { PluginDetail } from './plugin-detail-types';

export const pluginDetailsPart5: Record<string, PluginDetail> = {
  'notify-hub': {
    version: '0.1.0',
    longDescription:
      'Sends compact JSON notifications to a configured webhook: session stops (Stop hook), tool errors and budget-threshold events (event subscriptions), and ad-hoc messages via the notify_send tool. An empty webhookUrl leaves the plugin idle, and repeated delivery failures disable sending for the rest of the session.',
    tools: [
      {
        name: 'notify_send',
        category: 'Notifications',
        mutating: true,
        permission: 'auto',
        summary:
          'Send an ad-hoc notification to the configured webhook (e.g. "migration finished", "need input"). No-op when notify-hub has no webhookUrl.',
        params: [
          { name: 'title', type: 'string', description: 'Short notification title.' },
          { name: 'message', type: 'string', description: 'Notification body.' },
          {
            name: 'level',
            type: '"info" | "warning" | "critical"',
            description: 'Severity hint for the receiver (default info).',
          },
        ],
      },
      {
        name: 'notify_hub_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports notify-hub state: webhook configuration (URL redacted), subscribed events, and delivery counters.',
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
        name: 'webhookUrl',
        type: 'string',
        defaultValue: '""',
        description: 'HTTP(S) endpoint that receives JSON POSTs. Empty = plugin idles.',
      },
      {
        name: 'events',
        type: 'string[]',
        defaultValue: '["session.stop","tool.error"]',
        description: 'Which events trigger a webhook delivery.',
      },
      {
        name: 'headers',
        type: 'object',
        defaultValue: '{}',
        description: 'Extra HTTP headers sent with every delivery (e.g. Authorization).',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        defaultValue: '5000',
        description: 'Per-delivery timeout.',
      },
      {
        name: 'maxConsecutiveFailures',
        type: 'number',
        defaultValue: '5',
        description: 'Circuit breaker: stop trying after this many consecutive failures.',
      },
    ],
    hooks: ['Stop'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "notify-hub": {\n      "webhookUrl": "https://hooks.example.test/wrongstack",\n      "events": ["session.stop", "tool.error"]\n    }\n  }\n}',
  },
  'changelog-writer': {
    version: '0.1.0',
    longDescription:
      'Collects changelog entries during a session - manual changelog_add calls plus, optionally, conventional-commit subjects - and writes them under the ## [Unreleased] heading in Keep-a-Changelog format. changelog_preview shows pending entries; changelog_write (confirm permission) persists them to the changelog file.',
    tools: [
      {
        name: 'changelog_add',
        category: 'Docs',
        mutating: false,
        permission: 'auto',
        summary:
          'Record a changelog entry for the pending [Unreleased] block (written later via changelog_write).',
        params: [
          { name: 'text', type: 'string', description: 'The entry text, user-facing wording.' },
          {
            name: 'section',
            type: '"Added" | "Changed" | "Fixed" | "Removed" | "Security" | "Documentation" | "Maintenance"',
            description: 'Keep-a-Changelog section (default Changed).',
          },
        ],
      },
      {
        name: 'changelog_preview',
        category: 'Docs',
        mutating: false,
        permission: 'auto',
        summary:
          'Render the pending [Unreleased] changelog block collected this session without writing anything. Pass polish:true to rewrite entries into user-facing wording via the LLM.',
        params: [
          {
            name: 'polish',
            type: 'boolean',
            description: 'Rewrite entries into user-facing wording via the LLM (api.llm).',
          },
        ],
      },
      {
        name: 'changelog_write',
        category: 'Docs',
        mutating: true,
        permission: 'confirm',
        summary:
          'Merge the pending entries into the changelog file under ## [Unreleased] (creates the file when missing). Clears pending entries on success. Pass polish:true to rewrite entries into user-facing wording via the LLM first.',
        params: [
          {
            name: 'polish',
            type: 'boolean',
            description:
              'Rewrite entries into user-facing wording via the LLM (api.llm) before writing.',
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
        name: 'filePath',
        type: 'string',
        defaultValue: '"CHANGELOG.md"',
        description: 'Changelog file path (relative to the session cwd or absolute).',
      },
      {
        name: 'collectCommits',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Auto-collect entries from conventional commit subjects seen this session.',
      },
      {
        name: 'maxEntries',
        type: 'number',
        defaultValue: '200',
        description: 'Cap on pending entries held in memory.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example: 'changelog_add({ section: "Fixed", text: "Prevent template path traversal." })',
  },
  'injection-shield': {
    version: '0.1.0',
    longDescription:
      'Scans tool output - fetched web pages, read files - for prompt-injection patterns such as instruction overrides, secret-exfiltration requests, and authority claims. It injects a warning telling the model to treat the content as data, not instructions; the tool output itself is never modified.',
    tools: [
      {
        name: 'injection_shield_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports injection-shield state: watched tools, pattern names, and counters (scans, detections).',
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
        name: 'tools',
        type: 'string',
        defaultValue: '"*"',
        description: 'Pipe-delimited tool-name matcher for the PostToolUse hook ("*" = all tools).',
      },
      {
        name: 'minMatches',
        type: 'number',
        defaultValue: '1',
        description: 'Distinct pattern hits required before a warning is injected.',
      },
      {
        name: 'maxScanChars',
        type: 'number',
        defaultValue: '262144',
        description: 'Only the first N chars of each result are scanned.',
      },
    ],
    hooks: ['PostToolUse (*)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "injection-shield": { "enabled": true, "tools": "*" }\n  }\n}',
  },
  'llm-cache': {
    version: '0.1.0',
    longDescription:
      'Caches identical provider requests via a provider-runner wrapper and short-circuits the provider call on a hit. Off by default because caching changes provider-call semantics; only deterministic requests are cached unless onlyDeterministic is disabled, and ttlMs/maxEntries bound the cache.',
    tools: [
      {
        name: 'llm_cache_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports llm-cache state: enabled, size, hit/miss/skip counters, and tokens saved by cache hits.',
      },
      {
        name: 'llm_cache_clear',
        category: 'Diagnostics',
        mutating: true,
        permission: 'auto',
        summary: 'Drops all cached provider responses (does not disable the cache).',
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Master switch. OFF by default because caching changes provider call semantics.',
      },
      {
        name: 'maxEntries',
        type: 'number',
        defaultValue: '256',
        description: 'LRU capacity; oldest entries are evicted past this.',
      },
      {
        name: 'ttlMs',
        type: 'number',
        defaultValue: '0',
        description: 'Entry lifetime in ms. 0 = no expiry.',
      },
      {
        name: 'onlyDeterministic',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'Only cache requests with temperature 0 or unset (never freeze a sampled generation).',
      },
      {
        name: 'zeroUsageOnHit',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Report 0 tokens on a cache hit (true) so cost tracking reflects the saving, or keep the cached usage for context accounting (false).',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "llm-cache": { "enabled": true, "maxEntries": 256, "ttlMs": 300000 }\n  }\n}',
  },
  'model-router': {
    version: '0.1.0',
    longDescription:
      'Routes provider calls to alternate models based on declarative rules (input size, tool usage, and similar conditions) through a provider-runner wrapper. Off by default and dry-run by default - it only logs what it would do - and routing stays within the active provider.',
    tools: [
      {
        name: 'model_router_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports model-router state: enabled, dryRun, rules, and per-route counts (from→to).',
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Master switch. OFF by default because rerouting changes which model serves each turn.',
      },
      {
        name: 'dryRun',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'Observe and count routing decisions without actually rewriting request.model.',
      },
      {
        name: 'rules',
        type: 'object[]',
        defaultValue: '[]',
        description:
          'Ordered rules. Each has an optional maxChars/minChars/hasTools condition and a required target model. First all-conditions-match wins.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "model-router": {\n      "enabled": true,\n      "dryRun": false,\n      "rules": []\n    }\n  }\n}',
  },
  'pr-drafter': {
    version: '0.1.0',
    longDescription:
      'Collects work during the session - git_autocommit commit messages, files touched by write/edit, and model usage - and composes a markdown pull-request draft. By default a Stop hook writes it to .wrongstack/PR_DRAFT.md; the pr_draft tool returns the draft on demand.',
    tools: [
      {
        name: 'pr_draft',
        category: 'Workflow',
        mutating: false,
        permission: 'auto',
        summary:
          'Generate or refresh the pull-request draft for the current session. Writes the markdown file and returns its path + title.',
        params: [
          {
            name: 'preview',
            type: 'boolean',
            description: 'When true, return the draft body without writing to disk.',
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
        name: 'outputPath',
        type: 'string',
        defaultValue: '".wrongstack/PR_DRAFT.md"',
        description: 'Path where the markdown PR draft is written.',
      },
      {
        name: 'writeOnStop',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Automatically write the draft when the session stops.',
      },
      {
        name: 'includeDiff',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Include git diff --stat in the draft.',
      },
      {
        name: 'includeCommits',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Include recorded commit messages.',
      },
      {
        name: 'includeFiles',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Include files touched by write/edit tools.',
      },
      {
        name: 'aiSummary',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Use api.llm to generate a PR title and summary.',
      },
      {
        name: 'llm',
        type: 'object',
        description: 'Optional { provider, model } override for the AI summary.',
      },
    ],
    hooks: ['Stop'],
    apiVersion: '^0.1.10',
  },
  'prompt-firewall': {
    version: '0.1.0',
    longDescription:
      'Scans the provider wire - outgoing requests and optionally responses - for credential leaks and prompt-risk patterns via a provider-runner wrapper. Modes are warn (default), redact, and block; the plugin is disabled by default because redact and block can alter or stop provider calls.',
    tools: [
      {
        name: 'prompt_firewall_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports prompt-firewall state: mode, pattern kinds, and detection/redaction/block counters.',
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Master switch. OFF by default; redact/block modes can alter or stop provider calls.',
      },
      {
        name: 'mode',
        type: '"warn" | "redact" | "block"',
        defaultValue: '"warn"',
        description:
          'warn = detect only; redact = strip secrets from the request/response; block = refuse the request.',
      },
      {
        name: 'scanResponse',
        type: 'boolean',
        defaultValue: 'true',
        description: 'In redact mode, also redact secrets echoed back in the provider response.',
      },
      {
        name: 'allow',
        type: 'string[]',
        defaultValue: '[]',
        description:
          'Regex source strings whose matches are exempt (to silence known false positives).',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "prompt-firewall": { "enabled": true, "mode": "redact", "scanResponse": true }\n  }\n}',
  },
  'auto-escalate': {
    version: '0.1.0',
    longDescription:
      'Retries transient provider failures (rate limits, 5xx, timeouts, connection resets) with the next model in a configured escalation ladder using the onError extension. Disabled by default because it changes error-recovery behavior and can increase cost; with no ladder configured it defers to default recovery.',
    tools: [
      {
        name: 'auto_escalate_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports auto-escalate state: enabled, escalation ladder, and escalation counters.',
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Master switch. OFF by default because it changes error-recovery behavior.',
      },
      {
        name: 'escalation',
        type: 'string[]',
        defaultValue: '[]',
        description:
          'Ordered model ids (cheapest→most-capable) to retry with on successive retryable errors.',
      },
      {
        name: 'retryablePatterns',
        type: 'string[]',
        defaultValue:
          '["overload","rate.?limit","\\\\b429\\\\b","\\\\b50[023]\\\\b","timeout","ETIMEDOUT","ECONNRESET","ECONNREFUSED","temporarily unavailable"]',
        description:
          'Case-insensitive regexes; an error whose text matches any is treated as retryable.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "auto-escalate": {\n      "enabled": true,\n      "escalation": ["gpt-5-mini", "gpt-5.5"]\n    }\n  }\n}',
  },
  'token-throttle': {
    version: '0.1.0',
    longDescription:
      'Applies a rolling-window tokens-per-minute budget to provider calls via a provider-runner wrapper: when the next request would exceed the configured rate, the call is delayed (up to maxDelayMs) instead of failing. Token counts are estimated from characters when usage data is unavailable.',
    tools: [
      {
        name: 'token_throttle_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports token-throttle state: window spend, throttle counters, and total injected delay.',
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Master switch. OFF by default because throttling injects delays into provider calls.',
      },
      {
        name: 'tokensPerMinute',
        type: 'number',
        defaultValue: '100000',
        description: 'Rolling 60s-window token budget.',
      },
      {
        name: 'maxDelayMs',
        type: 'number',
        defaultValue: '30000',
        description:
          'Hard cap on any single throttle wait so a mis-set budget cannot hang the agent.',
      },
      {
        name: 'charsPerToken',
        type: 'number',
        defaultValue: '4',
        description: 'Divisor turning request char size into a token estimate.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "token-throttle": {\n      "enabled": true,\n      "tokensPerMinute": 120000,\n      "maxDelayMs": 30000\n    }\n  }\n}',
  },
  'plugin-stack-observer': {
    version: '0.1.0',
    longDescription:
      'Makes the provider-runner wrap stack visible: it subscribes to the provider.wrap:loaded events emitted by llm-cache, model-router, prompt-firewall, and token-throttle, keeps the stack in registration order, and reports it via plugin_stack_status. An optional system-prompt contributor shows the stack to the LLM (off by default).',
    tools: [
      {
        name: 'plugin_stack_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Returns the active wrapProviderRunner stack: plugin names, kinds, what they wrap, and registration order.',
      },
    ],
    configOptions: [
      {
        name: 'enabled',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Master switch. When false, no events are collected.',
      },
      {
        name: 'injectIntoSystemPrompt',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'When true, the active wrap stack is included as a TextBlock in every system-prompt build so the LLM knows who is wrapping its provider calls.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
  },
  'test-coverage-gate': {
    version: '0.1.0',
    longDescription:
      'Reads the coverage summary JSON (c8/vitest/istanbul format) after each write/edit to a source file, compares it with the previous snapshot, and warns - or blocks - when overall coverage falls below the threshold, drops by more than deltaThreshold, or the edited file itself loses coverage.',
    tools: [
      {
        name: 'coverage_gate_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports test-coverage-gate state: threshold, mode, last coverage percentage, and counters.',
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
        name: 'coveragePath',
        type: 'string',
        defaultValue: '"coverage/coverage-summary.json"',
        description: 'Path to the JSON coverage summary file.',
      },
      {
        name: 'threshold',
        type: 'number',
        defaultValue: '80',
        description: 'Minimum allowed overall coverage percentage.',
      },
      {
        name: 'mode',
        type: '"warn" | "block"',
        defaultValue: '"warn"',
        description: 'warn = inject context; block = refuse the mutating tool.',
      },
      {
        name: 'deltaThreshold',
        type: 'number',
        defaultValue: '1',
        description: 'Warn/block when coverage drops by at least this many percentage points.',
      },
      {
        name: 'runOnChange',
        type: 'string[]',
        defaultValue: '[".ts",".tsx",".js",".jsx"]',
        description: 'Only check coverage when the edited file has one of these extensions.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'test-flake-detector': {
    version: '0.1.0',
    longDescription:
      'Runs a test command repeatedly (flake_detect, up to maxRuns) and reports tests that fail non-deterministically across runs, separating true failures from flakes. The command defaults to npx vitest run and each run is bounded by timeoutMs.',
    tools: [
      {
        name: 'flake_detect',
        category: 'Diagnostics',
        mutating: false,
        permission: 'confirm',
        summary:
          'Runs a test command multiple times and reports tests that fail non-deterministically. Provide testPattern and optionally runs (default 5) and command.',
        params: [
          {
            name: 'testPattern',
            type: 'string',
            description: 'Test file pattern or path to pass to the test command.',
          },
          { name: 'runs', type: 'number', description: 'How many times to run the command.' },
          {
            name: 'command',
            type: 'string',
            description: 'Custom test command. Defaults to the configured defaultCommand.',
          },
        ],
      },
      {
        name: 'flake_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary: 'Reports test-flake-detector state: config and per-session counters.',
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
        name: 'defaultCommand',
        type: 'string',
        defaultValue: '"npx vitest run"',
        description: 'Command used when flake_detect.command is omitted.',
      },
      {
        name: 'maxRuns',
        type: 'number',
        defaultValue: '20',
        description: 'Hard upper bound for the runs parameter.',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        defaultValue: '120000',
        description: 'Per-run timeout in milliseconds.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
  },
};
