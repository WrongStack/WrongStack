/** Options for {@link makeACPSubagentRunner} (split out to keep the runner file small). */
import type { SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import type { ACPProgressEvent, ACPProgressHandler } from '../client/acp-session.js';
import type { AcpSteerOutcome } from '../client/acp-session-ops.js';
import type { PermissionPolicy } from '../client/permission.js';
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
   * Cap for each request to the agent other than a prompt turn (initialize,
   * session/new, …). Defaults to 5 minutes. A prompt turn has no length cap:
   * it ends when the agent finishes, is aborted through `ctx.signal`, or goes
   * silent for `promptIdleTimeoutMs`.
   */
  timeoutMs?: number | undefined;
  /** See `ACPSessionOptions.promptIdleTimeoutMs`. Default 10 minutes. */
  promptIdleTimeoutMs?: number | undefined;
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
   * Host live-view hook. Called with the run context so a fleet/TUI/WebUI
   * publisher can attribute tool calls and text to the right subagent.
   * Invoked in addition to `onProgress`.
   */
  publishLive?:
    | ((ctx: SubagentRunContext, task: TaskSpec, event: ACPProgressEvent) => void)
    | undefined;
  /**
   * Called while a turn runs on an agent that accepts steering, with a
   * function that injects a message into that turn; the returned function is
   * called when the turn ends. Lets the host route live notes to the worker.
   */
  onTurnLive?:
    | ((
        ctx: SubagentRunContext,
        task: TaskSpec,
        steer: (text: string) => Promise<AcpSteerOutcome>,
      ) => (() => void) | undefined)
    | undefined;
  /**
   * Permission policy for the external agent's `session/request_permission`
   * calls. Defaults to the session's own default. Inject the host's
   * confirm/trust UI here so an external agent's file writes / commands
   * are surfaced to a human instead of silently auto-approved.
   */
  permissionPolicy?: PermissionPolicy | undefined;
  /** Session mode to switch to after `session/new` (see ACPSessionOptions.initialModeId). */
  initialModeId?: string | undefined;
  /** Fail the session when the agent does not offer `initialModeId`. */
  requireInitialMode?: boolean | undefined;
  /**
   * MCP servers to expose to the external agent (passed through
   * `session/new` / `session/load`). Stdio servers are always sent;
   * HTTP/SSE are filtered by the agent's advertised capabilities.
   */
  mcpServers?: McpServer[] | undefined;
  /**
   * Per-session setup, computed from the task and run context each time a
   * session starts (once per task, or once for a persistent session): extra
   * MCP servers, appended to `mcpServers`, and the `_meta` for `session/new`.
   * Lets the host give each worker its own identity on shared channels.
   */
  sessionSetup?: ((task: TaskSpec, ctx: SubagentRunContext) => AcpSessionSetup) | undefined;
  /**
   * When true, the underlying `ACPSession` is kept open across multiple
   * runner invocations (multi-turn conversation — the external agent
   * keeps its context). The caller MUST call `stop()` to tear it down.
   * Defaults to false (one process per task).
   */
  persistent?: boolean | undefined;
}

export interface AcpSessionSetup {
  mcpServers?: McpServer[] | undefined;
  meta?: Record<string, unknown> | undefined;
  /** Per-task guidance placed before the user's task in the ACP prompt turn. */
  promptPrefix?: string | undefined;
  /** Replaces `permissionPolicy` for this session (e.g. bound to the delegating session). */
  permissionPolicy?: PermissionPolicy | undefined;
}
