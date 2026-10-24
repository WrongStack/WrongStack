/**
 * ACPSubagentRunner — `SubagentRunner` implementation for DIR-1.
 *
 * Wraps an external ACP-supporting agent (Claude Code, Gemini CLI, Codex
 * CLI, Cline, Goose, OpenHands, etc.) as a WrongStack subagent. The
 * external agent runs its own agent loop; we send it a task via the ACP
 * v1 protocol and return the result.
 *
 * v1 spec: https://agentclientprotocol.com/protocol/v1/overview
 *
 * Connected to the Director / MultiAgentCoordinator via the
 * `SubagentRunner` interface (same shape as `AgentSubagentRunner`).
 */
import type {
  SubagentError,
  SubagentErrorKind,
  SubagentRunContext,
  SubagentRunner,
  SubagentRunOutcome,
  TaskSpec,
} from '@wrongstack/contracts/types';
import type { ACPSessionErrorKind } from '../client/acp-session.js';
import {
  type ACPProgressEvent,
  type ACPProgressHandler,
  ACPSession,
  ACPSessionError,
  textContent,
} from '../client/acp-session.js';
import { isJsonRpcError } from '../client/acp-session-errors.js';
import type { ACPSessionRunResult } from '../client/acp-session-types.js';
import { classifyAgentFailure } from './acp-agent-failure.js';
import { resolveAcpAgentCommand } from './acp-agent-probe.js';
import type { ACPSubagentRunnerOptions, AcpSessionSetup } from './acp-subagent-runner-options.js';

export type {
  AcpAgentCommandOverrides,
  AcpLiveCatalog,
  AcpProbeResult,
  ProbeAcpAgentsOptions,
} from './acp-agent-probe.js';
export {
  ACP_AGENT_COMMANDS,
  probeAcpAgent,
  probeAcpAgents,
  REGISTRY_ID_ALIASES,
  resolveAcpAgentCommand,
} from './acp-agent-probe.js';

export type { ACPSubagentRunnerOptions, AcpSessionSetup } from './acp-subagent-runner-options.js';

/**
 * Build a one-shot `SubagentRunner` for a single agent invocation. Each
 * call to the returned function spawns a fresh child process, runs one
 * prompt turn, and tears everything down. The cost is ~1 second of
 * process-startup per call; for long-lived sessions (multi-turn
 * conversations), use `makeACPSubagentRunnerWithStop` and call `stop()`
 * explicitly.
 */
export async function makeACPSubagentRunner(
  options: ACPSubagentRunnerOptions,
): Promise<SubagentRunner> {
  const { runner, stop } = await makeACPSubagentRunnerWithStop(options);
  // Wrap so we always tear down after the turn, even if the caller
  // forgot to call `stop()`. stop() is idempotent, so a double-call is
  // safe.
  const wrappedRunner: SubagentRunner = async (task, ctx) => {
    try {
      return await runner(task, ctx);
    } finally {
      stop();
    }
  };
  return wrappedRunner;
}

/**
 * Build a long-lived `SubagentRunner` plus an explicit `stop()` for
 * teardown. The caller is responsible for calling `stop()` when done
 * (or when the host's signal fires). Useful for the `wstack acp spawn`
 * CLI command, which holds the child open for the duration of a user
 * task and tears down on SIGINT.
 */
/** Running cost total last seen per session: the agent reports a session total, the budget wants turns. */
const sessionCostSeen = new WeakMap<ACPSession, number>();

function recordTurnUsage(
  ctx: SubagentRunContext,
  session: ACPSession,
  result: ACPSessionRunResult,
): Extract<ACPProgressEvent, { type: 'turn_usage' }> | undefined {
  const cost = result.usage?.cost;
  const total =
    cost?.currency === 'USD' && Number.isFinite(cost.amount) && cost.amount >= 0
      ? cost.amount
      : undefined;
  const turnCost =
    total === undefined ? 0 : Math.max(0, total - (sessionCostSeen.get(session) ?? 0));
  if (total !== undefined) sessionCostSeen.set(session, total);
  const t = result.tokens;
  if (!t && turnCost === 0) return undefined;
  try {
    ctx.budget.recordUsage(
      {
        input: t?.input ?? 0,
        output: t?.output ?? 0,
        cacheRead: t?.cacheRead ?? 0,
        cacheWrite: t?.cacheWrite ?? 0,
      },
      turnCost,
    );
  } catch {
    // Accounting must never fail a finished turn.
  }
  return { type: 'turn_usage', ...(t ? { tokens: t } : {}), costUsd: turnCost };
}

