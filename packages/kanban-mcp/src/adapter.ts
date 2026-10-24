import type { JSONSchema } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { coerceAgainstSchema, validateAgainstSchema } from '@wrongstack/core/utils';
import { getKanbanServerConnection, type KanbanServerEvent } from '@wrongstack/kanban';
import {
  MCPServer,
  type MCPServerCallResult,
  type MCPServerTool,
  type MCPServerToolHost,
} from '@wrongstack/mcp';
import { systemSessionId } from '@wrongstack/primitives';
import { kanbanTool } from '@wrongstack/tools/kanban';
import {
  KANBAN_TOOL_ANNOTATIONS,
  type KanbanMcpAction,
  type KanbanMcpPolicyOptions,
  type KanbanMcpToolName,
  selectKanbanMcpTools,
} from './policy.js';
import { SERVER_INFO } from './version.js';

const WATCH_DEFAULT_TIMEOUT_MS = 15_000;
const WATCH_MAX_TIMEOUT_MS = 25_000;

interface KanbanEventConnection {
  subscribe(listener: (event: KanbanServerEvent) => void): () => void;
  onDisconnect(listener: () => void): () => void;
}

export interface KanbanMcpDependencies {
  executeKanban?: (
    args: Record<string, unknown>,
    context: Context,
    signal: AbortSignal,
  ) => Promise<unknown>;
  getConnection?: (projectRoot: string) => Promise<KanbanEventConnection | null>;
}

export interface KanbanMcpToolHostOptions extends KanbanMcpPolicyOptions {
  actor?: string | undefined;
  /**
   * Session that owns every board mutation this host performs. An external MCP
   * client has no WrongStack session of its own, so it supplies a stable
   * connection-scoped id here — the durable events it writes are attributed to
   * it, and "whose work is this?" has an answer. Defaults to a `system:` id
   * derived from the actor when the caller names none.
   */
  sessionId?: string | undefined;
  dependencies?: KanbanMcpDependencies | undefined;
}

function actionSchema(actions: readonly KanbanMcpAction[]): Record<string, unknown> {
  const schema = structuredClone(kanbanTool.inputSchema) as Record<string, unknown>;
  const properties = schema['properties'];
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('Kanban MCP: Kanban tool schema has no properties object');
  }
  const action = (properties as Record<string, unknown>)['action'];
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new Error('Kanban MCP: Kanban tool schema has no action property');
  }
  (action as Record<string, unknown>)['enum'] = [...actions];
  return schema;
}

const WATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    boardId: {
      type: 'string',
      description: 'Optional full board id. Omit to observe any board.',
    },
    timeoutMs: {
      type: 'number',
      minimum: 100,
      maximum: WATCH_MAX_TIMEOUT_MS,
      description: `Long-poll timeout. Defaults to ${WATCH_DEFAULT_TIMEOUT_MS}.`,
    },
  },
  additionalProperties: false,
};

const TOOL_DESCRIPTIONS: Record<KanbanMcpToolName, string> = {
  kanban_read:
    'Read authoritative WrongStack Kanban boards, tasks, events, queue health, task chains, and exports through the project IPC owner.',
  kanban_manage:
    'Create and update WrongStack Kanban boards and tasks, assignments, dependencies, evidence, verification, and orchestration state. Requires server --writable.',
  kanban_destructive:
    'Delete or absorb durable WrongStack Kanban state, including board/task/column deletion, merge, and cross-board transfer. Requires server --destructive.',
  kanban_watch:
    'Wait for the next project Kanban mutation event. After any event or timeout, reconcile authoritative state with kanban_read.',
};

/**
 * A published tool descriptor carrying the MCP `annotations` hint block.
 * `MCPServerTool` declares the field itself (`@wrongstack/mcp`, spec
 * 2025-03-26), so no local widening type is needed — the tier mapping in
 * policy.ts supplies the value.
 */
function toolDescriptor(
  name: KanbanMcpToolName,
  actions?: readonly KanbanMcpAction[],
): MCPServerTool {
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: actions ? actionSchema(actions) : WATCH_SCHEMA,
    annotations: KANBAN_TOOL_ANNOTATIONS[name],
  };
}

