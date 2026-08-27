import type { Context } from '@wrongstack/core/agent';
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

function toolDescriptor(
  name: KanbanMcpToolName,
  actions?: readonly KanbanMcpAction[],
): MCPServerTool {
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: actions ? actionSchema(actions) : WATCH_SCHEMA,
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
): Promise<unknown> {
  const boardId = typeof args['boardId'] === 'string' ? args['boardId'] : undefined;
  const timeoutMs = normalizeTimeout(args['timeoutMs']);
  const connection = await getConnection(projectRoot);
  if (!connection) {
    throw new Error('Kanban project server is disabled; live watch is unavailable');
  }

  return await new Promise((resolve) => {
    let settled = false;
    let unsubscribeEvent = (): void => {};
    let unsubscribeDisconnect = (): void => {};
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribeEvent();
      unsubscribeDisconnect();
      resolve(result);
    };

    unsubscribeEvent = connection.subscribe((event) => {
      const changedBoardId = eventBoardId(event);
      if (boardId && changedBoardId !== boardId) return;
      finish({ changed: true, event: event.event, data: event.data });
    });
    unsubscribeDisconnect = connection.onDisconnect(() => {
      finish({ changed: false, disconnected: true, reason: 'Kanban daemon disconnected' });
    });
    timer = setTimeout(() => {
      finish({ changed: false, timedOut: true, timeoutMs });
    }, timeoutMs);
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

    async callTool(name: string, args: Record<string, unknown>): Promise<MCPServerCallResult> {
      if (!allowed.has(name as KanbanMcpToolName)) {
        return {
          content: `Tool "${name}" is not exposed by this Kanban MCP server`,
          isError: true,
        };
      }

      if (name === 'kanban_watch') {
        try {
          const content = await watchForKanbanMutation(projectRoot, args, getConnection);
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

      try {
        const result = await executeKanban(args, context, new AbortController().signal);
        const failed =
          !!result &&
          typeof result === 'object' &&
          !Array.isArray(result) &&
          (result as Record<string, unknown>)['ok'] === false;
        return { content: result, isError: failed };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
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
