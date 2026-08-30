/**
 * Shared tool icon mapping for all WrongStack UIs (WebUI, TUI, REPL).
 *
 * Each UI renders icons using its own library:
 * - WebUI: lucide-react
 * - TUI: ink icons or text characters
 * - REPL: unicode characters or ASCII art
 *
 * This module exports the canonical tool → icon-name mapping.
 * Add new tools here, never hardcode icon names in UI components.
 */

/**
 * Icon identifiers — each UI maps these to its own icon library.
 * Using a common set of identifiers ensures consistency across all surfaces.
 */
export type ToolIconId =
  | 'file' // read, write — document/file operations
  | 'edit' // edit, patch — modifying files
  | 'search' // grep, search — searching content
  | 'folder' // glob — file discovery
  | 'terminal' // bash, exec — shell commands
  | 'web' // fetch — HTTP requests
  | 'git' // git — version control
  | 'tree' // tree — directory structure
  | 'code' // lint, format, typecheck — code quality
  | 'test' // test — testing
  | 'package' // install, audit, outdated — package management
  | 'document' // document — documentation
  | 'scaffold' // scaffold — project generation
  | 'todo' // todo — task tracking
  | 'plan' // plan — planning
  | 'task' // task — structured work items
  | 'meta' // tool-use, batch-tool-use, tool-search, tool-help — meta tools
  | 'index' // codebase-index, codebase-search, codebase-stats — code indexing
  | 'json' // json — JSON operations
  | 'diff' // diff — comparing changes
  | 'logs' // logs — log viewing
  | 'settings' // set-working-dir — configuration
  | 'brain' // AI/agent reasoning
  | 'fallback'; // unknown tool — fallback icon

/**
 * Canonical mapping of WrongStack tool names to icon identifiers.
 * Coverage: shared core tool names + common aliases. Browser-specific tools
 * use their surface-owned icon mappings.
 */
export const TOOL_ICON_MAP: Record<string, ToolIconId> = {
  // File operations
  read: 'file',
  write: 'file',
  create: 'file',
  view_file: 'file',
  write_to_file: 'file',

  // File modification
  edit: 'edit',
  patch: 'edit',
  replace: 'edit',
  replace_file_content: 'edit',

  // Content search
  grep: 'search',
  search: 'search',
  grep_search: 'search',

  // File discovery
  glob: 'folder',
  find_by_name: 'folder',
  find_files: 'folder',

  // Shell/command execution
  bash: 'terminal',
  exec: 'terminal',
  pwsh: 'terminal',
  powershell: 'terminal',
  run: 'terminal',
  command: 'terminal',
  shell: 'terminal',
  run_command: 'terminal',

  // Network
  fetch: 'web',
  curl: 'web',
  http: 'web',
  request: 'web',
  read_url_content: 'web',
  search_web: 'web',
  web_search: 'web',

  // Version control
  git: 'git',

  // Directory structure
  tree: 'tree',
  ls: 'tree',
  list: 'tree',
  list_dir: 'tree',
  list_directory: 'tree',

  // Code quality
  lint: 'code',
  format: 'code',
  typecheck: 'code',
  language_info: 'code',
  language: 'code',
  language_package: 'package',

  // Testing
  test: 'test',
  tests: 'test',
  e2e_plan: 'test',

  // Package management
  install: 'package',
  uninstall: 'package',
  audit: 'package',
  outdated: 'package',
  npm: 'package',
  pnpm: 'package',
  yarn: 'package',

  // Documentation
  document: 'document',
  doc: 'document',
  jsdoc: 'document',

  // Project scaffolding
  scaffold: 'scaffold',
  generate: 'scaffold',
  template: 'scaffold',

  // Task management
  todo: 'todo',
  todos: 'todo',
  // After-task suggestions — same family as the todo board, so it reuses the
  // icon rather than widening ToolIconId (every UI maps that union by hand).
  nextsteps: 'todo',

  // Planning
  plan: 'plan',
  planning: 'plan',

  // Structured tasks
  task: 'task',
  tasks: 'task',
  kanban: 'task',
  board: 'task',

  // Meta/tools
  'tool-use': 'meta',
  'batch-tool-use': 'meta',
  'tool-search': 'meta',
  'tool-help': 'meta',
  tool_use: 'meta',
  batch_tool_use: 'meta',
  tool_search: 'meta',
  tool_help: 'meta',

  // Code indexing
  'codebase-index': 'index',
  'codebase-search': 'index',
  'codebase-stats': 'index',
  'codebase-incoming-calls': 'index',
  'codebase-outgoing-calls': 'index',
  'codebase-invariant-check': 'index',
  'dead-code-scan': 'index',
  codebase_index: 'index',
  codebase_search: 'index',
  codebase_stats: 'index',
  codebase_incoming_calls: 'index',
  codebase_outgoing_calls: 'index',
  codebase_invariant_check: 'index',
  dead_code_scan: 'index',

  // Data
  json: 'json',
  parse: 'json',
  query: 'json',

  // Comparison
  diff: 'diff',
  compare: 'diff',

  // Logs
  logs: 'logs',
  log: 'logs',

  // Configuration
  'set-working-dir': 'settings',
  set_working_dir: 'settings',
  cwd: 'settings',
  cd: 'settings',

  // AI/Agent
  think: 'brain',
  reason: 'brain',
  analyze: 'brain',
  reasoning: 'brain',
  invoke_subagent: 'brain',
  define_subagent: 'brain',
  manage_subagents: 'brain',
  ask_question: 'document',
  generate_image: 'scaffold',
  schedule: 'settings',

  // Language intelligence
  lsp_diagnostics: 'code',
  lsp_definition: 'search',
  lsp_completion: 'code',
  lsp_rename: 'edit',
  'codebase-lsp-search': 'index',
};

