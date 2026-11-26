/**
 * What an ACP agent session is given when it starts leading a WrongStack
 * conversation: the project bridge, the fleet endpoint, the permission policy
 * and the form elicitation.
 *
 * The project services (index, memory, mailbox, kanban, intake) reach the agent
 * two ways. Over loopback HTTP from this process, on the workers'
 * `ProjectMcpGateway` grant: no child process, and the only way that works
 * inside the standalone desktop engine, whose main is the engine rather than
 * the CLI, so the bridge's `<process.execPath> mcp serve <name>` cannot run
 * there. And as the bridge's stdio descriptors, which `filterMcpServers`
 * keeps for an agent that cannot take HTTP.
 */
import type { ACPSessionOptions, AcpFormElicitationHandler } from '@wrongstack/acp';
import type { Config, SubagentRunContext } from '@wrongstack/contracts/types';
import { ProviderError } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  bridgeServersOf,
  sharedAcpProjectMcpGateway,
  wrongstackAcpPermissionPolicy,
  wrongstackBridgeSetup,
} from '@wrongstack/fleet';
import type { LeaderApprovals } from './acp-leader-approvals.js';
import {
  FLEET_SERVER_NAME,
  type FleetEndpoint,
  fleetNote,
  fleetToolName,
  startFleetEndpoint,
} from './acp-leader-fleet.js';
import type { AcpLeaderHost } from './acp-leader-host.js';
import type { AcpModule, LeaderProjectMcp } from './acp-leader-session.js';

/**
 * `--restricted` (CLI) sets this for the whole process and its children; MCP
 * servers are not started then, so the agent's own are refused as well. Read
 * from the environment so every host (CLI, standalone engine) answers alike.
 */
const RESTRICTED_PROCESS_ENV = 'WRONGSTACK_RESTRICTED';
const isRestrictedProcess = (): boolean => process.env[RESTRICTED_PROCESS_ENV] === '1';

export interface LeaderSessionSetupInput {
  acp: AcpModule;
  /** The WrongStack session the agent leads. */
  key: string;
  agentId: string;
  /** The provider's id, named in the error for an agent that is not installed. */
  providerId: string;
  config: Config;
  host: AcpLeaderHost | undefined;
  /** The leader agent's calls the user has to approve (see `LeaderApprovals`). */
  approvals: LeaderApprovals;
}

export interface LeaderSessionSetup {
  /** The project the agent works in: its cwd. */
  projectRoot: string;
  /** How the agent is started. */
  cmd: NonNullable<ReturnType<AcpModule['resolveAcpAgentCommand']>>;
  /** The bridge's task kickoff, put before the agent's first turn. */
  promptPrefix: string | undefined;
  /** The project services over loopback HTTP, then their stdio descriptors, then the fleet tools. */
  mcpServers: NonNullable<ACPSessionOptions['mcpServers']>;
  sessionMeta: ACPSessionOptions['sessionMeta'];
  permissionPolicy: ACPSessionOptions['permissionPolicy'];
  elicitForm: ACPSessionOptions['elicitForm'];
  fleet: FleetEndpoint | undefined;
  projectMcp: LeaderProjectMcp | undefined;
  /** Release the endpoints started for a session that never opened. */
  close(): Promise<void>;
}

