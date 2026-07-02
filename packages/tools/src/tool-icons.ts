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
export const TOOL_ICON_CONFIG: Record<ToolIconId, { color: string }> = {
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

/**
 * Tool name (and common alias) → icon id. Keys are lowercase; `getToolIcon`
 * lowercases the query, so lookups are case-insensitive. Covers every builtin
 * tool plus the aliases models commonly emit.
 */
export const TOOL_ICON_MAP: Record<string, ToolIconId> = {
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
  patch: 'diff',
  // ── search ──
  grep: 'search',
  search: 'search',
  rg: 'search',
  ripgrep: 'search',
  glob: 'search',
  find: 'search',
  // ── navigation ──
  folder: 'folder',
  ls: 'folder',
  list: 'folder',
  set_working_dir: 'folder',
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
  format: 'settings',
  typecheck: 'code',
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
  batch_tool_use: 'meta',
  tool_help: 'meta',
  // ── memory ──
  remember: 'brain',
  forget: 'brain',
  search_memory: 'brain',
  find_related_memories: 'brain',
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
