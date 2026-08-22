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
} from '@wrongstack/core/types';
import type { ACPSessionErrorKind } from '../client/acp-session.js';
import {
  type ACPProgressEvent,
  type ACPProgressHandler,
  ACPSession,
  ACPSessionError,
  textContent,
} from '../client/acp-session.js';
import type { PermissionPolicy } from '../client/permission.js';
import { findAgentDescriptor } from '../registry/agents.catalog.js';
import type { McpServer } from '../types/acp-v1.js';

export interface ACPSubagentRunnerOptions {
  /** How to spawn the external agent. */
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  /** Subagent role label — surfaced in errors and used for logging. */
  role?: string | undefined;
  /**
   * Hard wall-clock cap for one prompt turn. Defaults to 5 minutes.
   * Overrides `SubagentRunContext.budget.limits.timeoutMs` if both are set.
   */
  timeoutMs?: number | undefined;
  /**
   * Filesystem sandbox root. Defaults to `options.cwd` (when set) or
   * the process's current working directory. All `fs/read_text_file` /
   * `fs/write_text_file` calls are bounded to this root.
   */
  projectRoot?: string | undefined;
  /**
   * Live progress callback. Forwarded to `ACPSession.prompt` so the host
   * can render the external agent's tool calls / diffs / text as they
   * stream, instead of waiting for the buffered final result.
   */
  onProgress?: ACPProgressHandler | undefined;
  /**
   * Permission policy for the external agent's `session/request_permission`
   * calls. Defaults to the session's own default. Inject the host's
   * confirm/trust UI here so an external agent's file writes / commands
   * are surfaced to a human instead of silently auto-approved.
   */
  permissionPolicy?: PermissionPolicy | undefined;
  /**
   * MCP servers to expose to the external agent (passed through
   * `session/new` / `session/load`). Stdio servers are always sent;
   * HTTP/SSE are filtered by the agent's advertised capabilities.
   */
  mcpServers?: McpServer[] | undefined;
  /**
   * When true, the underlying `ACPSession` is kept open across multiple
   * runner invocations (multi-turn conversation — the external agent
   * keeps its context). The caller MUST call `stop()` to tear it down.
   * Defaults to false (one process per task).
   */
  persistent?: boolean | undefined;
}

/**
 * Static catalog of agent ids → spawn options.
 *
 * The CLI and the host's `buildACPRunner` look up entries by id. The
 * canonical, multi-source catalog is `packages/acp/src/registry/agents.catalog.ts`
 * (the 12-entry static catalog introduced in commit 4ad287b4). This
 * map stays for backward compatibility with existing call sites that
 * import it directly; new code should prefer the registry.
 */
