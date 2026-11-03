// Canonical, surface-agnostic per-tool icon identity + color.
//
// This is PURE DATA (no node imports) so it is safe to import from the browser
// (WebUI) as well as the TUI. Each surface maps a `ToolIconId` to its own
// rendering primitive — the WebUI to a lucide-react component (`tool-icon.ts`),
// the TUI to a unicode glyph (`tool-glyph.ts`) — and pulls the shared color
// from `TOOL_ICON_CONFIG` so both stay in lockstep.
//
// Add a new tool by giving it an entry in `TOOL_ICON_MAP` (name → id). The id
// must be one of the `ToolIconId` union members below; every id already has a
// color, a lucide component, and a glyph.

/** The closed set of visual identities a tool can map to. */
export type ToolIconId =
  | 'file'
  | 'edit'
  | 'search'
  | 'folder'
  | 'terminal'
  | 'web'
  | 'git'
  | 'tree'
  | 'code'
  | 'test'
  | 'package'
  | 'document'
  | 'scaffold'
  | 'todo'
  | 'plan'
  | 'task'
  | 'meta'
  | 'index'
  | 'json'
  | 'diff'
  | 'logs'
  | 'settings'
  | 'brain'
  | 'fallback';

/** Canonical hex color per icon id — the single source both surfaces read. */
const TOOL_COLORS: Record<ToolIconId, { color: string }> = {
  file: { color: '#60a5fa' }, // blue
  edit: { color: '#fbbf24' }, // amber
  search: { color: '#a78bfa' }, // violet
  folder: { color: '#38bdf8' }, // sky
  terminal: { color: '#67e8f9' }, // cyan-light
  web: { color: '#34d399' }, // emerald
  git: { color: '#a3e635' }, // lime
  tree: { color: '#22d3ee' }, // cyan
  code: { color: '#818cf8' }, // indigo
  test: { color: '#4ade80' }, // green
  package: { color: '#f472b6' }, // pink
  document: { color: '#94a3b8' }, // slate
  scaffold: { color: '#c084fc' }, // purple
  todo: { color: '#facc15' }, // yellow
  plan: { color: '#2dd4bf' }, // teal
  task: { color: '#5eead4' }, // teal-light
  meta: { color: '#cbd5e1' }, // slate-light
  index: { color: '#06b6d4' }, // cyan-dark
  json: { color: '#eab308' }, // yellow-dark
  diff: { color: '#93c5fd' }, // blue-light
  logs: { color: '#a3a3a3' }, // neutral
  settings: { color: '#9ca3af' }, // gray
  brain: { color: '#e879f9' }, // fuchsia
  fallback: { color: '#9ca3af' }, // gray
};

export interface ToolIconConfig {
  icon: ToolIconId;
  color: string;
}
export const TOOL_ICON_CONFIG = Object.fromEntries(
  Object.entries(TOOL_COLORS).map(([icon, config]) => [icon, { icon, ...config }]),
) as Record<ToolIconId, ToolIconConfig>;
export const FALLBACK_ICON: ToolIconId = 'fallback';

/**
 * Tool name (and common alias) → icon id. Keys are lowercase; `getToolIcon`
 * lowercases the query, so lookups are case-insensitive. Covers every builtin
 * tool plus the aliases models commonly emit.
 */