export async function prepareLeaderSession(
  input: LeaderSessionSetupInput,
): Promise<LeaderSessionSetup> {
  const { acp, key, agentId, config, host, approvals } = input;
  const projectRoot = host?.projectRoot ?? process.cwd();
  const cmd = acp.resolveAcpAgentCommand(
    agentId,
    config.acp?.agents,
    acp.readCachedAcpRegistry()?.byId,
  );
  if (!cmd) {
    throw new ProviderError(
      `Unknown ACP agent "${agentId}". Run /acp to see the agents installed here.`,
      400,
      false,
      input.providerId,
      { kind: 'invalid_request' },
    );
  }
  // The bridge's MCP servers and the leader note. The bridge builds them for
  // a fleet run; the leader has no task or budget, only an identity.
  const leaderCtx = {
    subagentId: 'leader',
    config: { id: 'leader', name: agentId, role: 'leader' },
    sessionId: key,
  } as unknown as SubagentRunContext;
  const setup = wrongstackBridgeSetup(
    agentId,
    projectRoot,
    config.acp?.bridge,
    'leader',
  )?.({ id: 'leader', description: '' }, leaderCtx);
  // The same services from this process, so the leader does not depend on an
  // executable that can run `mcp serve`. Fail-open, like the workers': a
  // service this process cannot open keeps its stdio descriptor.
  const projectServers = bridgeServersOf(setup);
  const projectMcp =
    projectServers.length > 0
      ? await sharedAcpProjectMcpGateway({
          servers: projectServers,
          projectRoot,
          actor: 'leader',
          sessionId: key,
          role: 'leader',
        }).catch(() => undefined)
      : undefined;
  const fleet = host
    ? await startFleetEndpoint(host, {
        sessionId: key,
        approve: (tool, input) => approvals.approveFleetCall(key, tool, input),
      }).catch(() => undefined)
    : undefined;
  const mcpServers = [
    ...(projectMcp?.mcpServers ?? []),
    ...(setup?.mcpServers ?? []),
    ...(fleet
      ? [
          {
            type: 'http' as const,
            name: FLEET_SERVER_NAME,
            url: fleet.url,
            headers: [{ name: 'Authorization', value: `Bearer ${fleet.token}` }],
          },
        ]
      : []),
  ];
  const meta = setup?.meta as { systemPrompt?: { append?: string } } | undefined;
  const fleetAppendix = fleet ? fleetNote(fleet.tools) : undefined;
  const sessionMeta =
    meta?.systemPrompt?.append !== undefined
      ? {
          ...meta,
          systemPrompt: {
            ...meta.systemPrompt,
            append: meta.systemPrompt.append + (fleetAppendix ? `\n${fleetAppendix}` : ''),
          },
        }
      : fleetAppendix
        ? {
            ...(meta ?? {}),
            systemPrompt: {
              ...(meta?.systemPrompt ?? {}),
              append: fleetAppendix,
            },
          }
        : meta;
  const permissionPolicy = host
    ? wrongstackAcpPermissionPolicy({
        evaluate: (tool, input) => host.permission(key).evaluate(tool, input, host.context(key)),
        // A fleet tool is decided as the leader tool it runs, not as an MCP proxy.
        getTool: (name) => host.getTool(fleetToolName(name) ?? name),
        projectRoot,
        allowMcp: !isRestrictedProcess(),
        registeredMcpServers: mcpServers.map((s) => s.name),
        ...(host.confirmAwaiter || host.confirmThroughEvents
          ? { confirm: (tool, call, request) => approvals.confirm(key, tool, call.input, request) }
          : {}),
      })
    : undefined;
  const elicitForm: AcpFormElicitationHandler | undefined =
    host?.confirmThroughEvents && (host.context(key) as Context | undefined)?.userInputAwaiter
      ? async (form, signal) => {
          const { elicitAcpFormViaUserInput } = await import('@wrongstack/mcp');
          return elicitAcpFormViaUserInput(
            form.child ? `${agentId} / ${form.child.title ?? form.child.id}` : agentId,
            form,
            {
              requestUserInput: (request, formSignal = signal) => {
                const ctx = host.context(key) as Context | undefined;
                return (
                  ctx?.userInputAwaiter?.(request, {
                    sessionId: key,
                    signal: formSignal,
                    meta: ctx.meta,
                  }) ?? Promise.resolve(undefined)
                );
              },
            },
            signal,
          );
        }
      : undefined;
  return {
    projectRoot,
    cmd,
    promptPrefix: setup?.promptPrefix,
    mcpServers,
    sessionMeta,
    permissionPolicy,
    elicitForm,
    fleet,
    projectMcp,
    close: async () => {
      void fleet?.close().catch(() => undefined);
      await Promise.resolve(projectMcp?.revoke()).catch(() => undefined);
    },
  };
}
