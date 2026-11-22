import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  isMcpSessionToolGroup,
  QUICK_TOOL_GROUPS,
  type SessionToolGroup,
  type SessionToolGroupChoice,
  type SessionToolGroupMode,
  type SessionToolGroupState,
} from '@wrongstack/contracts/types';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import {
  projectToolGroupDefaults,
  writeProjectToolGroupDefault,
} from './project-tool-group-defaults.js';

const groupTools = {
  codebase: [
    'codebase-ast-replace',
    'codebase-atlas',
    'codebase-context',
    'codebase-diff-impact',
    'codebase-flow-trace',
    'codebase-impact-analysis',
    'codebase-incoming-calls',
    'codebase-index',
    'codebase-invariant-check',
    'codebase-onboard',
    'codebase-outgoing-calls',
    'codebase-read-symbol',
    'codebase-repo-map',
    'codebase-search',
    'codebase-skeleton',
    'codebase-stats',
    'codebase-targeted-test',
  ],
  kanban: ['kanban', 'kanban_queue'],
  browser: [
    'browser_open',
    'browser_list',
    'browser_status',
    'browser_navigate',
    'browser_snapshot',
    'browser_screenshot',
    'browser_type',
    'browser_click',
    'browser_hover',
    'browser_select',
    'browser_press',
    'browser_drag',
    'browser_wait',
    'browser_evaluate',
    'browser_upload',
    'browser_close',
    'e2e_plan',
  ],
  automation: [
    'process_watch',
    'process_watch_control',
    'session_wakeup',
    'watch_start',
    'watch_stop',
    'watch_list',
    'project_kit_run',
    'cron_schedule',
    'cron_list',
    'cron_cancel',
  ],
  fleet: [
    'delegate',
    'spawn_subagent',
    'define_subagent',
    'assign_task',
    'await_tasks',
    'ask_subagent',
    'ask_result',
    'roll_up',
    'terminate_subagent',
    'terminate_all',
    'fleet',
    'fleet_status',
    'fleet_emit',
    'collab_debug',
    'work_complete',
    'mail_send',
    'mail_inbox',
    'mailbox',
    'session_note',
    'handoff_note',
    'handoff_status',
  ],
  lsp: [
    'codebase-lsp-search',
    'lsp_definition',
    'lsp_references',
    'lsp_hover',
    'lsp_symbols',
    'lsp_diagnostics',
    'lsp_completion',
    'lsp_code_actions',
    'lsp_rename',
    'lsp_execute_command',
    'lsp_request',
  ],
  media: ['design', 'design_reference', 'image_generate'],
  toolflow: ['tool_script'],
  'vector-memory': [
    'vector_memory_remember',
    'vector_memory_search',
    'vector_memory_stats',
    'vector_memory_forget',
  ],
  'model-utilities': ['council', 'llm', 'jev', 'jev_status'],
  mcp: ['mcp_control', 'mcp_use'],
  telegram: ['telegram_read', 'telegram_send', 'telegram_approve'],
} satisfies Record<keyof typeof QUICK_TOOL_GROUPS, readonly string[]>;

const groups = Object.keys(QUICK_TOOL_GROUPS) as (keyof typeof QUICK_TOOL_GROUPS)[];
const groupByTool = new Map<string, SessionToolGroup>(
  groups.flatMap((group) => groupTools[group].map((name) => [name, group] as const)),
);

interface SessionToolGroupContext {
  meta?: Readonly<Record<string, unknown>> | undefined;
  projectRoot?: string | undefined;
  currentKanbanBoardId?: string | undefined;
  eventSessionId?: (() => string) | undefined;
}

const preferences = new WeakMap<
  SessionToolGroupContext,
  {
    sessionId: string | undefined;
    projectRoot: string | undefined;
    modes: Partial<Record<SessionToolGroup, SessionToolGroupMode>>;
  }
>();
const governance = new WeakMap<SessionToolGroupContext, boolean>();
const revisions = new WeakMap<SessionToolGroupContext, Partial<Record<SessionToolGroup, number>>>();
type ProjectModes = ReturnType<typeof projectToolGroupDefaults>;
type Modes = NonNullable<ProjectModes>;
type ToolIdentity = Pick<Tool, 'name' | 'mcpServerName'>;