/**
 * Get the icon identifier for a tool name.
 * Returns 'fallback' for unknown tools.
 */
export function getToolIcon(toolName: string): ToolIconId {
  return TOOL_ICON_MAP[toolName.toLowerCase()] ?? 'fallback';
}

/**
 * Icon configuration including color for rendering.
 */
export interface ToolIconConfig {
  icon: ToolIconId;
  /** CSS color string, e.g. '#6366f1' or 'var(--tool-file)' */
  color: string;
}

/**
 * Icon configurations — icon id -> { icon, color }.
 * Each UI applies its own icon library (lucide-react, ink, unicode, etc.)
 * but uses these canonical color values.
 */
export const TOOL_ICON_CONFIG: Record<ToolIconId, ToolIconConfig> = {
  file: { icon: 'file', color: '#6366f1' }, // indigo
  edit: { icon: 'edit', color: '#f59e0b' }, // amber
  search: { icon: 'search', color: '#10b981' }, // emerald
  folder: { icon: 'folder', color: '#8b5cf6' }, // violet
  terminal: { icon: 'terminal', color: '#fb923c' }, // orange
  web: { icon: 'web', color: '#06b6d4' }, // cyan
  git: { icon: 'git', color: '#f97316' }, // orange
  tree: { icon: 'tree', color: '#22c55e' }, // green
  code: { icon: 'code', color: '#3b82f6' }, // blue
  test: { icon: 'test', color: '#84cc16' }, // lime
  package: { icon: 'package', color: '#ec4899' }, // pink
  document: { icon: 'document', color: '#14b8a6' }, // teal
  scaffold: { icon: 'scaffold', color: '#f43f5e' }, // rose
  todo: { icon: 'todo', color: '#a855f7' }, // purple
  plan: { icon: 'plan', color: '#7c3aed' }, // violet-dark
  task: { icon: 'task', color: '#db2777' }, // pink-dark
  meta: { icon: 'meta', color: '#6b7280' }, // gray
  index: { icon: 'index', color: '#0ea5e9' }, // sky
  json: { icon: 'json', color: '#fbbf24' }, // yellow
  diff: { icon: 'diff', color: '#a3e635' }, // lime-light
  logs: { icon: 'logs', color: '#78716c' }, // stone
  settings: { icon: 'settings', color: '#64748b' }, // slate
  brain: { icon: 'brain', color: '#d946ef' }, // fuchsia
  fallback: { icon: 'fallback', color: '#9ca3af' }, // gray-light
};

/**
 * Default fallback icon for unknown tools.
 */
export const FALLBACK_ICON: ToolIconId = 'fallback';