export const ACP_AGENT_COMMANDS: Record<string, ACPSubagentRunnerOptions> = {
  cline: {
    command: 'npx',
    args: ['-y', '@agentify/cline'],
    role: 'cline',
  },
  'gemini-cli': {
    command: 'gemini',
    role: 'gemini-cli',
  },
  copilot: {
    command: 'gh',
    args: ['copilot', 'agent'],
    role: 'copilot',
  },
  openhands: {
    command: 'openhands',
    role: 'openhands',
  },
  goose: {
    command: 'goose',
    role: 'goose',
  },
};

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
export async function makeACPSubagentRunnerWithStop(
  options: ACPSubagentRunnerOptions,
): Promise<{ runner: SubagentRunner; stop: () => void | Promise<void> }> {
  const projectRoot = options.projectRoot ?? options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const persistent = options.persistent === true;

  // In persistent mode we keep a single session alive across runner calls
  // so the external agent retains its conversation context (multi-turn).
  let shared: ACPSession | null = null;

  const startSession = async (): Promise<ACPSession> => {
    return ACPSession.start({
      command: options.command,
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      projectRoot,
      timeoutMs,
      role: options.role,
      ...(options.permissionPolicy !== undefined
        ? { permissionPolicy: options.permissionPolicy }
        : {}),
      ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
    });
  };

  const runner: SubagentRunner = async (
    task: TaskSpec,
    ctx: SubagentRunContext,
  ): Promise<SubagentRunOutcome> => {
    let session: ACPSession;
    const reuse = persistent && shared !== null;
    try {
      session = reuse ? (shared as ACPSession) : await startSession();
      if (persistent) shared = session;
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
    };

    try {
      const result = await session.prompt([textContent(task.description)], ctx.signal, onProgress);
      // Surface the real tool-call count captured from the stream. A
      // text-less turn is a soft signal (an ACP agent may legitimately
      // end with no message), not an error.
      return {
        result: result.text,
        iterations: 1,
        toolCalls: result.toolCalls.length,
      };
    } catch (err) {
      throw acpErrorToSubagentError(err, options.role ?? 'acp-subagent');
    } finally {
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
  };

  // In persistent mode stop() closes the long-lived session; in one-shot
  // mode it's a no-op (each session is closed in the runner's finally).
  const stop = async (): Promise<void> => {
    if (shared) {
      const s = shared;
      shared = null;
      try {
        await s.close();
      } catch {
        // best-effort
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
function acpErrorToSubagentError(err: unknown, subagentId: string): SubagentError {
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
  const entry = ACP_AGENT_COMMANDS[id];
  if (!entry) return null;
  return {
    command: entry.command,
    args: entry.args ?? [],
    role: entry.role ?? id,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Shared command resolution + single-task run + handshake probe
//
// These are the building blocks both the `wstack acp` CLI handler and the
// `/acp` slash command consume, so the two surfaces stay in lock-step.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Per-agent ACP invocation overrides, sourced from the user's
 * active profile config (`~/.wrongstack/profiles/<name>/config.json`,
 * `config.acp.agents`). Lets a user point an
 * agent id at the correct ACP entry — e.g. the Zed Claude-Code adapter —
 * without a code change. NEVER honoured from in-project config (it is an
 * arbitrary-command exec surface); see `config-loader.ts`.
 */
export type AcpAgentCommandOverrides = Record<
  string,
  { command: string; args?: string[]; env?: Record<string, string> }
>;

/** A synced-registry catalog keyed by registry id (from `fetchAcpRegistry`). */
export type AcpLiveCatalog = Record<
  string,
  { command: string; args?: readonly string[]; env?: Record<string, string> }
>;

/**
 * Map our stable, human-friendly catalog ids to the official registry's ids,
 * so a live-synced registry (keyed by registry id) still resolves when the
 * user types our id. Our id is preferred in the UI; the alias is the bridge.
 */
export const REGISTRY_ID_ALIASES: Readonly<Record<string, string>> = {
  'claude-code': 'claude-acp',
  'gemini-cli': 'gemini',
  'codex-cli': 'codex-acp',
  copilot: 'github-copilot-cli',
  // Kimi's live registry id is `kimi` — same as our catalog id, so the
  // alias is identity. Listed explicitly so `resolveAcpAgentCommand`
  // finds the live entry when the registry is synced.
  kimi: 'kimi',
};

/**
 * Resolve an agent id to its spawn command. Precedence:
 *   1. user override (`config.acp.agents[id]`)
 *   2. the bundled static `AGENTS_CATALOG` (curated LOCAL-binary invocations)
 *   3. live synced registry (`fetchAcpRegistry` → cache), by id or alias
 *   4. legacy `ACP_AGENT_COMMANDS` map (last resort, kept for back-compat)
 * Returns `null` for an id present in none of them.
 *
 * Why catalog BEFORE the live registry: our goal is to drive the user's
 * already-installed, logged-in CLI. The catalog hand-curates the LOCAL-binary
 * ACP entry for each popular agent (`gemini --acp`, `opencode acp`, …), which
 * preserves the agent's own login and starts instantly. The official registry,
 * by contrast, encodes "run a fresh copy" invocations — pinned `npx <pkg>@ver`
 * downloads (no local login, slow first run) and platform binaries like
 * `opencode.exe` that may not match a shim on PATH. So the registry is the
 * source for the long tail of agents the catalog doesn't cover, NOT an
 * override of the curated 12. Users force a specific command via the override.
 */
export function resolveAcpAgentCommand(
  id: string,
  overrides?: AcpAgentCommandOverrides,
  live?: AcpLiveCatalog,
): ACPSubagentRunnerOptions | null {
  const ov = overrides?.[id];
  if (ov && typeof ov.command === 'string' && ov.command.length > 0) {
    const out: ACPSubagentRunnerOptions = {
      command: ov.command,
      args: [...(ov.args ?? [])],
      role: id,
    };
    if (ov.env) out.env = ov.env;
    return out;
  }
  const desc = findAgentDescriptor(id);
  if (desc) {
    const out: ACPSubagentRunnerOptions = {
      command: desc.acp.command,
      args: [...(desc.acp.args ?? [])],
      role: id,
    };
    if (desc.acp.env) out.env = desc.acp.env;
    return out;
  }
  const liveEntry = live?.[id] ?? live?.[REGISTRY_ID_ALIASES[id] ?? ''];
  if (liveEntry && typeof liveEntry.command === 'string' && liveEntry.command.length > 0) {
    const out: ACPSubagentRunnerOptions = {
      command: liveEntry.command,
      args: [...(liveEntry.args ?? [])],
      role: id,
    };
    if (liveEntry.env) out.env = liveEntry.env;
    return out;
  }
  const fromMap = ACP_AGENT_COMMANDS[id];
  if (fromMap) return fromMap;
  return null;
}

export interface AcpProbeResult {
  id: string;
  ok: boolean;
  ms: number;
  agentInfo?: { name: string; title?: string | undefined; version: string } | undefined;
  error?: string | undefined;
}

/**
 * Empirically test whether an agent actually speaks ACP on this machine:
 * spawn it, run the `initialize` handshake, and close. `ok: true` means the
 * agent answered `initialize` within `timeoutMs` (default 8s) — the truth,
 * regardless of what the static catalog guesses. A bare CLI that drops into
 * an interactive prompt fails here (init times out) instead of hanging a
 * real turn.
 */
export async function probeAcpAgent(
  idOrCmd: string | ACPSubagentRunnerOptions,
  opts?: {
    timeoutMs?: number | undefined;
    projectRoot?: string | undefined;
    overrides?: AcpAgentCommandOverrides | undefined;
    live?: AcpLiveCatalog | undefined;
  },
): Promise<AcpProbeResult> {
  const id = typeof idOrCmd === 'string' ? idOrCmd : (idOrCmd.role ?? idOrCmd.command);
  const cmd =
    typeof idOrCmd === 'string'
      ? resolveAcpAgentCommand(idOrCmd, opts?.overrides, opts?.live)
      : idOrCmd;
  if (!cmd) return { id, ok: false, ms: 0, error: 'unknown agent' };

  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const startedAt = Date.now();
  let session: ACPSession | null = null;
  try {
    session = await ACPSession.start({
      command: cmd.command,
      ...(cmd.args !== undefined ? { args: cmd.args } : {}),
      ...(cmd.env !== undefined ? { env: cmd.env } : {}),
      projectRoot: opts?.projectRoot ?? process.cwd(),
      // Bounds the `initialize` request: a CLI that spawns but never answers
      // the handshake fails after this instead of blocking.
      timeoutMs,
    });
    const info = session.getAgentInfo();
    return {
      id,
      ok: true,
      ms: Date.now() - startedAt,
      ...(info ? { agentInfo: info } : {}),
    };
  } catch (err) {
    return {
      id,
      ok: false,
      ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // best-effort
      }
    }
  }
}

export interface ProbeAcpAgentsOptions {
  agentIds: string[];
  resolveCmd: (id: string) => ACPSubagentRunnerOptions | null;
  projectRoot?: string | undefined;
  /** Max agents probed at once. Default 4. Keeps concurrent first-run `npx`
   *  downloads from starving local agents' stdout past their timeout. */
  concurrency?: number | undefined;
  /** Per-agent handshake timeout for LOCAL binary commands. Default 20s. */
  timeoutMs?: number | undefined;
  /** Per-agent timeout for `npx`/`uvx` commands (first run downloads the
   *  package, which is slow). Default 90s. */
  packageTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((id: string, result: AcpProbeResult) => void) | undefined;
}

/**
 * Probe many agents with BOUNDED concurrency. Unbounded `Promise.all` over the
 * full set spawns every agent at once — and a few concurrent `npx` downloads
 * peg the machine hard enough that even already-installed local agents miss
 * their handshake window. Bounding the fan-out (and giving npx/uvx a longer
 * timeout) is what makes a mixed install probe reliably.
 */
export async function probeAcpAgents(opts: ProbeAcpAgentsOptions): Promise<AcpProbeResult[]> {
  const localTimeout = opts.timeoutMs ?? 20_000;
  const pkgTimeout = opts.packageTimeoutMs ?? 90_000;
  const ids = opts.agentIds;
  const byId = new Map<string, AcpProbeResult>();

  // Partition: local binaries vs npx/uvx package launchers. A first-run `npx`
  // download is heavy enough to starve a LOCAL agent sharing the same batch
  // (its stdout 'data' misses the handshake window → false timeout). So probe
  // all locals first (clean resources, fast), THEN the package ones — which
  // are inherently slow on first run — at low concurrency.
  const local: string[] = [];
  const pkg: string[] = [];
  const cmds = new Map<string, ACPSubagentRunnerOptions | null>();
  for (const id of ids) {
    const cmd = opts.resolveCmd(id);
    cmds.set(id, cmd);
    if (!cmd) continue;
    if (cmd.command === 'npx' || cmd.command === 'uvx') pkg.push(id);
    else local.push(id);
  }

  const runPhase = async (
    phaseIds: string[],
    concurrency: number,
    timeoutMs: number,
  ): Promise<void> => {
    let next = 0;
    const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, phaseIds.length));
    const workers: Promise<void>[] = [];
    for (let w = 0; w < workerCount; w++) {
      workers.push(
        (async () => {
          while (true) {
            const current = next++;
            if (current >= phaseIds.length) return;
            const id = phaseIds[current]!;
            if (opts.signal?.aborted) {
              byId.set(id, { id, ok: false, ms: 0, error: 'aborted' });
              continue;
            }
            const cmd = cmds.get(id)!;
            const r = await probeAcpAgent(cmd!, {
              timeoutMs,
              ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
            });
            r.id = id; // probeAcpAgent derives id from cmd.role; pin to our id.
            byId.set(id, r);
            opts.onProgress?.(id, r);
          }
        })(),
      );
    }
    await Promise.all(workers);
  };

  // Unknown ids resolve to null — record immediately.
  for (const id of ids) {
    if (cmds.get(id) === null) {
      const r: AcpProbeResult = { id, ok: false, ms: 0, error: 'unknown agent' };
      byId.set(id, r);
      opts.onProgress?.(id, r);
    }
  }

  await runPhase(local, opts.concurrency ?? 4, localTimeout);
  // Package launchers run AFTER locals (so npm downloads never starve a local
  // agent's handshake), at low concurrency with a long timeout — first-run
  // `npx`/`uvx` fetches are inherently slow.
  await runPhase(pkg, 2, pkgTimeout);

  // Preserve the caller's input order.
  return ids.map((id) => byId.get(id)!);
}