export async function makeACPSubagentRunnerWithStop(
  options: ACPSubagentRunnerOptions,
): Promise<{ runner: SubagentRunner; stop: () => void | Promise<void> }> {
  const projectRoot = options.projectRoot ?? options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const persistent = options.persistent === true;

  // In persistent mode we keep a single session alive across runner calls
  // so the external agent retains its conversation context (multi-turn).
  // Memoized start: concurrent first calls used to each spawn an agent and
  // overwrite the shared one, leaking every process but the last.
  let shared: Promise<ACPSession> | null = null;
  // Turns on the shared session run one at a time (it takes one prompt).
  let turns: Promise<unknown> = Promise.resolve();

  const startSession = async (setup: AcpSessionSetup | undefined): Promise<ACPSession> => {
    const mcpServers =
      setup?.mcpServers && setup.mcpServers.length > 0
        ? [...(options.mcpServers ?? []), ...setup.mcpServers]
        : options.mcpServers;
    const permissionPolicy = setup?.permissionPolicy ?? options.permissionPolicy;
    return ACPSession.start({
      command: options.command,
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      projectRoot,
      timeoutMs,
      ...(options.promptIdleTimeoutMs !== undefined
        ? { promptIdleTimeoutMs: options.promptIdleTimeoutMs }
        : {}),
      role: options.role,
      ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
      ...(mcpServers !== undefined ? { mcpServers } : {}),
      ...(setup?.meta ? { sessionMeta: setup.meta } : {}),
      ...(options.initialModeId ? { initialModeId: options.initialModeId } : {}),
      ...(options.requireInitialMode ? { requireInitialMode: true } : {}),
    });
  };

  const runner: SubagentRunner = async (
    task: TaskSpec,
    ctx: SubagentRunContext,
  ): Promise<SubagentRunOutcome> => {
    let session: ACPSession;
    let setup: AcpSessionSetup | undefined;
    try {
      setup = options.sessionSetup?.(task, ctx);
      if (persistent) {
        shared ??= startSession(setup);
        const starting = shared;
        session = await starting.catch((err: unknown) => {
          if (shared === starting) shared = null;
          throw err;
        });
      } else {
        session = await startSession(setup);
      }
    } catch (err) {
      // init / spawn failure. Throw a structured error so the host can
      // classify it (SubagentErrorKind).
      throw acpErrorToSubagentError(err, options.role ?? 'acp-subagent');
    }

    // Count real tool calls from the captured stream, and keep the
    // budget's idle clock fresh on every update so a long-but-working
    // external agent is never reaped by the watchdog as "stalled".
    const onProgress: ACPProgressHandler = (event: ACPProgressEvent) => {
      try {
        ctx.budget.markActivity();
      } catch {
        // markActivity never throws today; guard defensively anyway.
      }
      options.onProgress?.(event);
      try {
        options.publishLive?.(ctx, task, event);
      } catch {
        // Live UI must never fail the ACP turn.
      }
    };

    let result: ACPSessionRunResult;
    let endLive: (() => void) | undefined;
    try {
      if (session.canSteer()) endLive = options.onTurnLive?.(ctx, task, (t) => session.steer(t));
      const prompt = setup?.promptPrefix
        ? `${setup.promptPrefix}\n\n${task.description}`
        : task.description;
      const turn = () => session.prompt([textContent(prompt)], ctx.signal, onProgress);
      const run = persistent ? turns.then(turn, turn) : turn();
      if (persistent) turns = run;
      result = await run;
    } catch (err) {
      throw acpErrorToSubagentError(err, options.role ?? 'acp-subagent');
    } finally {
      endLive?.();
      // One-shot mode closes after each turn. Persistent mode keeps the
      // session open; the caller tears it down via stop().
      if (!persistent) {
        try {
          await session.close();
        } catch {
          // best-effort cleanup
        }
      }
    }

    // A resolved prompt is not automatically a completed task: the session
    // returns (rather than throws) a cancelled turn, and a refusal or a
    // token/turn limit also resolves. Those used to reach the coordinator as
    // `status: 'success'`, the same false green AgentSubagentRunner guards.
    // Charge the turn to the worker's budget like any subagent's, before a
    // failed turn is thrown: it consumed tokens all the same.
    const turnUsage = recordTurnUsage(ctx, session, result);
    // Fleet usage panels and `delegate.completed` read it off the live stream.
    if (turnUsage) onProgress(turnUsage);
    const failure = acpTurnFailure(result, options.role ?? 'acp-subagent');
    if (failure) throw failure;

    // Surface the real tool-call count captured from the stream. A text-less
    // turn that DID call tools is legitimate work; only a turn with neither
    // text nor tool calls is rejected above.
    return {
      result: result.text,
      iterations: 1,
      toolCalls: result.toolCalls.length,
    };
  };

  // In persistent mode stop() closes the long-lived session; in one-shot
  // mode it's a no-op (each session is closed in the runner's finally).
  const stop = async (): Promise<void> => {
    if (shared) {
      const starting = shared;
      shared = null;
      try {
        await (await starting).close();
      } catch {
        // best-effort (a failed start has nothing to close)
      }
    }
  };

  return { runner, stop };
}

