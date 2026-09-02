export type CommandPaletteAction =
  | 'new-session'
  | 'focus-composer'
  | 'toggle-theme'
  | 'open-settings'
  | 'open-tools'
  | 'open-todos'
  | 'open-tasks'
  | 'open-plan'
  | 'open-memory'
  | 'open-vector-memory'
  | 'open-files'
  | 'open-prompts'
  | 'open-brain'
  | 'open-health'
  | 'compact-context'
  | 'open-context-breakdown';

export interface CommandPaletteItem {
  id: CommandPaletteAction;
  title: string;
  section: string;
  hint?: string | undefined;
  keywords: string[];
  disabled?: boolean | undefined;
}

export interface CommandPaletteContext {
  hasSession: boolean;
  running: boolean;
  canCompose: boolean;
  canCompact: boolean;
}

const BASE_ITEMS: Array<Omit<CommandPaletteItem, 'disabled'>> = [
  {
    id: 'new-session',
    title: 'New session',
    section: 'Session',
    hint: 'Ctrl+L',
    keywords: ['clear', 'reset', 'start'],
  },
  {
    id: 'focus-composer',
    title: 'Focus composer',
    section: 'Session',
    keywords: ['input', 'prompt', 'chat', 'message'],
  },
  {
    id: 'compact-context',
    title: 'Compact context',
    section: 'Session',
    keywords: ['tokens', 'context', 'summarize'],
  },
  {
    id: 'open-context-breakdown',
    title: 'Context breakdown',
    section: 'Session',
    keywords: ['tokens', 'context', 'details', 'allocation', 'distribution'],
  },
  {
    id: 'open-health',
    title: 'Open session health',
    section: 'Session',
    keywords: ['health', 'context', 'uptime', 'stats'],
  },
  {
    id: 'toggle-theme',
    title: 'Toggle theme',
    section: 'Interface',
    keywords: ['dark', 'light', 'appearance'],
  },
  {
    id: 'open-settings',
    title: 'Open settings',
    section: 'Interface',
    keywords: ['preferences', 'mode', 'autonomy'],
  },
  {
    id: 'open-tools',
    title: 'Open tools',
    section: 'Workspace',
    keywords: ['calls', 'tool calls', 'drawer'],
  },
  {
    id: 'open-todos',
    title: 'Open todos',
    section: 'Workspace',
    keywords: ['worklist', 'todo', 'checklist'],
  },
  {
    id: 'open-tasks',
    title: 'Open tasks',
    section: 'Workspace',
    keywords: ['worklist', 'task', 'structured'],
  },
  {
    id: 'open-plan',
    title: 'Open plan',
    section: 'Workspace',
    keywords: ['worklist', 'roadmap', 'steps'],
  },
  {
    id: 'open-memory',
    title: 'Search memory',
    section: 'Knowledge',
    keywords: ['sage', 'knowledge', 'memories'],
  },
  {
    id: 'open-vector-memory',
    title: 'Search vector memory',
    section: 'Knowledge',
    keywords: ['semantic', 'embedding', 'similarity', 'transformers'],
  },
  {
    id: 'open-files',
    title: 'Open file manager',
    section: 'Knowledge',
    keywords: ['files', 'project', 'explorer'],
  },
  {
    id: 'open-prompts',
    title: 'Open prompt library',
    section: 'Knowledge',
    keywords: ['saved', 'templates', 'prompts'],
  },
  {
    id: 'open-brain',
    title: 'Open Brain panel',
    section: 'Knowledge',
    keywords: ['brain', 'decision', 'risk'],
  },
];

export function commandPaletteItems(context: CommandPaletteContext): CommandPaletteItem[] {
  return BASE_ITEMS.map((item) => ({
    ...item,
    disabled:
      (item.id === 'new-session' && (!context.hasSession || context.running)) ||
      (item.id === 'focus-composer' && !context.canCompose) ||
      (item.id === 'compact-context' && !context.canCompact) ||
      (item.id === 'open-context-breakdown' && !context.hasSession),
  }));
}

export function filterCommandPaletteItems(
  items: CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items;

  return items.filter((item) => {
    const haystack = [item.title, item.section, item.hint ?? '', ...item.keywords]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