export const TOOL_ICON_MAP: Record<string, ToolIconId> = {
  present_artifact: 'document',
  // ── file IO ──
  read: 'file',
  cat: 'file',
  view: 'file',
  write: 'file',
  create: 'file',
  edit: 'edit',
  replace: 'edit',
  str_replace: 'edit',
  multi_edit: 'edit',
  // Matches patchTool's own `icon: 'edit'` (tool-icon-map.ts agrees).
  patch: 'edit',
  // ── search ──
  grep: 'search',
  search: 'search',
  rg: 'search',
  ripgrep: 'search',
  // Matches globTool's own `icon: 'folder'` (tool-icon-map.ts agrees).
  glob: 'folder',
  find: 'search',
  // ── navigation ──
  folder: 'folder',
  ls: 'tree',
  list: 'tree',
  set_working_dir: 'settings',
  tree: 'tree',
  // ── shell ──
  bash: 'terminal',
  shell: 'terminal',
  sh: 'terminal',
  exec: 'terminal',
  run: 'terminal',
  command: 'terminal',
  // ── web ──
  fetch: 'web',
  web_fetch: 'web',
  web_search: 'web',
  // ── vcs ──
  git: 'git',
  diff: 'diff',
  // ── code quality ──
  lint: 'code',
  format: 'code',
  typecheck: 'code',
  language_info: 'code',
  language: 'code',
  language_package: 'package',
  test: 'test',
  // ── packages ──
  install: 'package',
  outdated: 'package',
  audit: 'package',
  // ── docs / scaffold ──
  document: 'document',
  scaffold: 'scaffold',
  // ── planning / work tracking ──
  todo: 'todo',
  plan: 'plan',
  task: 'task',
  // ── data ──
  json: 'json',
  index: 'index',
  logs: 'logs',
  // ── meta / tooling ──
  mode: 'meta',
  tool_search: 'meta',
  tool_use: 'meta',
  tool_script: 'meta',
  batch_tool_use: 'meta',
  tool_help: 'meta',
  // ── memory ──
  remember: 'brain',
  forget: 'brain',
  search_memory: 'brain',
  find_related_memories: 'brain',
  memory_for_file: 'brain',
  memory_for_path: 'brain',
  memory_search: 'brain',
  memory_graph: 'brain',
  memory_verify: 'brain',
  memory_hygiene: 'brain',
  memory_candidates: 'brain',
  // ── language intelligence ──
  lsp_diagnostics: 'code',
  lsp_definition: 'search',
  lsp_completion: 'code',
  lsp_rename: 'edit',
  'codebase-lsp-search': 'index',
  'codebase-context': 'index',
  'codebase-skeleton': 'index',
  'codebase-repo-map': 'index',
  'codebase-impact-analysis': 'index',
  'codebase-diff-impact': 'index',
  'codebase-ast-replace': 'edit',
  'codebase-targeted-test': 'test',
  'codebase-flow-trace': 'index',
  'codebase-onboard': 'index',
  'codebase-atlas': 'index',
  'security-ast-scan': 'code',
  design: 'scaffold',
  design_reference: 'scaffold',
  clarify: 'meta',
  browser_open: 'web',
  browser_close: 'web',
  browser_list: 'web',
  browser_navigate: 'web',
  browser_snapshot: 'web',
  browser_screenshot: 'web',
  browser_click: 'web',
  browser_type: 'web',
  browser_select: 'web',
  browser_press: 'web',
  browser_hover: 'web',
  browser_drag: 'web',
  browser_upload: 'web',
  browser_evaluate: 'web',
  browser_wait: 'web',
  browser_status: 'web',
  agent_model_assign: 'settings',
  ask_result: 'brain',
  ask_subagent: 'brain',
  assign_task: 'task',
  await_tasks: 'task',
  checkpoint_create: 'file',
  checkpoint_list: 'file',
  checkpoint_restore: 'edit',
  collab_debug: 'brain',
  config_validator_status: 'settings',
  context_manager: 'brain',
  council: 'brain',
  coverage_gate_status: 'test',
  cron_cancel: 'settings',
  cron_list: 'settings',
  cron_schedule: 'settings',
  delegate: 'brain',
  dep_guard_status: 'package',
  error_lens_history: 'logs',
  fallback_chain_manage: 'settings',
  fallback_profile_manage: 'settings',
  favorite_manage: 'settings',
  flake_detect: 'test',
  flake_status: 'test',
  fleet: 'brain',
  fleet_emit: 'brain',
  fleet_status: 'brain',
  git_autocommit: 'git',
  gitignore_guard_append: 'git',
  gitignore_guard_status: 'git',
  handoff_note: 'document',
  handoff_status: 'document',
  image_generate: 'scaffold',
  injection_shield_status: 'code',
  jev_status: 'settings',
  kanban_queue: 'task',
  leader_effort_set: 'settings',
  leader_model_set: 'settings',
  leader_tier_set: 'settings',
  lint_gate_status: 'code',
  llm: 'brain',
  loop_breaker_status: 'settings',
  lsp_code_actions: 'code',
  lsp_execute_command: 'code',
  lsp_hover: 'code',
  lsp_references: 'search',
  lsp_request: 'code',
  lsp_symbols: 'code',
  mail_inbox: 'document',
  mail_send: 'document',
  mailbox: 'document',
  mcp_control: 'settings',
  mcp_use: 'meta',
  memory_backfill_recoverable: 'brain',
  memory_delete: 'brain',
  memory_gather_batch: 'brain',
  memory_recover: 'brain',
  memory_search_explain: 'brain',
  memory_update: 'brain',
  mutation_test: 'test',
  pin_add: 'brain',
  pin_list: 'brain',
  pin_remove: 'brain',
  plugin_manager: 'settings',
  process_guard_status: 'settings',
  prompt_firewall_status: 'code',
  provider_key_set: 'settings',
  provider_manage: 'settings',
  quality_gate: 'test',
  roll_up: 'task',
  secret_scanner_status: 'code',
  secret_scanner_test: 'code',
  semver_bump: 'package',
  semver_changelog: 'document',
  semver_current: 'package',
  session_note: 'document',
  session_recap_status: 'logs',
  session_rename: 'settings',
  skill: 'document',
  spawn_subagent: 'brain',
  system_config_view: 'settings',
  telegram_approve: 'document',
  telegram_read: 'document',
  telegram_send: 'document',
  terminate_all: 'brain',
  terminate_subagent: 'brain',
  test_impact_analyze: 'test',
  todo_listener_status: 'todo',
  type_gate_status: 'code',
  watch_list: 'folder',
  watch_start: 'folder',
  watch_stop: 'folder',
  work_complete: 'task',
  workspace_health_analyze: 'code',
  // Compatibility names retained from the original public map.
  view_file: 'file',
  write_to_file: 'file',
  replace_file_content: 'edit',
  grep_search: 'search',
  find_by_name: 'folder',
  find_files: 'folder',
  pwsh: 'terminal',
  powershell: 'terminal',
  run_command: 'terminal',
  curl: 'web',
  http: 'web',
  request: 'web',
  read_url_content: 'web',
  search_web: 'web',
  list_dir: 'tree',
  list_directory: 'tree',
  tests: 'test',
  e2e_plan: 'test',
  uninstall: 'package',
  npm: 'package',
  pnpm: 'package',
  yarn: 'package',
  doc: 'document',
  jsdoc: 'document',
  generate: 'scaffold',
  template: 'scaffold',
  todos: 'todo',
  nextsteps: 'todo',
  planning: 'plan',
  tasks: 'task',
  kanban: 'task',
  board: 'task',
  'tool-use': 'meta',
  'batch-tool-use': 'meta',
  'tool-search': 'meta',
  'tool-help': 'meta',
  project_kit: 'package',
  project_kit_run: 'terminal',
  'codebase-index': 'index',
  'codebase-search': 'index',
  'codebase-stats': 'index',
  'codebase-incoming-calls': 'index',
  'codebase-outgoing-calls': 'index',
  'codebase-invariant-check': 'index',
  'codebase-read-symbol': 'file',
  'dead-code-scan': 'index',
  'dead-code-fix': 'edit',
  codebase_index: 'index',
  codebase_search: 'index',
  codebase_stats: 'index',
  codebase_incoming_calls: 'index',
  codebase_outgoing_calls: 'index',
  codebase_invariant_check: 'index',
  codebase_read_symbol: 'file',
  dead_code_scan: 'index',
  parse: 'json',
  query: 'json',
  compare: 'diff',
  log: 'logs',
  'set-working-dir': 'settings',
  cwd: 'settings',
  cd: 'settings',
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
};

/**
 * Resolve a tool name to its canonical `ToolIconId`. Case-insensitive.
 * Unknown names — including `mcp__*` server tools and plugin tools — fall back
 * to `'fallback'`.
 */
export function getToolIcon(name: string): ToolIconId {
  if (!name) return 'fallback';
  return TOOL_ICON_MAP[name.toLowerCase()] ?? 'fallback';
}
