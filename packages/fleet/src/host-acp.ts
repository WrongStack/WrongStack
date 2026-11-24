import {
  type ACPProgressEvent,
  type AcpAgentCommandOverrides,
  type AcpLiveCatalog,
  type PermissionPolicy as AcpPermissionPolicy,
  type AcpSessionSetup,
  defaultPermissionPolicy,
  makeACPSubagentRunner,
  resolveAcpAgentCommand,
} from '@wrongstack/acp';
import type {
  Config,
  SubagentRunContext,
  SubagentRunner,
  TaskSpec,
} from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import {
  getSharedProjectMailbox,
  mailboxIdentityBase,
  resolveProjectDir,
  unreadCountForActor,
} from '@wrongstack/coordination';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { registerAcpSteerInbox } from './acp-live-steer.js';
import { type AcpPreflightSources, buildAcpPreflightContext } from './acp-preflight-context.js';
import { startAcpTurnReminders } from './acp-turn-reminders.js';
import {
  type BridgeServer,
  DEFAULT_BRIDGE_SERVERS,
  wrongstackBridgeSetup,
} from './acp-wrongstack-bridge.js';
import {
  startArchitectureDecisionRefresh,
  withArchitectureDecisions,
} from './architecture-decision-context.js';
import type { AcpProjectMcpGatewayFactory } from './host-types.js';
import {
  makeWrongForgeRunner,
  WRONGFORGE_AGENT_ID,
  type WrongForgeGatewaySpec,
} from './wrongforge-runner.js';

export type AcpLivePublisher = (
  ctx: SubagentRunContext,
  task: TaskSpec,
  event: ACPProgressEvent,
) => void;

export interface BuildAcpSubagentRunnerOptions {
  /**
   * Let the worker's `fs/*` calls reach absolute paths outside `projectRoot`,
   * as the host's own file tools may (`features.allowOutsideProjectRoot`).
   */
  allowOutsideProjectRoot?: boolean | undefined;
  /**
   * The project the worker works in: its cwd and file-access root. Without it
   * the worker ran in the host process's cwd — a subdirectory, or another
   * repository than the session's.
   */
  projectRoot?: string | undefined;
  overrides?: AcpAgentCommandOverrides | undefined;
  live?: AcpLiveCatalog | undefined;
  publishLive?: AcpLivePublisher | undefined;
  /** Project the worker runs in, plus `acp.bridge` config: see acp-wrongstack-bridge.ts. */
  bridge?:
    | { projectRoot: string; config?: NonNullable<Config['acp']>['bridge'] | undefined }
    | undefined;
  /**
   * WrongStack's permission rules for the worker's session (see
   * acp-permission-bridge.ts). When set, the worker is also started in its
   * `default` mode so it asks before edits and commands, whatever mode the
   * user runs the agent in on their own.
   */
  permissions?: ((ctx: SubagentRunContext) => AcpPermissionPolicy) | undefined;
  /** WrongStack tools a WrongForge worker may call back (see wrongforge-gateway.ts). */
  wrongforgeGateway?: (() => Promise<WrongForgeGatewaySpec | undefined>) | undefined;
  /** Optional shared loopback ProjectMcpGateway factory for zero-subprocess HTTP MCPs. */
  acpProjectMcpGateway?: AcpProjectMcpGatewayFactory | undefined;
  /** Optional pre-flight context sources (SAGE memories, Kanban card) prepended to user task prompt. */
  preflight?: AcpPreflightSources | undefined;
}

function withAcpPreflight(
  runner: SubagentRunner,
  sources: AcpPreflightSources | undefined,
): SubagentRunner {
  if (!sources) return runner;
  return async (task, ctx) => {
    const metaRec = (task as { metadata?: Record<string, unknown> }).metadata;
    const kanbanCardId =
      typeof metaRec?.['kanbanTaskId'] === 'string'
        ? metaRec['kanbanTaskId']
        : typeof metaRec?.['boardTaskId'] === 'string'
          ? metaRec['boardTaskId']
          : undefined;
    const block = await buildAcpPreflightContext({
      taskDescription: task.description,
      kanbanCardId,
      sources,
      signal: ctx.signal,
    });
    if (!block) return runner(task, ctx);
    return runner({ ...task, description: `${block}\n\n${task.description}` }, ctx);
  };
}

/**
 * Same command resolution as `wstack acp spawn` / `/acp` — user override,
 * bundled catalog, synced registry, then the legacy map. Director / `--bg`
 * must not use a different argv than the CLI spawn path.
 */
