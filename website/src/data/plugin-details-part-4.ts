// Per-plugin detail data for the plugin detail pages.
// Generated from packages/plugins/src/*/index.ts, packages/core/src/plugins/*,
// packages/plug-lsp, packages/telegram, and packages/plugins/README.md.
// Keys match pluginCatalog entry names in ./runtime-catalog.ts.

import type { PluginDetail } from './plugin-detail-types';

export const pluginDetailsPart4: Record<string, PluginDetail> = {
  checkpoint: {
    version: '0.1.0',
    longDescription:
      'Keeps in-session snapshots of file contents: a PreToolUse hook auto-captures the pre-edit state before every write or edit (bounded by maxSnapshots and maxFileBytes), and checkpoint_create captures labeled snapshots on demand. checkpoint_restore writes a snapshot back to disk - it never deletes files that did not exist at capture time, it reports them instead.',
    tools: [
      {
        name: 'checkpoint_create',
        category: 'Safety',
        mutating: false,
        permission: 'auto',
        summary:
          'Manually snapshot the current content of one or more files before a risky operation (codemod, bulk rename, script run). Restore later with checkpoint_restore.',
        params: [
          { name: 'paths', type: 'string[]', description: 'File paths to snapshot.' },
          { name: 'label', type: 'string', description: 'Optional label recorded as the origin.' },
        ],
      },
      {
        name: 'checkpoint_list',
        category: 'Safety',
        mutating: false,
        permission: 'auto',
        summary: 'List captured file snapshots (newest first) with ids for checkpoint_restore.',
        params: [
          { name: 'limit', type: 'number', description: 'Max entries to return (default 20).' },
        ],
      },
      {
        name: 'checkpoint_restore',
        category: 'Safety',
        mutating: true,
        permission: 'confirm',
        summary:
          'Restore file(s) to the content captured in a snapshot (see checkpoint_list). Restores every file in the snapshot, or a single file when `path` is given. Files that did not exist at capture time are reported but never deleted.',
        params: [
          {
            name: 'id',
            type: 'string',
            description: 'Snapshot id (cp-N). Default: the newest snapshot.',
          },
          {
            name: 'path',
            type: 'string',
            description: 'Restore only this file from the snapshot (optional).',
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
        name: 'autoCapture',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Snapshot the target file before every write/edit tool call.',
      },
      {
        name: 'maxSnapshots',
        type: 'number',
        defaultValue: '50',
        description: 'Snapshot ring size — oldest snapshots are dropped first.',
      },
      {
        name: 'maxFileBytes',
        type: 'number',
        defaultValue: '1048576',
        description: 'Files larger than this are not captured.',
      },
    ],
    hooks: ['PreToolUse (write|edit)'],
    apiVersion: '^0.1.10',
    example: 'checkpoint_create({ paths: ["src/service.ts"], label: "before refactor" })',
  },
  'error-lens': {
    version: '0.1.0',
    longDescription:
      'Distills failed bash/exec output into a compact digest - the likely error line, project stack frames, and a repeat count - injected as context instead of the full noisy dump. A capped history is kept for follow-up inspection via error_lens_history.',
    tools: [
      {
        name: 'error_lens_history',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Lists failures observed this session (error line, source frames, repeat counts). Useful to review what has been breaking.',
        params: [
          { name: 'limit', type: 'number', description: 'Max entries to return (default 10).' },
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
        name: 'maxFrames',
        type: 'number',
        defaultValue: '5',
        description: 'Source locations included per digest.',
      },
      {
        name: 'historySize',
        type: 'number',
        defaultValue: '20',
        description: 'Failures kept for error_lens_history.',
      },
      {
        name: 'minOutputChars',
        type: 'number',
        defaultValue: '200',
        description: 'Outputs shorter than this are not digested (already readable).',
      },
      {
        name: 'aiHints',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Enrich each NEW failure digest with a one-line fix hint from the LLM (api.llm). Provider/model follow config.extensions["error-lens"].llm, then the session default.',
      },
      {
        name: 'llm',
        type: 'object',
        description: 'Optional { provider, model } override for AI hints.',
      },
    ],
    hooks: ['PostToolUse (bash|exec)'],
    apiVersion: '^0.1.10',
    example: '{\n  "extensions": {\n    "error-lens": { "enabled": true, "maxFrames": 5 }\n  }\n}',
  },
  'dep-guard': {
    version: '0.1.0',
    longDescription:
      'Supervises dependency installs before they run: blocks deny-listed packages, flags likely typosquats of popular package names (optionally confirmed with an LLM), and can warn about unpinned versions. Applies to bash and exec install commands via a PreToolUse hook.',
    tools: [
      {
        name: 'dep_guard_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports dep-guard state: deny/allow lists, mode, and counters (installs seen, blocks, warns).',
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
        description: 'How deny-list hits are handled.',
      },
      {
        name: 'deny',
        type: 'string[]',
        defaultValue: '[]',
        description:
          'Package names (exact) or prefix globs ("@evil/*") that must not be installed.',
      },
      {
        name: 'allow',
        type: 'string[]',
        defaultValue: '[]',
        description: 'Exemptions that override deny.',
      },
      {
        name: 'warnOnUnpinned',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Warn when a package is installed without an explicit version.',
      },
      {
        name: 'typosquatCheck',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Warn when a package name is one edit away from a well-known package.',
      },
      {
        name: 'confirmTyposquatsWithLlm',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Ask the host LLM to confirm whether a flagged typosquat is real-but-obscure or genuinely a typo. Appended to the warn context, never escalates to a block. Off by default.',
      },
    ],
    hooks: ['PreToolUse (bash|exec)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "dep-guard": {\n      "mode": "block",\n      "deny": ["event-stream"]\n    }\n  }\n}',
  },
  'dependency-vulnerability-gate': {
    version: '0.1.0',
    longDescription:
      'Runs npm audit --json (or pnpm audit when a pnpm lockfile is present) after install commands and blocks or warns when any reported vulnerability meets or exceeds the configured severity threshold. Triggered by the install tool and by bash/exec commands that look like package installs.',
    tools: [
      {
        name: 'dependency_audit_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports dependency-vulnerability-gate state: threshold, block mode, and per-session counters.',
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
        name: 'severityThreshold',
        type: '"low" | "moderate" | "high" | "critical"',
        defaultValue: '"high"',
        description: 'Minimum severity that triggers a block or warning.',
      },
      {
        name: 'block',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'true = block the install when threshold is exceeded; false = inject warning context.',
      },
      {
        name: 'timeoutMs',
        type: 'number',
        defaultValue: '120000',
        description: 'Audit process timeout in milliseconds.',
      },
    ],
    hooks: ['PostToolUse (install|bash|exec)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "dependency-vulnerability-gate": {\n      "severityThreshold": "high",\n      "block": true\n    }\n  }\n}',
  },
  'license-audit-gate': {
    version: '0.1.0',
    longDescription:
      'Audits dependency licenses right after package-manager install/add commands: for each newly added package it reads node_modules/<pkg>/package.json and checks the license field against an allowlist (MIT, Apache-2.0, BSD, ISC, and friends by default). Non-allowlisted licenses block the install by default, or inject a warning when block is false.',
    tools: [
      {
        name: 'license_audit_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports license-audit-gate state: allowlist, block mode, and per-session audit counters.',
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
        name: 'allowedLicenses',
        type: 'string[]',
        defaultValue: '["MIT","Apache-2.0","BSD-2-Clause","BSD-3-Clause","ISC","0BSD","Unlicense"]',
        description: 'List of allowed SPDX/license identifiers.',
      },
      {
        name: 'block',
        type: 'boolean',
        defaultValue: 'true',
        description:
          'true = block the install when a disallowed license is found; false = inject a warning note.',
      },
    ],
    hooks: ['PostToolUse (bash|exec)'],
    apiVersion: '^0.1.10',
  },
  'security-hotspot-scanner': {
    version: '0.1.0',
    longDescription:
      'Scans source code for common security anti-patterns: the security_hotspot_scan tool covers a file or directory on demand, and a PostToolUse hook warns when a write or edit introduces new hotspots in watched extensions. Severity "block" refuses the edit instead of warning.',
    tools: [
      {
        name: 'security_hotspot_scan',
        category: 'Security',
        mutating: false,
        permission: 'auto',
        summary:
          'Scan a file or directory for security anti-patterns (eval, Function constructor, innerHTML, SQL concatenation, http URLs, credential logging, variable exec commands).',
        params: [
          {
            name: 'path',
            type: 'string',
            description:
              'File or directory path to scan (relative or absolute, must be inside the project).',
          },
        ],
      },
      {
        name: 'security_hotspot_status',
        category: 'Security',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports security-hotspot-scanner state: severity, extensions, pattern types, and per-session counters.',
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
        name: 'severity',
        type: '"warn" | "block"',
        defaultValue: '"warn"',
        description:
          'warn = inject hotspots as additionalContext; block = refuse the mutating tool.',
      },
      {
        name: 'maxFindings',
        type: 'number',
        defaultValue: '10',
        description: 'Maximum hotspots reported per scan.',
      },
      {
        name: 'scanOnChange',
        type: 'string[]',
        defaultValue: '[".js",".jsx",".ts",".tsx",".mjs",".cjs",".py",".java",".go",".rb",".php"]',
        description: 'Only scan files with one of these extensions.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'api-compatibility-gate': {
    version: '0.1.0',
    longDescription:
      'Guards the public API surface: after each write/edit to an entry-point file (index.ts and friends, per entryPointPatterns) it reads the previous version from git, diffs the exported identifiers with regex heuristics, and reports removed exports as breaking changes - warning by default, blocking when configured.',
    tools: [
      {
        name: 'api_compat_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports api-compatibility-gate state: severity, entry-point patterns, and per-session counters.',
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
        name: 'severity',
        type: '"warn" | "block"',
        defaultValue: '"warn"',
        description: 'warn = inject context; block = refuse the mutating tool.',
      },
      {
        name: 'entryPointPatterns',
        type: 'string[]',
        defaultValue: '["**/index.ts","**/index.js","**/src/index.ts","src/index.ts"]',
        description: 'Glob-style patterns for entry-point files to guard.',
      },
      {
        name: 'trackGitHistory',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Read the pre-edit version from git HEAD to compute removed exports.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'dead-code-detector': {
    version: '0.1.0',
    longDescription:
      "Regex-based scan for exported identifiers that appear unused anywhere in the project (dead_code_scan), plus a PostToolUse hook that warns when a just-edited file's new exports look unused. No AST parser is involved, so expect false positives on re-exports and deliberate public API surface.",
    tools: [
      {
        name: 'dead_code_scan',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Scan TypeScript/JavaScript source files for exported symbols that appear unused anywhere in the project.',
        params: [
          { name: 'path', type: 'string', description: 'Directory or file path to scan.' },
          { name: 'depth', type: 'number', description: 'Maximum recursion depth.' },
        ],
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
        name: 'extensions',
        type: 'string[]',
        defaultValue: '[".ts",".tsx",".js",".jsx"]',
        description: 'File extensions to scan.',
      },
      {
        name: 'defaultDepth',
        type: 'number',
        defaultValue: '3',
        description: 'Default recursion depth for scans.',
      },
      {
        name: 'excludeDirs',
        type: 'string[]',
        defaultValue: '["node_modules","dist",".git","coverage"]',
        description: 'Directory names to skip while scanning.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'migration-planner': {
    version: '0.2.0',
    longDescription:
      'Builds evidence-backed dependency or framework migration checklists. migration_plan reads a local package CHANGELOG, extracts breaking changes between two versions, and keeps that deterministic result authoritative. Optional api.llm analysis is returned separately as bounded JSON with risk, additional-step, and verification guidance; invalid or unavailable model output never replaces changelog facts.',
    tools: [
      {
        name: 'migration_plan',
        category: 'Planning',
        mutating: false,
        permission: 'auto',
        summary:
          'Read a package CHANGELOG and produce a migration checklist with breaking changes and recommended steps between two versions.',
        params: [
          {
            name: 'packageName',
            type: 'string',
            description: 'Name of the npm package or framework.',
          },
          { name: 'fromVersion', type: 'string', description: 'Current version, e.g. "1.2.3".' },
          { name: 'toVersion', type: 'string', description: 'Target version, e.g. "2.0.0".' },
          {
            name: 'scope',
            type: 'string',
            description: 'Optional scope describing which parts of the project use the package.',
          },
          {
            name: 'use_llm',
            type: 'boolean',
            description: 'Add evidence-bounded LLM risk analysis for this call.',
          },
        ],
      },
      {
        name: 'migration_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary: 'Reports migration-planner state: counters, config, and last plan.',
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
        name: 'changelogPaths',
        type: 'string[]',
        defaultValue: '["CHANGELOG.md"]',
        description: 'Changelog paths to try; <package> is replaced with the package name.',
      },
      {
        name: 'maxChars',
        type: 'number',
        defaultValue: '100000',
        description: 'Maximum changelog characters to scan.',
      },
      {
        name: 'useLlm',
        type: 'boolean',
        defaultValue: 'false',
        description:
          'Add a separate api.llm risk analysis while preserving deterministic changelog extraction.',
      },
      {
        name: 'maxLlmChars',
        type: 'number',
        defaultValue: '20000',
        description: 'Maximum changelog evidence characters included in an optional LLM request.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "migration-planner": {\n      "useLlm": true,\n      "maxLlmChars": 20000\n    }\n  }\n}\n\nmigration_plan({ packageName: "react", fromVersion: "18.3.1", toVersion: "19.0.0", use_llm: true })',
  },
  'schema-evolution-guard': {
    version: '0.1.0',
    longDescription:
      'Watches schema-related files (Prisma, migration SQL, OpenAPI specs, *schema*.ts) for destructive changes after write/edit: DROP TABLE / DROP COLUMN, NOT NULL added without a default, and newly required fields. Findings are injected as warnings by default, or block the tool when failSeverity is "block".',
    tools: [
      {
        name: 'schema_evolution_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports schema-evolution-guard state: config, file patterns, and per-session counters.',
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
        name: 'failSeverity',
        type: '"warn" | "block"',
        defaultValue: '"warn"',
        description: 'warn = inject additionalContext; block = refuse the mutating tool.',
      },
      {
        name: 'maxFindings',
        type: 'number',
        defaultValue: '5',
        description: 'Maximum destructive findings reported per file.',
      },
      {
        name: 'filePatterns',
        type: 'string[]',
        defaultValue:
          '["*.prisma","*migration*.sql","*openapi*.yaml","*openapi*.json","*schema*.ts"]',
        description: 'Basename patterns that trigger the scan.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
  },
  'semantic-search-indexer': {
    version: '0.1.0',
    longDescription:
      'Builds an in-memory inverted keyword index over project source files (no embeddings, no persistence) and serves ranked search via the semantic_search tool with term-frequency scoring. Results include file path, score, and matching lines; indexing limits for file size, file count, and extensions are configurable.',
    tools: [
      {
        name: 'semantic_search',
        category: 'Search',
        mutating: false,
        permission: 'auto',
        summary:
          'Search project source files with a lightweight keyword index. Returns ranked file paths, TF scores, and matched lines.',
        params: [
          { name: 'query', type: 'string', description: 'Space-separated keywords to search for.' },
          {
            name: 'limit',
            type: 'number',
            description: 'Maximum number of results (defaults to configured defaultLimit).',
          },
          {
            name: 'path',
            type: 'string',
            description: 'Directory or file to search under (defaults to project root).',
          },
        ],
      },
      {
        name: 'semantic_index_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports semantic-search-indexer state: indexed path, file/term counts, and counters.',
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
        name: 'includeExtensions',
        type: 'string[]',
        defaultValue:
          '[".ts",".tsx",".js",".jsx",".mjs",".cjs",".py",".java",".go",".rs",".rb",".php",".cpp",".c",".h",".cs",".swift",".kt",".scala",".sh",".md",".json",".yaml",".yml",".css",".scss",".html"]',
        description: 'Only index files with these extensions. Empty = all files.',
      },
      {
        name: 'excludePatterns',
        type: 'string[]',
        defaultValue:
          '["node_modules","\\\\.git","\\\\.wrongstack","\\\\.temp_files","coverage","dist"]',
        description: 'Regex patterns; matching relative paths are skipped.',
      },
      {
        name: 'maxFileBytes',
        type: 'number',
        defaultValue: '1000000',
        description: 'Files larger than this are skipped.',
      },
      {
        name: 'defaultLimit',
        type: 'number',
        defaultValue: '10',
        description: 'Default number of results per query.',
      },
      {
        name: 'minTokenLength',
        type: 'number',
        defaultValue: '2',
        description: 'Minimum length of an indexed/query token.',
      },
      {
        name: 'maxMatchesPerFile',
        type: 'number',
        defaultValue: '10',
        description: 'Maximum matching lines returned per result.',
      },
      {
        name: 'maxFiles',
        type: 'number',
        defaultValue: '5000',
        description: 'Maximum files to index in one build.',
      },
    ],
    hooks: [],
    apiVersion: '^0.1.10',
  },
  'config-validator': {
    version: '0.1.0',
    longDescription:
      'Parses JSON, JSONC, YAML, and TOML files immediately after they are written or edited and reports syntax errors in the same turn, so broken config never lingers. The checked extensions are configurable and oversized files are skipped.',
    tools: [
      {
        name: 'config_validator_status',
        category: 'Diagnostics',
        mutating: false,
        permission: 'auto',
        summary:
          'Reports config-validator state: watched extensions and counters (files checked, problems found).',
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
        name: 'extensions',
        type: 'string[]',
        defaultValue: '[".json",".jsonc",".yaml",".yml",".toml"]',
        description: 'File extensions to validate (with leading dot).',
      },
      {
        name: 'maxFileBytes',
        type: 'number',
        defaultValue: '1048576',
        description: 'Files larger than this are skipped.',
      },
    ],
    hooks: ['PostToolUse (write|edit)'],
    apiVersion: '^0.1.10',
    example:
      '{\n  "extensions": {\n    "config-validator": {\n      "extensions": [".json", ".jsonc", ".yaml", ".yml", ".toml"]\n    }\n  }\n}',
  },
};
