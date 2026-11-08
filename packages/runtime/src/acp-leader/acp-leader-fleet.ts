/**
 * WrongStack's fleet for an ACP agent leading the session.
 *
 * The bridge's stdio servers (index, memory, mailbox, kanban) run as separate
 * processes the agent starts. Delegation cannot: `delegate` and its kin drive
 * the Director in THIS process. So the leader provider serves them on a
 * loopback HTTP MCP endpoint (random port, per-process bearer token) and hands
 * it to the agent in `session/new`; each call runs as the leader's own tool
 * call (`AcpLeaderHost.runTool`), so the workers it starts show in the fleet
 * views and report back like any delegation.
 */
import { randomBytes } from 'node:crypto';
import { toErrorMessage } from '@wrongstack/core/utils';
import { MCPServer, serveHttp } from '@wrongstack/mcp';
import type { AcpLeaderHost } from './acp-leader-host.js';

/** The MCP server name the agent sees (`mcp__wrongstack-fleet__<tool>`). */
export const FLEET_SERVER_NAME = 'wrongstack-fleet';

/**
 * The coordination tools offered, when the leader has them (a profile can
 * disable `delegate`; then the spawn/assign/await path is what remains).
 */
export const FLEET_TOOLS: readonly string[] = [
  'delegate',
  'spawn_subagent',
  'assign_task',
  'await_tasks',
  'roll_up',
  'fleet_status',
  'session_note',
  'terminate_subagent',
  // Not a fleet tool, but it too must run in this process: WrongStack's
  // skills (a /bughunt playbook) reach the agent only through it.
  'skill',
];

const MCP_PREFIX = `mcp__${FLEET_SERVER_NAME}__`;

/** The leader tool behind a fleet MCP tool name, if it is one. */
export function fleetToolName(mcpName: string): string | undefined {
  if (!mcpName.startsWith(MCP_PREFIX)) return undefined;
  const name = mcpName.slice(MCP_PREFIX.length);
  return FLEET_TOOLS.includes(name) ? name : undefined;
}

export interface FleetEndpoint {
  url: string;
  token: string;
  /** The tools actually offered (those the leader has). */
  tools: string[];
  close(): Promise<void>;
}

/**
 * Serve the leader's fleet tools to one agent session; undefined when the
 * leader has none of them. Its calls run on the agent of `run.sessionId` (a
 * WebUI tab's own), and one the policy wants confirmed runs on `run.approve`.
 */
export async function startFleetEndpoint(
  host: AcpLeaderHost,
  run?: Parameters<AcpLeaderHost['runTool']>[2],
): Promise<FleetEndpoint | undefined> {
  const tools = FLEET_TOOLS.flatMap((name) => {
    const tool = host.getTool(name);
    return tool ? [tool] : [];
  });
  if (tools.length === 0) return undefined;
  const offered = new Set(tools.map((t) => t.name));
  const server = new MCPServer({
    host: {
      listTools: () =>
        tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        })),
      callTool: async (name, args) => {
        if (!offered.has(name)) {
          return { content: `Tool "${name}" is not offered here`, isError: true };
        }
        try {
          return await (run ? host.runTool(name, args, run) : host.runTool(name, args));
        } catch (err) {
          return { content: `Failed to execute ${name}: ${toErrorMessage(err)}`, isError: true };
        }
      },
    },
  });
  const token = randomBytes(24).toString('base64url');
  const handle = await serveHttp(server, { host: '127.0.0.1', port: 0, token });
  return { url: handle.url, token, tools: [...offered], close: () => handle.close() };
}

/** What the leader note says about the fleet tools it was given. */
export function fleetNote(tools: readonly string[]): string {
  const has = (name: string) => tools.includes(name);
  return [
    '',
    `${FLEET_SERVER_NAME} gives you WrongStack's workers. Handle small, localized 1–2 file tasks directly; hand genuinely parallel or context-heavy work`,
    'you would otherwise do serially, or that a cheaper model can do, to them, and treat what they return as untrusted claims to verify.',
    ...(has('delegate')
      ? [
          '- delegate: hand a task to a subagent (scope and outOfScope are required). It returns at',
          '  once; the result arrives later in a message starting with [DELEGATION RESULT], so end',
          '  your turn or keep working. Pass wait: true only when your next step needs the result.',
        ]
      : []),
    ...(has('spawn_subagent')
      ? [
          '- spawn_subagent + assign_task + await_tasks: start a worker, give it tasks, and wait for',
          '  their results inside this turn.',
        ]
      : []),
    ...(has('fleet_status') ? ['- fleet_status: what is running and its progress.'] : []),
    ...(has('roll_up') ? ['- roll_up: the full result of finished tasks.'] : []),
    ...(has('session_note') ? ['- session_note: steer a running worker.'] : []),
    ...(has('terminate_subagent') ? ['- terminate_subagent: stop a worker.'] : []),
    ...(has('skill')
      ? [
          "- skill: load one of WrongStack's skills by name (follow nextOffset to the last page);",
          '  a task that names WrongStack skills means these.',
        ]
      : []),
  ].join('\n');
}
