export const QUICK_TOOL_GROUPS = {
  codebase: 'Codebase',
  kanban: 'Kanban',
  browser: 'Browser and E2E',
  automation: 'Automation',
  fleet: 'Fleet and collaboration',
  lsp: 'Language servers',
  media: 'Design and media',
  toolflow: 'ToolFlow',
  'vector-memory': 'Vector memory',
  'model-utilities': 'Model utilities',
  mcp: 'MCP integrations',
  telegram: 'Telegram',
} as const;

export type SessionToolGroup = keyof typeof QUICK_TOOL_GROUPS;
export type SessionToolGroupMode = 'auto' | 'on' | 'off';
export type SessionToolGroupChoice = SessionToolGroupMode | 'inherit';

export interface SessionToolGroupState {
  group: SessionToolGroup;
  mode: SessionToolGroupMode;
  source?: 'session' | 'project' | undefined;
  projectMode?: SessionToolGroupMode | undefined;
  enabled: boolean;
  required: boolean;
  reason?: string | undefined;
}

export function isSessionToolGroup(value: unknown): value is SessionToolGroup {
  return typeof value === 'string' && Object.hasOwn(QUICK_TOOL_GROUPS, value);
}

export function isSessionToolGroupMode(value: unknown): value is SessionToolGroupMode {
  return value === 'auto' || value === 'on' || value === 'off';
}
