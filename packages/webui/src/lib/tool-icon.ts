// Per-tool lucide icon + color for the WebUI.
//
// The canonical name→icon and icon→color lookups live in @wrongstack/tools
// (the pure-data `./tool-icons` subpath, browser-safe). This module only maps
// each canonical ToolIconId to a lucide-react component, and pulls the color
// from TOOL_ICON_CONFIG — the same hex the TUI uses — so both surfaces stay
// in sync. Add new tools to TOOL_ICON_MAP in @wrongstack/tools, not here.

import { getToolIcon, TOOL_ICON_CONFIG, type ToolIconId } from '@wrongstack/tools/tool-icons';
import {
  Brain,
  ClipboardList,
  Code2,
  Database,
  FileEdit,
  FileJson,
  FileText,
  FlaskConical,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCompare,
  Globe,
  Hammer,
  Hash,
  ListChecks,
  ListTodo,
  type LucideIcon,
  Package,
  ScrollText,
  Search,
  Settings,
  Shell,
  Wrench,
} from 'lucide-react';

/** Canonical ToolIconId → lucide-react component. */
export const TOOL_LUCIDE: Record<ToolIconId, LucideIcon> = {
  file: FileText,
  edit: FileEdit,
  search: Search,
  folder: FolderOpen,
  terminal: Shell,
  web: Globe,
  git: GitBranch,
  tree: FolderTree,
  code: Code2,
  test: FlaskConical,
  package: Package,
  document: ScrollText,
  scaffold: Hammer,
  todo: ListTodo,
  plan: ClipboardList,
  task: ListChecks,
  meta: Wrench,
  index: Database,
  json: FileJson,
  diff: GitCompare,
  logs: Hash,
  settings: Settings,
  brain: Brain,
  fallback: Wrench,
};

export interface ToolVisual {
  Icon: LucideIcon;
  /** Canonical hex color (same value the TUI uses). */
  color: string;
}

/** Resolve a tool name to its { Icon, color }. Unknown / MCP tools fall back. */
export function getToolVisual(name: string): ToolVisual {
  const id = getToolIcon(name);
  return { Icon: TOOL_LUCIDE[id], color: TOOL_ICON_CONFIG[id].color };
}

/** Human-readable category description for each ToolIconId. */
export const TOOL_CATEGORY_LABELS: Record<ToolIconId, string> = {
  file: 'file read/write',
  edit: 'file editing',
  search: 'search & grep',
  folder: 'folder navigation',
  terminal: 'shell commands',
  web: 'web fetch',
  git: 'git operations',
  tree: 'directory tree',
  code: 'code quality',
  test: 'testing',
  package: 'package management',
  document: 'documentation',
  scaffold: 'project scaffolding',
  todo: 'todo tracking',
  plan: 'planning',
  task: 'task management',
  meta: 'tool orchestration',
  index: 'code indexing',
  json: 'JSON data',
  diff: 'diff & patch',
  logs: 'log viewing',
  settings: 'configuration',
  brain: 'memory',
  fallback: 'external tool',
};

/**
 * Get a tooltip string for a tool name, describing its category and color.
 * Example: "shell commands — red" or "search & grep — violet"
 */
export function getToolTooltip(name: string): string {
  const id = getToolIcon(name);
  const colorName = hexToColorName(TOOL_ICON_CONFIG[id].color);
  const category = TOOL_CATEGORY_LABELS[id];
  return `${category} — ${colorName}`;
}

/** Convert a hex color to a human-readable color name. */
function hexToColorName(hex: string): string {
  const colors: Record<string, string> = {
    '#60a5fa': 'blue',
    '#fbbf24': 'amber',
    '#a78bfa': 'violet',
    '#38bdf8': 'sky',
    '#67e8f9': 'cyan-light',
    '#a3e635': 'lime',
    '#34d399': 'emerald',
    '#22d3ee': 'cyan',
    '#818cf8': 'indigo',
    '#4ade80': 'green',
    '#f472b6': 'pink',
    '#94a3b8': 'slate',
    '#c084fc': 'purple',
    '#facc15': 'yellow',
    '#2dd4bf': 'teal',
    '#5eead4': 'teal-light',
    '#cbd5e1': 'slate-light',
    '#06b6d4': 'cyan-dark',
    '#eab308': 'yellow-dark',
    '#93c5fd': 'blue-light',
    '#a3a3a3': 'neutral',
    '#9ca3af': 'gray',
    '#e879f9': 'fuchsia',
  };
  return colors[hex] ?? 'colored';
}