function currentModes(ctx: SessionToolGroupContext) {
  const stored = preferences.get(ctx);
  return stored &&
    stored.sessionId === ctx.eventSessionId?.() &&
    stored.projectRoot === ctx.projectRoot
    ? stored.modes
    : undefined;
}

function groupOf({ name, mcpServerName }: ToolIdentity): SessionToolGroup | undefined {
  if (mcpServerName !== undefined) return `mcp:${mcpServerName}`;
  return groupByTool.get(name) ?? (name.startsWith('mcp__') ? 'mcp' : undefined);
}

export function sessionToolGroupRevision(
  ctx: SessionToolGroupContext,
  tool: ToolIdentity,
): string | undefined {
  const group = groupOf(tool);
  if (!group) return undefined;
  const rev = revisions.get(ctx);
  return isMcpSessionToolGroup(group)
    ? `${rev?.mcp ?? 0}:${rev?.[group] ?? 0}`
    : String(rev?.[group] ?? 0);
}

export function setSessionToolGroupGovernance(
  ctx: SessionToolGroupContext,
  required: boolean,
): void {
  governance.set(ctx, required);
}

function configuredMode(
  project: ProjectModes,
  session: Modes | undefined,
  group: SessionToolGroup,
) {
  return session?.[group] ?? project?.[group] ?? (project === null ? 'off' : 'auto');
}

function groupState(
  ctx: SessionToolGroupContext,
  group: SessionToolGroup,
  project: ProjectModes,
  session: Modes | undefined,
): SessionToolGroupState {
  const sessionMode = session?.[group];
  const projectMode = project?.[group];
  const mode = configuredMode(project, session, group);
  const required = group === 'kanban' && governance.get(ctx) === true;
  const source: SessionToolGroupState['source'] = sessionMode
    ? 'session'
    : projectMode
      ? 'project'
      : undefined;
  const base = { group, mode, source, projectMode, required };
  if (required)
    return {
      ...base,
      enabled: true,
      reason: 'Kanban governance requires board access.',
    };
  if (isMcpSessionToolGroup(group)) {
    const parent = configuredMode(project, session, 'mcp');
    if (parent === 'off') return { ...base, enabled: false, reason: 'MCP integrations are off.' };
    return { ...base, enabled: mode === 'on' || (mode === 'auto' && parent === 'on') };
  }
  if (mode !== 'auto')
    return {
      ...base,
      enabled: mode === 'on',
      ...(project === null && !sessionMode
        ? { reason: 'Project tool group defaults could not be read.' }
        : {}),
    };
  if (group === 'kanban') {
    const binding = ctx.meta?.['kanban'];
    const board =
      ctx.currentKanbanBoardId ??
      (binding && typeof binding === 'object' && 'boardId' in binding
        ? binding.boardId
        : undefined);
    return { ...base, enabled: typeof board === 'string' && board.length > 0 };
  }
  if (group === 'mcp') {
    return {
      ...base,
      enabled: Object.keys({ ...project, ...session }).some(
        (key) => isMcpSessionToolGroup(key) && configuredMode(project, session, key) === 'on',
      ),
    };
  }
  if (group !== 'codebase') return { ...base, enabled: false };
  const override = ctx.meta?.['codebaseIndexDir'];
  const indexDir =
    typeof override === 'string'
      ? override
      : ctx.projectRoot &&
        resolveWstackPaths({ projectRoot: ctx.projectRoot }).projectCodebaseIndex;
  return { ...base, enabled: !!indexDir && existsSync(join(indexDir, 'index.db')) };
}

export function sessionToolGroupState(
  ctx: SessionToolGroupContext,
  group: SessionToolGroup,
): SessionToolGroupState {
  return groupState(ctx, group, projectToolGroupDefaults(ctx.projectRoot), currentModes(ctx));
}

