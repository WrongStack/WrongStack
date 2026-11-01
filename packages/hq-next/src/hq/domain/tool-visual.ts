/**
 * Per-tool lucide icon + color for the HQ Console — same data source as the
 * main WebUI: the canonical name→icon-id and id→color maps live in
 * `@wrongstack/tools/tool-icons` (pure, browser-safe); this module only binds
 * each ToolIconId to a lucide-react component. Add new tools to TOOL_ICON_MAP
 * in @wrongstack/tools, not here.
 *
 * @module lib/tool-visual
 */
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

/** Canonical ToolIconId → lucide-react component (mirrors the WebUI map). */
const TOOL_LUCIDE: Record<ToolIconId, LucideIcon> = {
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
  /** Canonical hex color (same value the TUI/WebUI use). */
  color: string;
}

/** Resolve a tool name to its { Icon, color }. Unknown / MCP tools fall back. */
export function getToolVisual(name: string | undefined): ToolVisual {
  const id = getToolIcon(name ?? '');
  return { Icon: TOOL_LUCIDE[id], color: TOOL_ICON_CONFIG[id].color };
}
