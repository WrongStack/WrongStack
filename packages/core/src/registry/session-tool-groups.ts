import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
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
} satisfies Record<SessionToolGroup, readonly string[]>;

const groups = Object.keys(QUICK_TOOL_GROUPS) as SessionToolGroup[];
const groupByTool = new Map(
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
const revisions = new WeakMap<SessionToolGroupContext, Partial<Record<SessionToolGroup, object>>>();

function currentModes(ctx: SessionToolGroupContext) {
  const stored = preferences.get(ctx);
  return stored &&
    stored.sessionId === ctx.eventSessionId?.() &&
    stored.projectRoot === ctx.projectRoot
    ? stored.modes
    : undefined;
}

function groupOf(name: string): SessionToolGroup | undefined {
  return groupByTool.get(name) ?? (name.startsWith('mcp__') ? 'mcp' : undefined);
}

export function sessionToolGroupRevision(
  ctx: SessionToolGroupContext,
  name: string,
): object | undefined {
  const group = groupOf(name);
  return group ? revisions.get(ctx)?.[group] : undefined;
}

export function setSessionToolGroupGovernance(
  ctx: SessionToolGroupContext,
  required: boolean,
): void {
  governance.set(ctx, required);
}

function groupState(
  ctx: SessionToolGroupContext,
  group: SessionToolGroup,
  project: ReturnType<typeof projectToolGroupDefaults>,
  sessionMode: SessionToolGroupMode | undefined,
): SessionToolGroupState {
  const projectMode = project?.[group];
  const mode = sessionMode ?? projectMode ?? (project === null ? 'off' : 'auto');
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
  return groupState(
    ctx,
    group,
    projectToolGroupDefaults(ctx.projectRoot),
    currentModes(ctx)?.[group],
  );
}

export function sessionToolGroupStates(ctx: SessionToolGroupContext): SessionToolGroupState[] {
  const project = projectToolGroupDefaults(ctx.projectRoot);
  const session = currentModes(ctx);
  return groups.map((group) => groupState(ctx, group, project, session?.[group]));
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
    revisions.set(ctx, { ...revisions.get(ctx), [group]: {} });
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

export function isSessionToolAllowed(ctx: SessionToolGroupContext, name: string): boolean {
  if (ctx.meta?.['systemPromptVariant'] !== 'quick') return true;
  const group = groupOf(name);
  return !group || sessionToolGroupState(ctx, group).enabled;
}

export function sessionToolCatalog(ctx: SessionToolGroupContext, tools: Tool[]): Tool[] {
  if (ctx.meta?.['systemPromptVariant'] !== 'quick') return tools;
  const off = new Set(
    sessionToolGroupStates(ctx)
      .filter((state) => !state.enabled)
      .map((state) => state.group),
  );
  return tools.filter(({ name }) => {
    const group = groupOf(name);
    return !group || !off.has(group);
  });
}