// ─────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map an ACPSessionError (or arbitrary Error from the session layer)
 * to a structured `SubagentError` that the existing coordinator can
 * classify and act on. Unknown error shapes get `kind: 'unknown'` —
 * they shouldn't crash the parent.
 */
/**
 * The JSON-RPC error the agent answered with, wherever it sits in the cause
 * chain: a failed prompt arrives as prompt_failed → protocol_error → error.
 */
function agentRpcError(
  err: unknown,
): { code: number; message: string; data?: unknown } | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur; depth++) {
    if (isJsonRpcError(cur)) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function acpErrorToSubagentError(err: unknown, subagentId: string): SubagentError {
  // A provider failure the agent reported (quota spent, rate limit, signed
  // out) carries its own retry policy; a generic prompt failure does not.
  const rpc = agentRpcError(err);
  if (rpc) {
    const classified = classifyAgentFailure(rpc, subagentId);
    if (classified) return classified;
  }
  if (err instanceof ACPSessionError) {
    const kind = mapACPKind(err.kind);
    return {
      kind,
      message: `${subagentId}: ${err.message}`,
      retryable: isRetryable(kind),
      cause: {
        name: err.name,
        message: err.message,
        ...(err.stack !== undefined ? { stack: err.stack } : {}),
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: 'bridge_failed',
    message: `${subagentId}: ${message}`,
    retryable: false,
    cause: {
      name: err instanceof Error ? err.name : 'Error',
      message,
      ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
    },
  };
}

/**
 * Classify a resolved ACP turn that must not count as a completed task.
 * Unknown extension stop reasons (the protocol allows arbitrary strings) are
 * accepted as long as the turn produced something.
 */
function acpTurnFailure(result: ACPSessionRunResult, subagentId: string): SubagentError | null {
  const fail = (kind: SubagentErrorKind, detail: string): SubagentError => ({
    kind,
    message: `${subagentId}: ${detail}`,
    retryable: false,
  });
  switch (result.stopReason) {
    case 'cancelled':
      return fail('aborted_by_parent', 'prompt turn was cancelled before the task completed');
    case 'refusal':
      return fail('unknown', 'agent refused the task (stopReason=refusal)');
    case 'max_tokens':
      return fail(
        'budget_tokens',
        'agent hit its token limit before finishing (stopReason=max_tokens)',
      );
    case 'max_turn_requests':
      return fail(
        'budget_iterations',
        'agent hit its turn-request limit before finishing (stopReason=max_turn_requests)',
      );
  }
  if (!result.hasText && result.toolCalls.length === 0) {
    return fail('empty_response', 'agent ended its turn with no text and no tool calls');
  }
  return null;
}

function mapACPKind(acpKind: ACPSessionErrorKind): SubagentErrorKind {
  switch (acpKind) {
    case 'spawn_failed':
    case 'init_failed':
    case 'session_create_failed':
    case 'agent_died':
    case 'protocol_error':
      return 'bridge_failed';
    case 'prompt_failed':
      return 'tool_failed';
    case 'auth_failed':
    case 'logout_failed':
      return 'bridge_failed';
    case 'aborted':
      return 'aborted_by_parent';
    // The agent went silent mid-turn and the turn was cancelled.
    case 'stalled':
      return 'budget_timeout';
    case 'closed':
    case 'unsupported_capability':
      return 'unknown';
  }
}

function isRetryable(kind: SubagentErrorKind): boolean {
  // Conservative: spawn / init / protocol / agent-died are NOT
  // retryable as-is (they need config or a re-install). Timeouts and
  // prompt failures might be — the parent's classifier will branch on
  // `kind` and decide.
  // None of the ACP error kinds currently map to a retryable coordinator
  // kind. Keep the parameter so this policy remains explicit at the callsite.
  void kind;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Unused but exported for future use
// ─────────────────────────────────────────────────────────────────────────

/** Re-export so the CLI handler can import the session type. */
export type { ACPSession };

/** Exposed for the `wstack acp list` renderer. */
export function describeAgent(id: string): {
  command: string;
  args: readonly string[];
  role: string;
} | null {
  const entry = resolveAcpAgentCommand(id);
  if (!entry) return null;
  return {
    command: entry.command,
    args: entry.args ?? [],
    role: entry.role ?? id,
  };
}