function createContext(projectRoot: string, actor: string, sessionId: string): Context {
  return {
    systemPrompt: [],
    cwd: projectRoot,
    projectRoot,
    allowOutsideProjectRoot: false,
    model: 'kanban-mcp',
    tools: [],
    meta: { source: 'kanban-mcp' },
    agentId: actor,
    agentName: actor,
    // The kanban tool stamps every board event with this. A fake context that
    // omitted it made each mutation throw at the event-creation boundary.
    eventSessionId: () => sessionId,
  } as unknown as Context;
}

/**
 * The kanban tool throws `KanbanToolError` / `KanbanInputError` carrying a
 * stable `kanbanCode`, `retryable` and (for lifecycle refusals) structured
 * `issues`. Keep that structure in the MCP content so an external client can
 * branch on the code instead of parsing prose. Duck-typed so this package does
 * not depend on the tool's error classes. Anything else stays a plain message.
 */
export function mcpErrorContent(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  const kanbanCode = (error as { kanbanCode?: unknown }).kanbanCode;
  if (typeof kanbanCode !== 'string') return error.message;
  const issues = (error as { issues?: unknown }).issues;
  return {
    ok: false,
    error: {
      code: kanbanCode,
      message: error.message,
      retryable: (error as { retryable?: unknown }).retryable === true,
      ...(Array.isArray(issues) && issues.length > 0 ? { issues } : {}),
    },
  };
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return WATCH_DEFAULT_TIMEOUT_MS;
  return Math.min(WATCH_MAX_TIMEOUT_MS, Math.max(100, Math.trunc(value)));
}

function eventBoardId(event: KanbanServerEvent): string | undefined {
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return undefined;
  const boardId = (event.data as Record<string, unknown>)['boardId'];
  return typeof boardId === 'string' ? boardId : undefined;
}

async function watchForKanbanMutation(
  projectRoot: string,
  args: Record<string, unknown>,
  getConnection: (projectRoot: string) => Promise<KanbanEventConnection | null>,
  signal: AbortSignal,
): Promise<unknown> {
  const rawBoardId = typeof args['boardId'] === 'string' ? args['boardId'].trim() : '';
  const boardId = rawBoardId.length > 0 ? rawBoardId : undefined;
  const timeoutMs = normalizeTimeout(args['timeoutMs']);
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Kanban watch cancelled');
  }
  const connection = await getConnection(projectRoot);
  if (!connection) {
    throw new Error('Kanban project server is disabled; live watch is unavailable');
  }
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Kanban watch cancelled');
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribeEvent = (): void => {};
    let unsubscribeDisconnect = (): void => {};
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      unsubscribeEvent();
      unsubscribeDisconnect();
    };
    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Kanban watch cancelled'));
    };

    const eventOff = connection.subscribe((event) => {
      if (typeof event.event !== 'string' || !event.event.startsWith('board.')) return;
      const changedBoardId = eventBoardId(event);
      if (boardId && changedBoardId !== boardId) return;
      finish({ changed: true, event: event.event, data: event.data });
    });
    unsubscribeEvent = eventOff;
    if (settled) eventOff();
    const disconnectOff = connection.onDisconnect(() => {
      finish({ changed: false, disconnected: true, reason: 'Kanban daemon disconnected' });
    });
    unsubscribeDisconnect = disconnectOff;
    if (settled) disconnectOff();
    if (signal.aborted) onAbort();
    if (settled) return;
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      finish({ changed: false, timedOut: true, timeoutMs });
    }, timeoutMs);
    timer.unref?.();
  });
}

