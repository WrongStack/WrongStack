/**
 * Host services the ACP leader provider needs but cannot get when it is built.
 *
 * Providers are created with the provider registry, before the agent exists;
 * the leader provider still has to put the agent's tool calls on the agent's
 * event bus, decide its permission requests with the leader's policy and ask
 * through the leader's confirmation prompt. The host (the CLI, the standalone
 * engine behind WebUI/desktop) binds these once the agent is created
 * (`bindAcpLeaderHost`); until then — or on a surface that
 * never binds them — the provider runs the agent with the read-only default
 * permission policy and shows no tool cards.
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, ConfirmAwaiter, PermissionPolicy, Tool } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';

/** The provider id an ACP agent leads under (`--provider acp --model claude-code`). */
export const ACP_LEADER_PROVIDER_ID = 'acp';

/** Leader providers whose factory lives in the host's registry, not in providers' own. */
const HOST_BUILT_LEADERS: ReadonlySet<string> = new Set([ACP_LEADER_PROVIDER_ID, 'wrongforge']);

/**
 * An agent leads under this provider id (the ACP leader, WrongForge): it has no
 * models.dev entry, so the catalog capability overlay must not replace its own
 * capabilities — the unsupported-family defaults (`streaming: false`) would send
 * every leader turn to `complete()`, the side path. Boot and every switch skip it.
 */
export function isHostBuiltLeader(providerId: string | undefined): boolean {
  return providerId !== undefined && HOST_BUILT_LEADERS.has(providerId);
}

export interface AcpLeaderHost {
  events: EventBus;
  projectRoot: string;
  /** The project's state directory, where a session's agent session is remembered for resume. */
  stateDir?: string | undefined;
  getConfig(): Config;
  /**
   * The live permission policy (it can change with YOLO and trust rules) of
   * the agent running `sessionId` — a WebUI tab's own; the leader's without one.
   */
  permission(sessionId?: string): PermissionPolicy;
  /** That agent's context, which the policy reads (files already read, the session). */
  context(sessionId?: string): Parameters<PermissionPolicy['evaluate']>[2];
  getTool(name: string): Tool | undefined;
  /** Every tool the leader has (the WrongForge leader offers them over its gateway). */
  listTools?(): Tool[];
  /**
   * Run one of the leader's tools as the leader would — the executor and
   * context of the agent running `sessionId`, so permissions, hooks, events
   * and the session all apply. Used by the fleet tools the agent reaches over
   * MCP (`delegate` and kin). A call the policy wants confirmed runs only when
   * `approve` says yes.
   */
  runTool(
    name: string,
    input: Record<string, unknown>,
    run?: {
      sessionId?: string | undefined;
      approve?: ((tool: Tool, input: Record<string, unknown>) => Promise<boolean>) | undefined;
      /**
       * Settle the call's tool card here: no tool_result reaches the
       * conversation, and the caller's own stream does not draw one (the
       * WrongForge leader's `wstack_*` calls). An ACP agent reports its fleet
       * calls itself, so its cards come from its stream instead.
       */
      announce?: boolean | undefined;
    },
  ): Promise<{ content: string; isError: boolean }>;
  /** The leader's confirmation prompt, when the surface has one. */
  confirmAwaiter?: ConfirmAwaiter | undefined;
  /**
   * The surface answers confirmations itself (TUI, WebUI): a question goes
   * out as a `tool.confirm_needed` event, the leader tools' own prompt.
   */
  confirmThroughEvents?: boolean | undefined;
}

/** The agent of a session, on a host that runs one agent per session (the WebUI's tabs). */
export type AcpLeaderSessionAgent = Pick<
  Agent,
  'ctx' | 'permission' | 'toolExecutor' | 'perIterationOutputCapBytes'
>;

/** Something holding live agent sessions: an ACP leader provider. */
interface LeaderSessions {
  closeAll(): Promise<void>;
}

interface AcpLeaderHostState {
  bound: AcpLeaderHost | undefined;
  sessionAgents: ((sessionId: string) => AcpLeaderSessionAgent | undefined) | undefined;
  liveLeaders: Set<LeaderSessions>;
}

/**
 * One binding per process. `@wrongstack/runtime` builds `acp-leader-host` (the
 * light entry the CLI loads on every exit) and `acp-leader` (the provider) as
 * separate bundles, each with its own copy of this module; the state lives on
 * `globalThis` so the provider reads the host the CLI or the engine bound.
 */
const STATE_KEY = Symbol.for('wrongstack.acp-leader.host');
const state: AcpLeaderHostState = (() => {
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: AcpLeaderHostState };
  holder[STATE_KEY] ??= { bound: undefined, sessionAgents: undefined, liveLeaders: new Set() };
  return holder[STATE_KEY];
})();

/** Set by a host with an agent per session; without it every session uses the leader. */
export function setAcpLeaderSessionAgents(
  resolve: ((sessionId: string) => AcpLeaderSessionAgent | undefined) | undefined,
): void {
  state.sessionAgents = resolve;
}

export function acpLeaderSessionAgent(sessionId: string): AcpLeaderSessionAgent | undefined {
  return state.sessionAgents?.(sessionId);
}

export function bindAcpLeaderHost(host: AcpLeaderHost | undefined): void {
  state.bound = host;
}

export function acpLeaderHost(): AcpLeaderHost | undefined {
  return state.bound;
}

/**
 * The surface took the prompt away (`agent.disableInteractiveConfirmation()`:
 * the TUI and WebUI answer confirmations themselves). The stdin prompt must
 * not be used under them: it would read the terminal Ink or the browser owns.
 * The agent's questions are asked the way the leader's own tools ask there.
 */
export function confirmAcpLeaderThroughEvents(): void {
  if (state.bound) {
    state.bound = { ...state.bound, confirmAwaiter: undefined, confirmThroughEvents: true };
  }
}

export function trackAcpLeader(leader: LeaderSessions): void {
  state.liveLeaders.add(leader);
}

/**
 * Close every ACP leader's agent sessions, bounded by `timeoutMs`. Called on
 * the way out: an open agent (and the MCP servers it started) otherwise holds
 * the process until the forced exit. Imports nothing heavy — it runs on every
 * CLI exit.
 */
export async function closeAcpLeaderSessions(timeoutMs = 1_500): Promise<void> {
  if (state.liveLeaders.size === 0) return;
  const all = [...state.liveLeaders];
  state.liveLeaders.clear();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(all.map((leader) => leader.closeAll().catch(() => undefined))),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}