export function sessionToolGroupStates(
  ctx: SessionToolGroupContext,
  servers: readonly string[] = [],
): SessionToolGroupState[] {
  const project = projectToolGroupDefaults(ctx.projectRoot);
  const session = currentModes(ctx);
  const serverGroups = new Set(
    [...servers.map((name) => `mcp:${name}`), ...Object.keys({ ...project, ...session })].filter(
      isMcpSessionToolGroup,
    ),
  );
  return [...groups, ...[...serverGroups].sort()].map((group) =>
    groupState(ctx, group, project, session),
  );
}

export function setSessionToolGroup(
  ctx: SessionToolGroupContext,
  group: SessionToolGroup,
  mode: SessionToolGroupChoice,
): SessionToolGroupState {
  if (ctx.meta?.['systemPromptVariant'] !== 'quick') {
    throw new Error('Tool group settings currently apply to Quick sessions.');
  }
  const state = sessionToolGroupState(ctx, group);
  if (mode === 'off' && state.required) throw new Error(state.reason);
  const modes = { ...currentModes(ctx) };
  if (modes[group] !== (mode === 'inherit' ? undefined : mode)) {
    if (mode === 'inherit') delete modes[group];
    else modes[group] = mode;
    preferences.set(ctx, {
      sessionId: ctx.eventSessionId?.(),
      projectRoot: ctx.projectRoot,
      modes,
    });
    const previous = revisions.get(ctx);
    revisions.set(ctx, { ...previous, [group]: (previous?.[group] ?? 0) + 1 });
  }
  return sessionToolGroupState(ctx, group);
}

export async function setProjectToolGroup(
  ctx: SessionToolGroupContext,
  group: SessionToolGroup,
  mode: SessionToolGroupMode,
): Promise<SessionToolGroupState> {
  if (ctx.meta?.['systemPromptVariant'] !== 'quick' || !ctx.projectRoot) {
    throw new Error('Open a project in a Quick session to save a tool group default.');
  }
  const state = sessionToolGroupState(ctx, group);
  if (mode === 'off' && state.required) throw new Error(state.reason);
  const sessionId = ctx.eventSessionId?.();
  const projectRoot = ctx.projectRoot;
  const groupRevision = revisions.get(ctx)?.[group];
  await writeProjectToolGroupDefault(projectRoot, group, mode);
  if (
    sessionId === ctx.eventSessionId?.() &&
    ctx.projectRoot === projectRoot &&
    ctx.meta?.['systemPromptVariant'] === 'quick' &&
    groupRevision === revisions.get(ctx)?.[group]
  ) {
    return setSessionToolGroup(ctx, group, 'inherit');
  }
  return sessionToolGroupState(ctx, group);
}

export function isSessionMcpServerAllowed(ctx: SessionToolGroupContext, server: string): boolean {
  return (
    ctx?.meta?.['systemPromptVariant'] !== 'quick' ||
    sessionToolGroupState(ctx, `mcp:${server}`).enabled
  );
}

export function isSessionToolAllowed(ctx: SessionToolGroupContext, tool: ToolIdentity): boolean {
  if (ctx.meta?.['systemPromptVariant'] !== 'quick') return true;
  if (tool.mcpServerName === undefined && tool.name.startsWith('mcp__')) {
    return (
      configuredMode(projectToolGroupDefaults(ctx.projectRoot), currentModes(ctx), 'mcp') === 'on'
    );
  }
  const group = groupOf(tool);
  return !group || sessionToolGroupState(ctx, group).enabled;
}

export function sessionToolCatalog(ctx: SessionToolGroupContext, tools: Tool[]): Tool[] {
  if (ctx.meta?.['systemPromptVariant'] !== 'quick') return tools;
  const project = projectToolGroupDefaults(ctx.projectRoot);
  const session = currentModes(ctx);
  const enabled = new Map<SessionToolGroup, boolean>();
  return tools.filter((tool) => {
    if (tool.mcpServerName === undefined && tool.name.startsWith('mcp__')) {
      return configuredMode(project, session, 'mcp') === 'on';
    }
    const group = groupOf(tool);
    if (!group) return true;
    const cached = enabled.get(group);
    if (cached !== undefined) return cached;
    const visible = groupState(ctx, group, project, session).enabled;
    enabled.set(group, visible);
    return visible;
  });
}