export function createKanbanMcpToolHost(
  projectRoot: string,
  opts: KanbanMcpToolHostOptions = {},
): MCPServerToolHost {
  const policy = selectKanbanMcpTools(opts);
  const allowed = new Map(policy.map((entry) => [entry.name, entry.actions]));
  const actor = opts.actor?.trim() || 'external-kanban-mcp';
  const sessionId = opts.sessionId?.trim() || systemSessionId(`kanban-mcp:${actor}`);
  const context = createContext(projectRoot, actor, sessionId);
  const executeKanban =
    opts.dependencies?.executeKanban ??
    (async (args: Record<string, unknown>, ctx: Context, signal: AbortSignal) =>
      await kanbanTool.execute(args as never, ctx, { signal }));
  const getConnection = opts.dependencies?.getConnection ?? getKanbanServerConnection;

  return {
    listTools(): MCPServerTool[] {
      return policy.map((entry) => toolDescriptor(entry.name, entry.actions));
    },

    async callTool(
      name: string,
      args: Record<string, unknown>,
      callOptions?: { signal?: AbortSignal | undefined },
    ): Promise<MCPServerCallResult> {
      if (!allowed.has(name as KanbanMcpToolName)) {
        return {
          content: `Tool "${name}" is not exposed by this Kanban MCP server`,
          isError: true,
        };
      }

      const signal = callOptions?.signal ?? new AbortController().signal;
      if (name === 'kanban_watch') {
        try {
          const content = await watchForKanbanMutation(projectRoot, args, getConnection, signal);
          return { content, isError: false };
        } catch (error) {
          return {
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      }

      const actions = allowed.get(name as KanbanMcpToolName);
      const action = args['action'];
      if (typeof action !== 'string' || !actions?.includes(action as KanbanMcpAction)) {
        return {
          content: `Action "${String(action)}" is not allowed through ${name}`,
          isError: true,
        };
      }

      const checked = argsWithinSchema(actionSchema(actions), args);
      if ('error' in checked) return { content: checked.error, isError: true };

      try {
        signal.throwIfAborted();
        const result = await executeKanban(withListDefaults(action, checked.args), context, signal);
        signal.throwIfAborted();
        const failed =
          !!result &&
          typeof result === 'object' &&
          !Array.isArray(result) &&
          (result as Record<string, unknown>)['ok'] === false;
        return { content: result, isError: failed };
      } catch (error) {
        return { content: mcpErrorContent(error), isError: true };
      }
    },
  };
}

/**
 * MCPServer validates nothing, and nothing behind it checks the schema's enums
 * (an out-of-range priority was stored as is). Hold an external call to the
 * schema this host advertises, as the agent loop holds its own calls: validate,
 * then coerce and re-validate.
 */
function argsWithinSchema(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  // An `undefined` value is an absent key (JSON cannot carry one).
  const args = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const validation = validateAgainstSchema(args, schema as JSONSchema);
  if (validation.ok) return { args };
  const coercion = coerceAgainstSchema(args, schema as JSONSchema);
  const revalidation = coercion.changed
    ? validateAgainstSchema(coercion.value, schema as JSONSchema)
    : validation;
  if (coercion.changed && revalidation.ok)
    return { args: coercion.value as Record<string, unknown> };
  return { error: revalidation.errors.map((e) => `${e.path || 'input'}: ${e.message}`).join('\n') };
}

/**
 * Unbounded list reads overflow an MCP client's result budget on a real
 * project (100+ boards, 1000+ cards; a card match is ~4 KB, a board ~2 KB):
 * the client spills the payload to a file and the agent has to parse it.
 * External callers get the most recently updated few, sized to stay near
 * 10k tokens, and no archived boards unless they ask; the result message
 * says how many exist so a caller can raise `limit`.
 */
export const MCP_LIST_DEFAULT_LIMITS = { list_boards: 20, search_tasks: 10 } as const;

function withListDefaults(action: string, args: Record<string, unknown>): Record<string, unknown> {
  if (action !== 'list_boards' && action !== 'search_tasks') return args;
  return {
    ...args,
    ...(args['limit'] === undefined ? { limit: MCP_LIST_DEFAULT_LIMITS[action] } : {}),
    ...(action === 'list_boards' && args['includeArchived'] === undefined
      ? { includeArchived: false }
      : {}),
  };
}

export function createKanbanMcpServer(
  projectRoot: string,
  opts: KanbanMcpToolHostOptions = {},
): MCPServer {
  return new MCPServer({
    host: createKanbanMcpToolHost(projectRoot, opts),
    serverInfo: { name: 'wrongstack-kanban-mcp', version: SERVER_INFO.version },
    prompts: [
      {
        name: 'work-kanban-task',
        title: 'Work a WrongStack Kanban task',
        description:
          'Inspect, claim, execute, verify, and update a task without bypassing board policy.',
        arguments: [{ name: 'boardId', description: 'Board id or unique prefix', required: true }],
        template:
          'Use the WrongStack Kanban MCP tools on board {{boardId}}. Re-read authoritative board state before mutation, claim an eligible task, keep assignment state current, attach truthful evidence, and satisfy its completion gate.',
      },
    ],
  });
}
