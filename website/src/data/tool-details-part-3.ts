// Per-tool detail data for the built-in tool detail pages.
// Generated from the real tool definitions in @wrongstack/tools (name, description,
// inputSchema, selection boundaries). Keys match runtime-catalog.ts toolCatalog names.

import type { ToolDetail } from './tool-detail-types';

export const toolDetailsPart3: Record<string, ToolDetail> = {
  task: {
    longDescription:
      'Manage session-persistent structured work items with dependencies, types, and priorities. Unlike `todo` (flat, tactical), `task` supports typed work (feature/bugfix/refactor/etc.), dependencies between items, priority ranking, and agent assignment. Tasks are written to disk and survive session resumes.',
    params: [
      {
        name: 'action',
        type: "'replace' | 'add' | 'status' | 'show' | 'promote' | 'planify'",
        required: true,
        description:
          'replace = set full list, add = append, status = update task status, show = view only, promote = convert task to todos, planify = convert task to plan item.',
      },
      {
        name: 'tasks',
        type: 'object[]',
        description: 'Complete task list. Replaces previous list entirely.',
      },
      {
        name: 'task',
        type: 'object',
        description: 'Single task to append (id/createdAt/updatedAt auto-generated).',
      },
      {
        name: 'id',
        type: 'string',
        description: 'Task id for action=status or target for action=promote.',
      },
      {
        name: 'status',
        type: "'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed'",
        description: 'New status for action=status.',
      },
      {
        name: 'target',
        type: 'string',
        description:
          'Target task identifier (id, 1-based index, or title substring) for action=promote.',
      },
      {
        name: 'subtasks',
        type: 'string[]',
        description: 'Optional subtask titles for action=promote. Each becomes a pending todo.',
      },
      {
        name: 'scope',
        type: "'session' | 'project'",
        description:
          'Storage scope: "session" (default, isolated to this session) or "project" (shared across all sessions for this project).',
      },
    ],
    notes: [
      '`action: "replace"` — set the complete task list (tasks ordered by priority)',
      '`action: "status"` — update a task\'s status (e.g. pending→in_progress, in_progress→completed)',
    ],
  },
  git: {
    longDescription:
      'Safe wrapper around common git operations. Supports status, log, diff, commit, branch, checkout, stash, push, pull, fetch, reset, worktree, etc. This is the preferred way to interact with git instead of using the raw `bash` or `exec` tools.',
    params: [
      {
        name: 'command',
        type: "'status' | 'log' | 'diff' | 'commit' | 'branch' | 'checkout' | 'stash' | 'push' | 'pull' | 'fetch' | 'reset' | 'worktree'",
        required: true,
        description: 'Git subcommand',
      },
      {
        name: 'files',
        type: 'string',
        description:
          'File(s) for status/diff: single path, comma-separated list, or "**/*.ts" glob',
      },
      {
        name: 'message',
        type: 'string',
        description: 'Commit message (required for commit)',
      },
      {
        name: 'branch',
        type: 'string',
        description: 'Branch name for checkout/branch',
      },
      {
        name: 'format',
        type: "'short' | 'oneline' | 'stat' | 'graph'",
        description: 'Log format (default: short)',
      },
      {
        name: 'limit',
        type: 'integer',
        description: 'Limit for log (default: 20)',
      },
      {
        name: 'dry_run',
        type: 'boolean',
        description: 'For commit: show what would be committed',
      },
      {
        name: 'worktreeAction',
        type: "'list' | 'add' | 'remove' | 'prune'",
        description: 'Worktree action: list, add, remove, prune',
      },
      {
        name: 'worktreePath',
        type: 'string',
        description: 'Path for worktree add/remove (e.g. "../wt-feature-xyz")',
      },
      {
        name: 'newBranch',
        type: 'boolean',
        description: 'Create new branch when adding worktree',
      },
      {
        name: 'force',
        type: 'boolean',
        description: 'Force operation (e.g. worktree remove --force)',
      },
    ],
    notes: [
      '`command`: one of the supported subcommands (status, log, diff, commit, etc.)',
      'Use `message` only for commit operations.',
      'Use `files` array for operations that take paths (status, diff, add, etc.).',
    ],
  },
  patch: {
    longDescription:
      'Apply a unified diff (patch) to the project. This is the correct tool when you have a diff that needs to be applied precisely, including handling of rejects.',
    params: [
      {
        name: 'patch',
        type: 'string',
        required: true,
        description: 'Unified diff patch content',
      },
      {
        name: 'directory',
        type: 'string',
        description: 'Root directory for patch (default: cwd)',
      },
      {
        name: 'strip',
        type: 'integer',
        description: 'Strip leading path components (default: 1)',
      },
      {
        name: 'dry_run',
        type: 'boolean',
        description: 'Preview without applying',
      },
    ],
    doNotUseWhen: ['you do not already have a unified diff or only need one precise replacement.'],
    useInstead: ['edit'],
    notes: [
      'Use `dry_run: true` to see what would happen without modifying files.',
      'On failure it creates .rej and .orig files for manual review.',
    ],
  },
  json: {
    longDescription:
      'Parse, pretty-print, query, validate, transform, and merge JSON/JSON5/YAML. Use `action` to select the operation: parse (default), query, validate, transform, or merge.',
    params: [
      {
        name: 'action',
        type: "'parse' | 'query' | 'validate' | 'transform' | 'merge'",
        description:
          'Operation (default: parse). parse=read/pretty-print, query=JMESPath, validate=schema, transform=chained queries, merge=deep merge.',
      },
      {
        name: 'file',
        type: 'string',
        description: 'Path to JSON/JSON5/YAML file (parse/query/validate)',
      },
      {
        name: 'data',
        type: 'string',
        description: 'JSON/JSON5/YAML string (parse/query/validate, alternative to file)',
      },
      {
        name: 'format',
        type: "'json' | 'json5' | 'yaml'",
        description: 'Output format for parse/query/transform (default: json)',
      },
      {
        name: 'query',
        type: 'string',
        description: 'JMESPath-like query expression (query action)',
      },
      {
        name: 'transforms',
        type: 'string[]',
        description: 'Ordered JMESPath query strings (transform action)',
      },
      {
        name: 'schema',
        type: 'object',
        description: 'JSON Schema to validate against (validate action)',
      },
      {
        name: 'base',
        type: 'object',
        description: 'Base JSON object (merge action)',
      },
      {
        name: 'patch',
        type: 'object',
        description: 'Patch JSON object to merge in (merge action)',
      },
      {
        name: 'conflictResolution',
        type: "'prefer-base' | 'prefer-patch'",
        description: 'Merge conflict resolution (default: prefer-patch)',
      },
      {
        name: 'validate',
        type: 'boolean',
        description: 'Validate syntax only, no output (parse action, default: false)',
      },
    ],
    notes: [
      '`action: "parse"` (default): read/pretty-print/convert JSON, JSON5, or YAML from `file` or `data`.',
      '`action: "query"`: JMESPath-like query (`a.b[0].c`, `items[*].name`, filters, functions).',
      '`action: "validate"`: validate data against a JSON Schema (`schema` param).',
    ],
  },
  diff: {
    longDescription:
      'Show file content with line numbers, staged/working-tree diffs via git, or commit/branch diffs. A safer and more structured alternative to raw `git diff` via shell.',
    params: [
      {
        name: 'path',
        type: 'string',
        description: 'Working directory for the diff operation (defaults to project root).',
      },
      {
        name: 'files',
        type: 'string',
        description: 'Files or globs to diff (e.g. "src/**/*.ts" or comma-separated list).',
      },
      {
        name: 'a',
        type: 'string',
        description: 'First ref/commit/branch for git diff (e.g. HEAD, main, a commit hash).',
      },
      {
        name: 'b',
        type: 'string',
        description: 'Second ref/commit/branch for git diff.',
      },
      {
        name: 'staged',
        type: 'boolean',
        description: 'If true, only show changes that are staged in git.',
      },
      {
        name: 'mode',
        type: "'unified' | 'side-by-side' | 'stat'",
        description:
          'Output format for the git-diff path. "unified" is default; "stat" shows a summary only; "side-by-side" is not supported and falls back to unified.',
      },
      {
        name: 'context',
        type: 'integer',
        description:
          'Number of context lines for git unified diffs (default: 3, passed as -U<n>). Ignored by the `files`-only dump path.',
      },
    ],
    notes: [
      '`files` + no `a`/`b` → show file content with line numbers (NOT a unified diff; no +/- prefixes).',
      '`a` and/or `b` → git-style commit/branch diff (unified format, real +/- prefixes).',
      '`staged: true` → only show staged changes.',
    ],
  },
  tree: {
    longDescription:
      'Display a directory tree of the project (or a subpath). This is the recommended way to explore the high-level structure of a codebase before reading specific files.',
    params: [
      {
        name: 'path',
        type: 'string',
        description: 'Root directory to display the tree from (defaults to project root).',
      },
      {
        name: 'depth',
        type: 'integer',
        description: 'Maximum directory depth to traverse (default 3, use 0 for unlimited).',
      },
      {
        name: 'glob',
        type: 'string',
        description: 'Only include files matching this glob pattern.',
      },
      {
        name: 'exclude',
        type: 'string[]',
        description: 'List of directory names to completely ignore.',
      },
      {
        name: 'show_files',
        type: 'boolean',
        description: 'Whether to show individual files (default true).',
      },
      {
        name: 'show_dirs',
        type: 'boolean',
        description: 'Whether to show directories (default true).',
      },
      {
        name: 'show_hidden',
        type: 'boolean',
        description: 'Show hidden files starting with . (default: false)',
      },
    ],
    notes: [
      'Call early when working with an unfamiliar project or module.',
      'Tune `depth` (default 3) and use `glob`/`exclude` to focus the view.',
      'Prefer this over raw `bash find` or `glob` + manual reading when you need a quick structural overview.',
    ],
  },
  lint: {
    longDescription:
      'Run the project linter (primarily Biome in this repo). Detects style violations, potential bugs, and formatting issues.',
    params: [
      {
        name: 'files',
        type: 'string',
        description:
          'Files/patterns: single path, comma-separated list, or glob (e.g. "src/**/*.ts")',
      },
      {
        name: 'fix',
        type: 'boolean',
        description: 'Auto-fix fixable issues (default: false)',
      },
      {
        name: 'linter',
        type: "'biome' | 'eslint' | 'tslint' | 'auto'",
        description: 'Linter to use (default: auto-detect)',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory (default: cwd)',
      },
    ],
    notes: [
      '`fix: true` will automatically correct what it can.',
      'Target specific files or globs when you only want to check part of the project.',
    ],
  },
  format: {
    longDescription:
      'Format source files according to project style (Biome). Can also run in check-only mode.',
    params: [
      {
        name: 'files',
        type: 'string',
        description: 'Files/patterns: single path, comma-separated list, or glob',
      },
      {
        name: 'fixer',
        type: "'biome' | 'prettier' | 'auto'",
        description: 'Formatter to use (default: auto-detect)',
      },
      {
        name: 'check',
        type: 'boolean',
        description: 'Verify only, do not modify files (default: false)',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory (default: cwd)',
      },
    ],
    notes: [
      'Use on changed files before committing.',
      '`check: true` verifies formatting without making changes (useful in CI-like flows).',
    ],
  },
  typecheck: {
    longDescription:
      "Run the project's TypeScript type checker (`tsc --noEmit` or equivalent). Essential for verifying type safety before making changes or committing.",
    params: [
      {
        name: 'project',
        type: 'string',
        description: 'Path to tsconfig.json (default: auto-detect)',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory (default: cwd)',
      },
      {
        name: 'strict',
        type: 'boolean',
        description: 'Add --strict flag for maximum type checking (default: false)',
      },
      {
        name: 'all',
        type: 'boolean',
        description:
          'Type-check all workspace packages (pnpm workspaces run `pnpm -r exec tsc --noEmit`; other setups run a single `tsc --noEmit` at cwd) (default: false)',
      },
    ],
    notes: [
      'Use this to catch type errors early.',
      'In monorepos, `all: true` will check every package.',
      'This is one of the most important quality gates in this project.',
    ],
  },
  test: {
    longDescription:
      "Execute the project's test suite. This is one of the most critical tools for validating that your changes are correct.",
    params: [
      {
        name: 'files',
        type: 'string',
        description: 'Test files: single path, comma-separated list, or glob (e.g. "**/*.test.ts")',
      },
      {
        name: 'runner',
        type: "'vitest' | 'jest' | 'mocha' | 'auto'",
        description: 'Test runner (default: auto-detect)',
      },
      {
        name: 'watch',
        type: 'boolean',
        description: 'Run in watch mode (default: false)',
      },
      {
        name: 'coverage',
        type: 'boolean',
        description: 'Generate coverage report (default: false)',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory (default: cwd)',
      },
      {
        name: 'grep',
        type: 'string',
        description: 'Filter tests by name pattern (default: none)',
      },
      {
        name: 'timeout',
        type: 'integer',
        description: 'Test timeout in ms (default: 30000)',
      },
      {
        name: 'verbose',
        type: 'boolean',
        description:
          'Per-test verbose reporter output (default: false — the summary reporter is used; full output is always saved to a log file referenced in the result)',
      },
    ],
    notes: [
      'Use `files` or `grep` to run only relevant tests during development.',
      '`coverage: true` is useful when working on critical paths.',
    ],
  },
  language_info: {
    longDescription:
      'Detect language workspaces and preview predefined language-specific command plans without executing them.',
    params: [
      {
        name: 'action',
        type: "'detect' | 'plan' | 'capabilities'",
        required: true,
        description: 'Read-only action to perform.',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Directory inside the project to inspect.',
      },
      {
        name: 'target',
        type: 'string',
        description: 'Optional target file used for workspace selection.',
      },
      {
        name: 'language',
        type: "'typescript' | 'javascript' | 'go' | 'rust' | 'php' | 'csharp' | 'python' | 'java' | 'ruby' | 'c' | 'cpp' | 'swift' | 'dart' | 'elixir' | 'deno' | 'shell'",
        description: 'Optional language profile filter.',
      },
      {
        name: 'workspace',
        type: 'string',
        description: 'Workspace id or root returned by detect.',
      },
      {
        name: 'operation',
        type: "'syntax' | 'semantic' | 'lint' | 'format-check' | 'format-write' | 'test-compile' | 'test' | 'build' | 'run' | 'debug-compile' | 'debug-test' | 'debug-runtime' | 'debug-race' | 'package-install' | 'package-add' | 'package-remove' | 'package-update' | 'package-audit' | 'package-outdated'",
        description: 'Operation to preview when action=plan.',
      },
      {
        name: 'mode',
        type: "'fast' | 'standard' | 'thorough'",
        description: 'Planning mode.',
      },
      {
        name: 'options',
        type: 'object',
      },
    ],
    doNotUseWhen: ['You need to execute a compiler, test runner, formatter, or package manager.'],
    useInstead: ['exec', 'typecheck', 'lint', 'format', 'test', 'install'],
    notes: [
      'Use `detect` to find TypeScript/JavaScript, Go, Rust, PHP, and C# workspaces. Use `plan` to obtain an exact, validated argv plan before choosing an execution tool.',
    ],
  },
  language: {
    longDescription:
      'Execute predefined language-specific checks, linters, formatters, tests, builds, and debugging evidence.',
    params: [
      {
        name: 'action',
        type: "'check' | 'lint' | 'format' | 'test' | 'build' | 'debug'",
        required: true,
        description: 'Language operation to execute.',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Directory inside the project.',
      },
      {
        name: 'target',
        type: 'string',
        description: 'Optional target file for workspace selection.',
      },
      {
        name: 'language',
        type: "'typescript' | 'javascript' | 'go' | 'rust' | 'php' | 'csharp' | 'python' | 'java' | 'ruby' | 'c' | 'cpp' | 'swift' | 'dart' | 'elixir' | 'deno' | 'shell'",
        description: 'Optional language filter.',
      },
      {
        name: 'workspace',
        type: 'string',
        description: 'Detected workspace id or root.',
      },
      {
        name: 'mode',
        type: "'fast' | 'standard' | 'thorough'",
      },
      {
        name: 'check',
        type: "'syntax' | 'semantic' | 'all'",
      },
      {
        name: 'formatCheck',
        type: 'boolean',
        description: 'Verify formatting without writing (default true).',
      },
      {
        name: 'filter',
        type: 'string',
        description: 'Validated test/debug filter passed to profile adapters.',
      },
      {
        name: 'coverage',
        type: 'boolean',
      },
      {
        name: 'noRun',
        type: 'boolean',
        description: 'Compile tests without running when supported.',
      },
      {
        name: 'debug',
        type: "'compile' | 'test' | 'runtime' | 'race'",
      },
    ],
    doNotUseWhen: ['You only need workspace detection/planning, or need to modify dependencies.'],
    useInstead: ['language_info', 'install', 'audit', 'outdated'],
    notes: [
      'Use this instead of constructing compiler or test commands manually. The tool detects the workspace, builds an allowlisted argv plan, revalidates it, executes without a shell, and returns normalized diagnostics.',
    ],
  },
  language_package: {
    longDescription:
      'Restore, mutate, audit, or report outdated packages via predefined ecosystem-specific plans.',
    params: [
      {
        name: 'operation',
        type: "'install' | 'add' | 'remove' | 'update' | 'audit' | 'outdated'",
        required: true,
        description: 'Package management operation to perform.',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Directory inside the project.',
      },
      {
        name: 'language',
        type: "'typescript' | 'javascript' | 'go' | 'rust' | 'php' | 'csharp' | 'python' | 'java' | 'ruby' | 'c' | 'cpp' | 'swift' | 'dart' | 'elixir' | 'deno' | 'shell'",
        description: 'Optional language profile filter.',
      },
      {
        name: 'workspace',
        type: 'string',
        description: 'Detected workspace id or root.',
      },
      {
        name: 'names',
        type: 'string[]',
        description:
          'Validated package names. Required for add/remove/update; optional for install.',
      },
      {
        name: 'scope',
        type: "'runtime' | 'development' | 'optional'",
        description: 'Where to record the dependency (add/update).',
      },
      {
        name: 'dryRun',
        type: 'boolean',
        description: 'Preview the install without modifying the workspace.',
      },
      {
        name: 'allowScripts',
        type: 'boolean',
        description:
          'Opt in to running package lifecycle scripts (preinstall/install/postinstall). Default false.',
      },
    ],
    doNotUseWhen: [
      'You only need to inspect or plan, or need to compile/test/lint without touching dependencies.',
    ],
    useInstead: ['language_info', 'language', 'install', 'audit', 'outdated'],
    notes: [
      'Use this instead of the legacy `install`/`audit`/`outdated` tools. The tool detects the workspace, builds an allowlisted argv plan with lifecycle scripts disabled, runs it, and records manifest/lockfile changes.',
    ],
  },
  install: {
    longDescription:
      'Install, update or manage packages using the detected package manager (pnpm/npm/yarn). Strongly preferred over raw shell commands for dependency management because it is structured and safer.',
    params: [
      {
        name: 'packages',
        type: 'string',
        description:
          'Package(s) to install: single name, comma-separated list, or empty for all deps',
      },
      {
        name: 'save',
        type: "'dependency' | 'dev' | 'optional'",
        description:
          'Where to save the package(s): "dependency", "devDependencies", or "optionalDependencies".',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory for the install command (must stay inside project).',
      },
      {
        name: 'dry_run',
        type: 'boolean',
        description:
          'If true, show what would be installed without actually modifying package.json or node_modules.',
      },
      {
        name: 'global',
        type: 'boolean',
        description: 'Whether to perform a global install (use with caution).',
      },
      {
        name: 'lifecycleScripts',
        type: 'boolean',
        description:
          'Opt in to running package lifecycle scripts (preinstall / install / postinstall / prepare / …). Default: false — installs pass --ignore-scripts so a malicious package cannot execute arbitrary code at install time. Set true to opt back in to the legacy npm/pnpm/yarn default.',
      },
    ],
    notes: [
      'Empty `packages` → normal `install` (respects lockfile).',
      'Provide names → adds/updates specific packages.',
      '`dry_run: true` for safe preview.',
    ],
  },
  audit: {
    longDescription:
      'Run a security audit against project dependencies (using pnpm/npm audit). Reports known vulnerabilities with severity.',
    params: [
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory (default: cwd)',
      },
      {
        name: 'level',
        type: "'low' | 'moderate' | 'high' | 'critical'",
        description: 'Minimum severity level to report',
      },
      {
        name: 'fix',
        type: 'boolean',
        description:
          'Deprecated and rejected — this tool is read-only and never modifies dependencies. Use `install` (or `language_package`) to remediate vulnerabilities.',
      },
    ],
    notes: [
      'Run regularly and especially before any release.',
      'Use `level` to focus on high/critical issues.',
      'This tool is read-only: to remediate, use `install` (or `language_package`) to upgrade the affected packages.',
    ],
  },
};
