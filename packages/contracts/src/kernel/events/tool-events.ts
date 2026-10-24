import type { AgentContext } from '../../types/context.js';
import type { ToolOutputMetadata } from '../../types/context-evidence.js';
import type { PermissionDecision } from '../../types/permission.js';
import type {
  RiskTier,
  Tool,
  ToolErrorCategory,
  ToolProgressEvent,
  ToolSettlement,
} from '../../types/tool.js';
import type { UserInputRequest, UserInputResponse } from '../../types/user-input.js';

export interface ToolEventMap {
  /** A tool is blocked until an interactive surface submits this structured form. */
  'user.input_requested': {
    sessionId?: string | undefined;
    request: UserInputRequest;
    resolve: (response: UserInputResponse) => void;
  };
  /**
   * Closes mirrored forms after the first surface answers, the run aborts, or
   * (`unattended`) nobody answered during eternal / parallel autonomy.
   */
  'user.input_resolved': {
    sessionId?: string | undefined;
    requestId: string;
    response: UserInputResponse;
    source: 'user' | 'abort' | 'unattended';
  };
  /** Browser/HQ transport submits a candidate response to the owning awaiter. */
  'user.input_submitted': {
    sessionId?: string | undefined;
    response: UserInputResponse;
  };
  'tool.started': {
    sessionId?: string | undefined;
    traceId?: string | undefined;
    logicalRequestId?: string | undefined;
    promptManifestId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    name: string;
    id: string;
    input?: unknown | undefined;
    /** Kanban task this tool call belongs to, when known. */
    taskId?: string | undefined;
    /** Kanban board this tool call belongs to, when known. */
    boardId?: string | undefined;
    /** LLM provider that produced this tool call. */
    provider?: string | undefined;
    /** LLM model that produced this tool call. */
    model?: string | undefined;
  };
  /**
   * Fired when a tool call finishes successfully. Metrics collectors can count
   * calls and build latency histograms without parsing renderer output.
   */
  'tool.completed': {
    name: string;
    id: string;
    sessionId: string;
    traceId?: string | undefined;
    logicalRequestId?: string | undefined;
    promptManifestId?: string | undefined;
    agentId: string;
    durationMs: number;
    outputChars: number;
  };
  /**
   * Fired when a tool call throws. Does not include raw tool input/output.
   */
  'tool.failed': {
    name: string;
    id: string;
    sessionId: string;
    traceId?: string | undefined;
    logicalRequestId?: string | undefined;
    promptManifestId?: string | undefined;
    agentId: string;
    durationMs: number;
    category: ToolErrorCategory;
    retryable: boolean;
    detail?: string | undefined;
    errorCode?: string | undefined;
    errorSubsystem?: string | undefined;
    errorSeverity?: string | undefined;
    /**
     * Files the failing call is KNOWN to have left modified on disk — e.g.
     * `patch --merge` writing conflict markers. Populated only from a
     * `PartialWriteError`, where the tool verified each path by reading the
     * file back. These files are real damage despite the failure, so consumers
     * that report "what changed" must surface them (as presence, never as line
     * counts). Absent for a failure that touched nothing.
     */
    modifiedPaths?: string[] | undefined;
    /** Kanban task this tool call belongs to, when known. */
    taskId?: string | undefined;
    /** Kanban board this tool call belongs to, when known. */
    boardId?: string | undefined;
    /** LLM provider that produced this tool call. */
    provider?: string | undefined;
    /** LLM model that produced this tool call. */
    model?: string | undefined;
  };
  /**
   * Fired for each ToolProgressEvent yielded by `Tool.executeStream`. UIs
   * subscribe to render incremental progress (streaming bash output, file
   * tree counts, etc.) without the tool having to know about the UI.
   */
  'tool.progress': {
    sessionId?: string | undefined;
    traceId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    name: string;
    id: string;
    event: ToolProgressEvent;
  };
  /**
   * Fired once the permission policy and executor-level safety ceilings have
   * produced the effective authorization decision for a valid tool call.
   * Raw tool input is deliberately excluded; inputHash is computed after
   * secret scrubbing so Chronicle can correlate decisions without storing
   * credentials or command arguments.
   */
  'permission.evaluated': {
    sessionId?: string | undefined;
    traceId?: string | undefined;
    logicalRequestId?: string | undefined;
    promptManifestId?: string | undefined;
    agentId?: string | undefined;
    name: string;
    id: string;
    inputHash: string;
    policyDecision: PermissionDecision['permission'];
    effectiveDecision: PermissionDecision['permission'];
    decisionSource: PermissionDecision['source'];
    reason?: string | undefined;
    riskTier?: RiskTier | undefined;
    yoloEnabled: boolean;
    boundaryDecision?: 'allow' | 'confirm' | 'block' | undefined;
    boundaryReason?: string | undefined;
    capabilityDowngraded: boolean;
    /** Kanban task this tool call belongs to, when known. */
    taskId?: string | undefined;
    /** Kanban board this tool call belongs to, when known. */
    boardId?: string | undefined;
    /** LLM provider that produced this tool call. */
    provider?: string | undefined;
    /** LLM model that produced this tool call. */
    model?: string | undefined;
  };
  /**
   * Fired when a tool call needs confirmation
   * is registered on the executor. The TUI renders a confirmation dialog
   * from this event. Resolution is driven by calling the resolve function
   * passed in the payload with a decision string ('yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny').
   */
  'tool.confirm_needed': {
    sessionId?: string | undefined;
    tool: Tool;
    input: unknown;
    toolUseId: string;
    suggestedPattern: string;
    decisionSource?: PermissionDecision['source'] | undefined;
    riskTier?: RiskTier | undefined;
    /** Real write destinations from `Tool.writeTargets`, when declared (VULN-001 Phase 2). */
    writeTargets?: string[] | undefined;
    boundaryReason?: string | undefined;
    /** Wall-clock deadline after which Brain becomes the decision authority. */
    deadlineAt: number;
    resolve: (
      decision:
        | 'yes'
        | 'no'
        | 'always'
        | 'always-exact'
        | 'always-command'
        | 'always-tool'
        | 'deny',
    ) => void;
  };
  /**
   * Fired when a visible prompt settles, whatever settled it: a human answer
   * on any surface (`user`), an abort (`abort`), or the 120-second Brain
   * fallback (`brain_timeout`).
   *
   * `user` exists because a prompt is mirrored to more than one surface at
   * once (the local TUI/WebUI/SimpleUI dialog and the HQ dashboard). Without
   * an event on the ordinary path, HQ would keep offering buttons for a
   * decision already made at the keyboard.
   */
  'tool.confirm_resolved': {
    sessionId?: string | undefined;
    toolUseId: string;
    toolName: string;
    decision:
      | 'yes'
      | 'no'
      | 'always'
      | 'always-exact'
      | 'always-command'
      | 'always-tool'
      | 'deny'
      | 'abort';
    source: 'brain_timeout' | 'abort' | 'user';
    rationale?: string | undefined;
  };
  /**
   * Fired when the agent loop detects that the model is repeating itself —
   * a tight loop that would otherwise burn iterations indefinitely. In the
   * default `steer-then-cut` mode the first detection injects a corrective
   * note into the conversation (`action: 'steer'`) and lets the run
   * continue; persistent repetition cuts the turn with status
   * `max_iterations` (`action: 'cut'`). Legacy `cut` mode hard-stops on
   * first detection.
   *
   * Flavours caught by the same safety valve:
   *  - `kind: 'tool'` — the same tool(s) called with effectively the same
   *    inputs (catches k2p7's tendency to retry identical tool calls when
   *    a tool returns an unexpected empty result).
   *  - `kind: 'message'` — the same assistant text repeated, with no tool
   *    calls. K2P7 and other weak-instruction-following models can echo
   *    their last assistant turn verbatim across many iterations in
   *    autonomous-continue mode. The fingerprint also matches this case
   *    so the safety valve catches it too.
   *  - `kind: 'mixed'` — both: the response contains tool calls AND text,
   *    and the combined fingerprint (tool names + text) repeats.
   *
   * UIs can render a warning chip. The `kind`, `action`, and `scope` fields
   * are additive — older subscribers that only read `tools` continue to work.
   */
  'tool.loop_detected': {
    sessionId?: string | undefined;
    ctx: AgentContext;
    /** Comma-separated tool names involved in the loop, or empty string for pure message loops. */
    tools: string;
    /** Number of repeats detected (consecutive iterations, or identical calls within the window for `scope: 'call'`). */
    repeatCount: number;
    /** 0-based iteration index where the loop was detected. */
    iteration: number;
    /**
     * Shape of the loop. `tool` = identical tool calls; `message` = identical
     * text-only response; `mixed` = both tool calls and text repeated.
     * Defaults to `tool` for backward compatibility with subscribers that
     * pre-date the field.
     */
    kind?: 'tool' | 'message' | 'mixed' | undefined;
    /**
     * What the detector did. `steer` = a corrective note was folded into the
     * conversation and the run continues; `cut` = the turn was ended with
     * status `max_iterations`. Defaults to `cut` for subscribers that
     * pre-date the field.
     */
    action?: 'steer' | 'cut' | undefined;
    /**
     * Which detector fired. `iteration` = consecutive effectively-identical
     * iterations; `call` = the same (tool name + canonicalized args) call
     * repeated within the sliding window, possibly interleaved with other
     * calls (e.g. re-reading the same file for the 4th time).
     */
    scope?: 'iteration' | 'call' | undefined;
  };
  /**
   * `output` is a truncated preview of the tool's serialized result text
   * (capped at ~400 chars by the emitter). UIs render this inline in the
   * tool history line without re-fetching from the session log.
   */
  'tool.executed': {
    sessionId?: string | undefined;
    traceId?: string | undefined;
    logicalRequestId?: string | undefined;
    promptManifestId?: string | undefined;
    agentId?: string | undefined;
    agentName?: string | undefined;
    /**
     * The tool_use id (e.g. "toolu_…") issued by the provider for this call.
     * Pairs with `tool.started.id` so subscribers can correlate start/finish
     * even when the model fires multiple tools in parallel with identical
     * inputs.
     */
    id: string;
    name: string;
    durationMs: number;
    ok: boolean;
    /**
     * Typed outcome — why a call that is not `ok` did not succeed (denied,
     * declined, blocked, invalid input, aborted, or failed while running).
     * Absent only on legacy emit sites.
     */
    settlement?: ToolSettlement | undefined;
    /** Canonical tool-registry mutation classification; absent only on legacy emit sites. */
    mutating?: boolean | undefined;
    input?: unknown | undefined;
    /**
     * Files a successful call wrote, as the tool declares them through
     * `Tool.writeTargets` (the targets inside a `patch` diff, a `format` or
     * `lint --fix` target list). Absent when the tool declares none — read
     * `input.path` for the ordinary edit/write.
     */
    writeTargets?: string[] | undefined;
    output?: string | undefined;
    /**
     * The call ran outside this conversation (an ACP agent leading the
     * session runs its own tools): no tool_result will be appended, so
     * `output` is all a surface gets and it renders the card at once.
     */
    outsideConversation?: boolean | undefined;
    /**
     * With `outsideConversation`: the result beyond the `output` preview, as
     * the inspect/copy payload — no conversation tool_result holds it.
     * Bounded by the emitter; absent when `output` is already the whole text.
     */
    fullOutput?: string | undefined;
    /**
     * Legacy inline `--- SAGE: … (Memory Injector) ---` content split off
     * `output` before the preview cap. Current retrievals travel through
     * `memory.injector_run` and provider memory-evidence blocks instead.
     *
     * Surfaces render it as a memory card, never as tool output: sharing the
     * `output` budget used to cut a memory line mid-fence on short tool
     * results, and the mangled block then fell through to the plain-text
     * renderer. See `utils/sage-output-block.ts`.
     */
    sage?: string[] | undefined;
    /**
     * Full UTF-8 byte length of the serialized tool result that the model
     * actually sees (post-cap, post-scrub). The `output` preview is capped
     * at ~400 chars for transport; this number lets UIs surface what the
     * model is really paying tokens for. Optional only for legacy emit
     * sites that may not yet populate it.
     */
    outputBytes?: number | undefined;
    /**
     * Estimated token count for the full result body the model sees.
     * Computed from `outputBytes` with the standard ~3.5 chars/token
     * heuristic. Cheap to show in the TUI; not authoritative — the real
     * provider count lives in `provider.response.usage`. */
    outputTokens?: number | undefined;
    /**
     * For tools whose output has a clear "line" notion (file reads with
     * numbered prefixes, grep hits, bash stdout), the agent counts the
     * actual lines the model received and forwards it here. Undefined
     * for tools without a meaningful line count. */
    outputLines?: number | undefined;
    /**
     * Parsed context-management metadata for the result the model saw. This is
     * intentionally compact: file/symbol/error/path-integrity hints, not the
     * full output body. Compaction uses it to distinguish seen information from
     * information later referenced by the assistant.
     */
    metadata?: ToolOutputMetadata | undefined;
    /** Kanban task this tool call belongs to, when known. */
    taskId?: string | undefined;
    /** Kanban board this tool call belongs to, when known. */
    boardId?: string | undefined;
    /** LLM provider that produced this tool call. */
    provider?: string | undefined;
    /** LLM model that produced this tool call. */
    model?: string | undefined;
  };
  'mcp.server.connected': { name: string; toolCount: number };
  'mcp.server.reconnected': { name: string; toolCount: number };
  'mcp.server.disconnected': {
    name: string;
    reason: string;
    /**
     * True when the registry gave up on the server: connect attempts or
     * reconnect cycles are exhausted and nothing retries by itself — only
     * `/mcp restart <name>` does. Absent for a stop, an idle sleep or a drop
     * that an automatic reconnect follows, so a surface can tell the person
     * about the failures that need them and stay quiet about the rest.
     */
    terminal?: boolean | undefined;
  };
  /**
   * `notifications/resources/updated` for a resource this client subscribed to.
   * Carries the URI only — the content is fetched with `resources/read`.
   */
  'mcp.resource.updated': { name: string; uri: string };
  /**
   * `notifications/progress` (2024-11-05 progress utility) from a connected
   * MCP server. A server sends these only for requests whose `params._meta`
   * carried a `progressToken` — this host sends one on every `tools/call` —
   * so the token correlates the notification with the in-flight request.
   * `progress` normally increases monotonically toward `total`. The payload
   * is attacker-controllable server output: free text (`message`) is clamped
   * and control-character-sanitized before the event is published.
   */
  'mcp.progress': {
    name: string;
    progressToken: string | number;
    progress: number;
    total?: number | undefined;
    message?: string | undefined;
  };
  /**
   * `notifications/message` (2024-11-05 logging utility) from a connected MCP
   * server. `data` is the log content serialized to text and clamped;
   * `logger` names the emitting subsystem when the server sent one. Log
   * output is display-only — it must never influence tool-call, permission,
   * or sandbox decisions.
   */
  'mcp.log': {
    name: string;
    level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
    logger?: string | undefined;
    data?: string | undefined;
  };
  /**
   * OAuth state for one HTTP MCP server. Emitted by the host that owns the
   * token vault, so an expired or rejected credential is visible instead of
   * failing every call with an opaque 401. Carries no token or code.
   */
  'mcp.server.auth_state': {
    serverName: string;
    state: 'authorized' | 'refreshed' | 'reauth_required' | 'removed' | 'failed';
    resource: string;
    expiresAt?: number | undefined;
    scopes?: string[] | undefined;
    message?: string | undefined;
  };
  /**
   * Fired by `ToolRegistry.thinUnderused()` after auto-thinning disables
   * one or more tools. The names are the tools that actually flipped
   * (registered + not already disabled). `reason` is the human-readable
   * caller label (e.g. `'boot-time auto-thin'`, `'manual apply'`); the
   * audit-trail reason `'auto-thinned'` is also written to
   * `disabledToolMeta` so the decision survives restarts.
   */
  'tool.thinned': {
    names: string[];
    reason: string;
    at: number;
  };
}