export function buildAcpSubagentRunner(
  subagentId: string,
  options?: BuildAcpSubagentRunnerOptions,
): Promise<SubagentRunner> {
  const decisionProjectRoot = options?.projectRoot ?? process.cwd();
  // WrongForge is an HTTP worker (its own server, task API), not an ACP child
  // process; it shares the external-agent route so `provider: "acp"` reaches it.
  if (subagentId === WRONGFORGE_AGENT_ID && !options?.overrides?.[WRONGFORGE_AGENT_ID]) {
    return Promise.resolve(
      withArchitectureDecisions(
        makeWrongForgeRunner({
          projectRoot: options?.projectRoot ?? process.cwd(),
          ...(options?.wrongforgeGateway ? { gateway: options.wrongforgeGateway } : {}),
          ...(options?.publishLive ? { publishLive: options.publishLive } : {}),
        }),
        decisionProjectRoot,
      ),
    );
  }
  const cmd = resolveAcpAgentCommand(subagentId, options?.overrides, options?.live);
  if (!cmd) {
    throw new ToolValidationError({
      message: `Unknown ACP agent: ${subagentId}`,
      field: 'subagentId',
      context: { requested: subagentId },
    });
  }
  // CLI /spawn and Director fan-out are trusted local agents (see
  // host-acp-runner-cache.ts) — pass the auto-approve policy explicitly.
  // Without it ACPSession falls back to readOnlyPermissionPolicy and
  // denies every file write / command the subagent requests.
  const bridgeSetup = options?.bridge
    ? wrongstackBridgeSetup(subagentId, options.bridge.projectRoot, options.bridge.config)
    : undefined;
  const mailboxProjectRoot = options?.bridge?.projectRoot;
  const mailboxEnabled =
    bridgeSetup !== undefined &&
    (options?.bridge?.config?.servers ?? DEFAULT_BRIDGE_SERVERS).includes('mailbox');
  const permissions = options?.permissions;
  const acpGateway = options?.acpProjectMcpGateway;
  const bridgeRoot = options?.bridge?.projectRoot;
  const sessionSetup =
    bridgeSetup || permissions
      ? async (task: TaskSpec, ctx: SubagentRunContext): Promise<AcpSessionSetup> => {
          const base = bridgeSetup?.(task, ctx);
          let grant:
            | {
                mcpServers: NonNullable<AcpSessionSetup['mcpServers']>;
                revoke(): void | Promise<void>;
              }
            | undefined;
          if (acpGateway && bridgeRoot && base?.mcpServers && base.mcpServers.length > 0) {
            const serverMap: Record<string, BridgeServer> = {
              'wrongstack-sage': 'sage',
              'wrongstack-mailbox': 'mailbox',
              'wrongstack-kanban': 'kanban',
              'wrongstack-index': 'codebase-index',
              'wrongstack-intake': 'requirement-intake',
            };
            const requestedServers = base.mcpServers
              .map((s) => serverMap[s.name])
              .filter((s): s is BridgeServer => s !== undefined);
            if (requestedServers.length > 0) {
              grant = await acpGateway({
                servers: requestedServers,
                projectRoot: bridgeRoot,
                worktreeCwd: ctx.config.cwd,
                actor: ctx.subagentId,
                sessionId: ctx.sessionId,
                role: ctx.config.role,
              }).catch(() => undefined);
            }
          }
          const baseCleanup = base?.cleanup;
          const grantRevoke = grant?.revoke;
          const cleanup =
            baseCleanup || grantRevoke
              ? async () => {
                  await Promise.resolve(baseCleanup?.()).catch(() => undefined);
                  await Promise.resolve(grantRevoke?.()).catch(() => undefined);
                }
              : undefined;
          return {
            ...base,
            ...(grant ? { mcpServers: [...grant.mcpServers, ...(base?.mcpServers ?? [])] } : {}),
            ...(cleanup ? { cleanup } : {}),
            ...(permissions ? { permissionPolicy: permissions(ctx) } : {}),
          };
        }
      : undefined;
  const projectRoot = options?.projectRoot;
  return makeACPSubagentRunner({
    ...cmd,
    ...(projectRoot ? { cwd: projectRoot, projectRoot } : {}),
    // Only behind the WrongStack permission bridge: reads outside the project
    // are put to it, and the auto-approve fallback would wave ~/.ssh through.
    ...(options?.allowOutsideProjectRoot && permissions ? { allowOutsideProjectRoot: true } : {}),
    permissionPolicy: defaultPermissionPolicy,
    // Claude asks before edits and commands only in `default`; left in the
    // user's own mode (often `auto`) it would never consult the policy.
    ...(permissions ? { initialModeId: 'default' } : {}),
    ...(permissions && subagentId === 'claude-code' ? { requireInitialMode: true } : {}),
    ...(options?.publishLive ? { publishLive: options.publishLive } : {}),
    ...(sessionSetup ? { sessionSetup } : {}),
    // The leader's `session_note` to a running worker joins its turn.
    onTurnLive: (ctx, task, steer) => {
      const stopDecisions = startArchitectureDecisionRefresh({
        projectRoot: decisionProjectRoot,
        task,
        signal: ctx.signal,
        steer,
      });
      const stopNotes = registerAcpSteerInbox(ctx, task, steer);
      const stopMail =
        mailboxEnabled && mailboxProjectRoot
          ? startAcpTurnReminders({
              steer,
              agentId: subagentId,
              // The actor-scoped projection every other mailbox surface uses.
              // The raw store count ignored the actor's base alias, so this
              // subagent could be told "no mail" while mail addressed to its
              // alias was already waiting in the mailbox.
              unreadCount: () =>
                unreadCountForActor(
                  getSharedProjectMailbox(
                    resolveProjectDir(mailboxProjectRoot, wstackGlobalRoot()),
                  ),
                  {
                    actorId: ctx.subagentId,
                    recipientAliases: new Set([mailboxIdentityBase(ctx.subagentId)]),
                    sessionId: ctx.sessionId,
                  },
                ),
            })
          : undefined;
      return () => {
        stopDecisions();
        stopNotes?.();
        stopMail?.();
      };
    },
  }).then((runner) =>
    withAcpPreflight(withArchitectureDecisions(runner, decisionProjectRoot), options?.preflight),
  );
}
