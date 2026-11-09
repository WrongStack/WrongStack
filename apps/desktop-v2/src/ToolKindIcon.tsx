import {
  Bot,
  Brain,
  FilePenLine,
  FileText,
  GitBranch,
  Globe2,
  KanbanSquare,
  type LucideIcon,
  Palette,
  Plug,
  Search,
  TerminalSquare,
  Wrench,
} from 'lucide-react';

const FAMILIES: ReadonlyArray<[RegExp, LucideIcon, string]> = [
  [/^(browser|web|fetch|http|url)/, Globe2, 'web'],
  [/(bash|shell|terminal|exec|powershell|process|tool_script)/, TerminalSquare, 'shell'],
  [/^git|worktree|commit|diff/, GitBranch, 'git'],
  [/(memory|sage|recall|remember|brain)/, Brain, 'memory'],
  [/(kanban|todo|task|goal|sdd|board)/, KanbanSquare, 'plan'],
  [/(delegate|agent|subagent|fleet|mailbox|council|companion)/, Bot, 'agent'],
  [/(design|artifact|image|screenshot)/, Palette, 'design'],
  [/^mcp|connector/, Plug, 'mcp'],
  [/(search|grep|glob|find|codebase|index|symbol|lsp)/, Search, 'search'],
  [/(write|edit|patch|replace|create|delete|move)/, FilePenLine, 'edit'],
  [/(read|view|list|file|project_kit)/, FileText, 'read'],
];

/** A registered tool's family icon, so a 118-tool list is not 118 identical wrenches. */
export function ToolKindIcon({ name, size }: { name: string; size: number }) {
  const key = name.toLowerCase().replace(/[.:/-]+/g, '_');
  const found = FAMILIES.find(([pattern]) => pattern.test(key));
  const Icon = found?.[1] ?? Wrench;
  return <Icon size={size} className={`tool-kind tool-kind-${found?.[2] ?? 'other'}`} />;
}
