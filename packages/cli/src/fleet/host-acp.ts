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
import { getSharedProjectMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { registerAcpSteerInbox } from './acp-live-steer.js';
import { startAcpTurnReminders } from './acp-turn-reminders.js';
import { DEFAULT_BRIDGE_SERVERS, wrongstackBridgeSetup } from './acp-wrongstack-bridge.js';
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
  // WrongForge is an HTTP worker (its own server, task API), not an ACP child
  // process; it shares the external-agent route so `provider: "acp"` reaches it.
  if (subagentId === WRONGFORGE_AGENT_ID && !options?.overrides?.[WRONGFORGE_AGENT_ID]) {
    return Promise.resolve(
      makeWrongForgeRunner({
        projectRoot: options?.projectRoot ?? process.cwd(),
        ...(options?.wrongforgeGateway ? { gateway: options.wrongforgeGateway } : {}),
        ...(options?.publishLive ? { publishLive: options.publishLive } : {}),
      }),
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
  const sessionSetup =
    bridgeSetup || permissions
      ? (task: TaskSpec, ctx: SubagentRunContext): AcpSessionSetup => ({
          ...bridgeSetup?.(task, ctx),
          ...(permissions ? { permissionPolicy: permissions(ctx) } : {}),
        })
      : undefined;
  const projectRoot = options?.projectRoot;
  return makeACPSubagentRunner({
    ...cmd,
    ...(projectRoot ? { cwd: projectRoot, projectRoot } : {}),
    permissionPolicy: defaultPermissionPolicy,
    // Claude asks before edits and commands only in `default`; left in the
    // user's own mode (often `auto`) it would never consult the policy.
    ...(permissions ? { initialModeId: 'default' } : {}),
    ...(permissions && subagentId === 'claude-code' ? { requireInitialMode: true } : {}),
    ...(options?.publishLive ? { publishLive: options.publishLive } : {}),
    ...(sessionSetup ? { sessionSetup } : {}),
    // The leader's `session_note` to a running worker joins its turn.
    onTurnLive: (ctx, task, steer) => {
      const stopNotes = registerAcpSteerInbox(ctx, task, steer);
      const stopMail =
        mailboxEnabled && mailboxProjectRoot
          ? startAcpTurnReminders({
              steer,
              unreadCount: () =>
                getSharedProjectMailbox(
                  resolveProjectDir(mailboxProjectRoot, wstackGlobalRoot()),
                ).unreadCount(ctx.subagentId, ctx.sessionId),
            })
          : undefined;
      return () => {
        stopNotes?.();
        stopMail?.();
      };
    },
  });
}
