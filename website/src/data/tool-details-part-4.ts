// Per-tool detail data for the built-in tool detail pages.
// Generated from the real tool definitions in @wrongstack/tools (name, description,
// inputSchema, selection boundaries). Keys match runtime-catalog.ts toolCatalog names.

import type { ToolDetail } from './tool-detail-types';

export const toolDetailsPart4: Record<string, ToolDetail> = {
  'outdated': {
    longDescription:
      'Check for outdated dependencies in the project. Reports current, wanted (semver range), and latest versions available.',
    params: [
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory (default: cwd)',
      },
      {
        name: 'format',
        type: '\'list\' | \'table\'',
        description: 'Output format (default: list)',
      },
      {
        name: 'include_deprecated',
        type: 'boolean',
        description: 'Include deprecated packages (default: false)',
      },
      {
        name: 'check',
        type: 'string',
        description: 'Specific package(s) to check (comma-separated)',
      },
    ],
    notes: [
      'Run periodically or before dependency-related work.',
      'Helps surface packages that may need updates for security or features.',
      'Hits the package registry over HTTP, so it is NOT purely local — flagged as mutating for the confirmation gate.',
    ],
  },
  'logs': {
    longDescription:
      'Read or stream logs from files, Docker containers, or systemd services. Useful for debugging running applications.',
    params: [
      {
        name: 'service',
        type: 'string',
        description: 'Service name for Docker or systemd journal',
      },
      {
        name: 'path',
        type: 'string',
        description: 'Path to log file (alternative to service)',
      },
      {
        name: 'lines',
        type: 'integer',
        description: 'Number of log lines to fetch (default: 100, 0 for all)',
      },
      {
        name: 'stream',
        type: 'boolean',
        description: 'Stream logs continuously (like tail -f) (default: false)',
      },
      {
        name: 'filter',
        type: 'string',
        description: 'Regex pattern to filter log lines',
      },
      {
        name: 'since',
        type: '\'1h\' | \'6h\' | \'24h\' | \'all\'',
        description: 'Only show logs since duration',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory (default: cwd)',
      },
    ],
    notes: [
      'Prefer `path` for local files or `service` for containers/systemd.',
      '`stream: true` = live tail (can be expensive).',
      'Always use `filter` (regex) when possible to reduce noise and token usage.',
    ],
  },
  'document': {
    longDescription:
      'DEPRECATED — use the `auto_doc` tool with `dryRun: true` instead. This tool is a read-only preview stub that returns `skipped` candidates without generating real docstrings.',
    params: [
      {
        name: 'target',
        type: '\'file\' | \'function\' | \'class\' | \'type\' | \'all\'',
        description: 'What to document',
      },
      {
        name: 'path',
        type: 'string',
        description: 'Specific file path to document',
      },
      {
        name: 'files',
        type: 'string',
        description: 'File(s) to process: single path, comma-separated list, or glob',
      },
      {
        name: 'style',
        type: '\'jsdoc\' | \'tsdoc\' | \'block\'',
        description: 'Documentation style (default: jsdoc)',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory (default: cwd)',
      },
    ],
    notes: [
      'Deprecated: prefer `auto_doc` with `dryRun: true` for previewing, or `auto_doc` without dryRun for writing. This tool only lists undocumented symbols with placeholder comments — it does not generate real JSDoc/TSDoc.',
    ],
  },
  'scaffold': {
    longDescription:
      'Generate new files and folder structures from built-in templates or custom definitions. This is the recommended way to bootstrap new packages, components, or modules instead of creating files one by one with `write`.',
    params: [
      {
        name: 'template',
        type: 'string',
        required: true,
        description: 'Template name (npm-package, cli-tool, react-component) or path to template directory',
      },
      {
        name: 'name',
        type: 'string',
        required: true,
        description: 'Project/component name (used in generated files)',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Working directory (default: cwd)',
      },
      {
        name: 'vars',
        type: 'object',
        description: 'Template variables for custom templates',
      },
      {
        name: 'dry_run',
        type: 'boolean',
        description: 'Preview generated files without creating (default: false)',
      },
    ],
    notes: [
      'Use built-in templates when they match your needs (e.g. react-component, npm-package).',
      'Supports `dry_run` so you can preview exactly what will be created.',
      'Has the powerful `fs.write.outside-project` capability — review paths carefully.',
    ],
  },
  'design': {
    longDescription:
      'Browse, load, customize, and enforce curated frontend/mobile UI design kits. Use BEFORE writing UI code to commit to one coherent, modern, responsive, dark/light, accessible design. Actions: "list" (menu), "use" (load+pin a kit for a stack), "foundations" (baseline), "set" (override kit colors/tokens), "materialize" (write the tokens to a real theme file — CSS @theme/OKLCH or native), "verify" (scan UI files for off-palette colors).',
    params: [
      {
        name: 'action',
        type: '\'list\' | \'use\' | \'foundations\' | \'set\' | \'materialize\' | \'verify\'',
        description: 'list = menu; use = load+pin a kit; foundations = baseline; set = override colors/tokens; materialize = write tokens to a theme file; verify = scan UI for off-palette colors. Default: list.',
      },
      {
        name: 'kit',
        type: 'string',
        description: 'Kit id (required for "use"), e.g. "minimal-clarity", "neo-brutalist".',
      },
      {
        name: 'stack',
        type: '\'web\' | \'react-native\' | \'flutter\' | \'swiftui\' | \'compose\'',
        description: 'Target stack — narrows guidance + materialize format. Default: web.',
      },
      {
        name: 'set',
        type: 'object',
        description: 'Token overrides for "set"/"use": { "primary": "oklch(…)", "dark.bg": "#111" }. Bare key = both themes; "light."/"dark." prefix = that theme only. Empty value clears an override.',
      },
      {
        name: 'out',
        type: 'string',
        description: 'Materialize output path (project-relative). Defaults to a per-stack convention.',
      },
      {
        name: 'force',
        type: 'boolean',
        description: 'Materialize: overwrite an existing file (default false — refuses to clobber).',
      },
      {
        name: 'files',
        type: 'string[]',
        description: 'Verify: explicit project-relative files to scan. Default: a bounded UI-file walk.',
      },
    ],
    notes: [
      'Flow: `design {action:"use", kit:"minimal-clarity", stack:"web"}` → optionally `design {action:"set", set:{primary:"oklch(62% 0.2 25)"}}` → `design {action:"materialize"}` to write tokens to disk → implement against them → `design {action:"verify"}`.',
    ],
  },
  'tool_search': {
    longDescription:
      'Search the catalog of available tools by name or description. Use this to discover which tool to use for a task. For the full schema and usage details of a specific tool, use `tool_help` instead.',
    params: [
      {
        name: 'query',
        type: 'string',
        description: 'Search query for tool name or description',
      },
      {
        name: 'tags',
        type: 'string[]',
        description: 'Filter by tags (e.g. "filesystem", "network", "dev")',
      },
      {
        name: 'permission',
        type: '\'auto\' | \'confirm\' | \'deny\'',
        description: 'Filter by required permission level',
      },
      {
        name: 'mutating',
        type: 'boolean',
        description: 'Filter by mutating flag (true=filters that modify, false=read-only)',
      },
      {
        name: 'limit',
        type: 'integer',
        description: 'Maximum results to return (default: 20)',
      },
    ],
    notes: [
      'Use when you need to find the right tool for a job.',
      '`query` searches names and descriptions.',
      'You can filter by `tags` (category), `permission`, or `mutating`.',
    ],
  },
  'tool_use': {
    longDescription:
      'Directly execute any registered tool by its exact name, bypassing normal discovery. This is a powerful meta-tool intended for cases where the agent has a clear plan and knows precisely which tool to invoke.',
    params: [
      {
        name: 'tool',
        type: 'string',
        required: true,
        description: 'The exact registered name of the tool to invoke (e.g. "bash", "read", "codebase-search").',
      },
      {
        name: 'input',
        type: 'object',
        description: 'The input object matching the target tool\'s inputSchema.',
      },
    ],
    notes: [
      'Only use when you are certain of the exact tool name and its expected input shape.',
      'Prefer using the normal tool calling mechanism when possible.',
      'Very useful in batch-tool-use or when orchestrating complex workflows programmatically.',
    ],
  },
  'batch_tool_use': {
    longDescription:
      'Execute a batch of tool calls either sequentially or in parallel. Returns structured results for every call.',
    params: [
      {
        name: 'calls',
        type: 'object[]',
        required: true,
        description: 'Array of tool calls to execute',
      },
      {
        name: 'stop_on_error',
        type: 'boolean',
        description: 'Stop execution on first error (default: false)',
      },
      {
        name: 'parallel',
        type: 'boolean',
        description: 'Execute calls in parallel (default: true)',
      },
    ],
    notes: [
      'Useful when you have a clear list of independent operations to perform.',
      '`parallel: true` (default) runs them concurrently for speed.',
      '`stop_on_error: true` makes it fail fast on the first error.',
    ],
  },
  'tool_help': {
    longDescription:
      'Get detailed help for a specific tool, including its full input schema and usage guidance. If you do not know which tool to use, search with `tool_search` first, then call this with the tool name.',
    params: [
      {
        name: 'tool',
        type: 'string',
        description: 'Specific tool name to get detailed help for. Omit to get a list of all tools.',
      },
      {
        name: 'format',
        type: '\'short\' | \'full\' | \'markdown\'',
        description: 'Level of detail: "short" (summary), "full" (with full schema), "markdown" (human readable).',
      },
      {
        name: 'include_examples',
        type: 'boolean',
        description: 'Whether to include example usage in the response.',
      },
    ],
    notes: [
      'Call with a specific `tool` name when you want the full schema and current usageHint.',
      'Omit `tool` to get an overview of all available tools.',
      'Different `format` options give you different levels of detail.',
    ],
  },
  'codebase-index': {
    longDescription:
      'Build or incrementally update the project-wide symbol index. This powers fast codebase search and understanding. By default it only processes files that have changed since the last indexing run.',
    params: [
      {
        name: 'force',
        type: 'boolean',
        description: 'Force a full reindex — clears the index first and reindexes all files.',
      },
      {
        name: 'langs',
        type: 'string[]',
        description: 'Limit reindex to specific languages: ts, tsx, js, jsx, go, py, rs',
      },
    ],
    notes: [
      'First run (or after major changes): consider `force: true` for a clean rebuild.',
      'Normal usage: call without arguments for fast incremental updates.',
      'Use `langs` to restrict to specific languages if you only care about certain parts of the project.',
    ],
  },
  'codebase-search': {
    longDescription:
      'Search code symbols using a fast SQLite+BM25 index, with optional LSP fallback. Much more powerful and structured than raw `grep` for finding code by name or concept. Set `preferLsp: true` for live precision when the LSP plugin is active (supersedes codebase-lsp-search).',
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search query — searches symbol names, signatures, and doc comments',
      },
      {
        name: 'kind',
        type: 'string',
        description: 'Filter by symbol kind: class, function, interface, method, const, let, var, property, type, enum',
      },
      {
        name: 'lang',
        type: 'string',
        description: 'Filter by language: ts, tsx, js, jsx',
      },
      {
        name: 'lspKind',
        type: 'integer',
        description: 'Filter by LSP SymbolKind number (e.g. 5=Class, 12=Function, 11=Interface, 10=Enum)',
      },
      {
        name: 'file',
        type: 'string',
        description: 'Filter to files matching this path substring',
      },
      {
        name: 'limit',
        type: 'integer',
        description: 'Maximum results to return (default 20, max 100)',
      },
      {
        name: 'preferLsp',
        type: 'boolean',
        description: 'Prefer live LSP results over the index. Index-only when the LSP plugin is not active. When the LSP plugin is active and this is true, results come from live workspaceSymbol queries.',
      },
    ],
    notes: [
      'Use when you need to find where something is defined or used by name.',
      '`kind` filter is very useful (e.g. only functions or only interfaces).',
      'Combine with `file` filter to scope to a specific directory or module.',
    ],
  },
  'codebase-stats': {
    longDescription:
      'Return health and statistics about the current symbol index (total symbols, files, language/kind breakdown, size, last update). Useful to decide whether to re-index.',
    params: [],
    notes: [
      'Use to see if the index is up-to-date or needs a refresh.',
      'No arguments required.',
      'Helps avoid wasting tokens on searches against a stale index.',
    ],
  },
  'set_working_dir': {
    longDescription:
      'Change the current working directory for all subsequent file operations. The new directory must be inside the project root. Use this to navigate between subdirectories when working on files in different parts of the project.',
    params: [
      {
        name: 'path',
        type: 'string',
        description: 'Directory to navigate to. Can be relative (to projectRoot) or absolute. If omitted, returns the current working directory without changing it.',
      },
    ],
    notes: [
      'Change the working directory so relative paths in subsequent tool calls resolve from a different directory. Pass `path` to set a new directory, or omit to query the current one.',
    ],
  },
  'dead-code-scan': {
    longDescription:
      'Scan TypeScript/JavaScript source files for exported symbols that appear unused anywhere in the project. Uses the codebase-index reference graph (symbols + import/call/type-ref edges) to compute transitive reachability from package.json entry points (bin, main, exports, types, plus convention src/index.ts/src/main.ts). Requires a built codebase-index — run `codebase-index` first if you get no results.',
    params: [
      {
        name: 'projectRoot',
        type: 'string',
        description: 'Project root (defaults to ctx.projectRoot).',
      },
      {
        name: 'indexDir',
        type: 'string',
        description: 'Override the index directory if the default is not desired.',
      },
      {
        name: 'entryPoints',
        type: 'string[]',
        description: 'Additional entry-point file paths to seed the reachability scan. Auto-detected from package.json by default.',
      },
    ],
    doNotUseWhen: [
      'No codebase-index exists yet — run `codebase-index` first.',
      'The project uses only dynamic imports — dynamic imports are invisible to the static reference graph and will produce false positives.',
    ],
    useInstead: [
      'Use `codebase-search` to find symbols by name when you do not need reachability analysis.',
    ],
    notes: [
      'Read-only (permission: auto, mutating: false). Results are best-effort — dynamic imports, string-based require, and bare `export { X }` re-exports without a local function wrapper create no reference edge and may appear as false dead-code positives.',
      'Entry-point discovery handles root + workspace packages, including pnpm-workspace.yaml packages block and build-output/bin entries mapped back to source.',
    ],
  },
};
