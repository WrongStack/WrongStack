import type { ToolResultBlock, ToolUseBlock } from './blocks.js';
import type { AgentContext } from './context.js';

export type Permission = 'auto' | 'confirm' | 'deny';

/**
 * Risk tier for tools in UI/audit surfaces. YOLO auto-approves non-denied
 * calls regardless of risk tier; when YOLO is off, risk can inform prompts.
 *
 * - `safe`       — read-only, no side effects (read, glob, grep, etc.)
 * - `standard`   — non-destructive writes and mutations (write, edit, safe shell commands)
 * - `destructive` — irreversible or broadside effects (recursive deletes, db drops, etc.)
 */
export type RiskTier = 'safe' | 'standard' | 'destructive';

/**
 * Icon identifiers for tools — each UI (WebUI/TUI/REPL) maps these to its own icon library.
 * Add the icon directly on each Tool so all UIs consume the same canonical value.
 */
export type ToolIconId =
  | 'file' // read, write — document operations
  | 'edit' // edit, patch — modifying files
  | 'search' // grep, search — searching content
  | 'folder' // glob — file discovery
  | 'terminal' // bash, exec — shell commands
  | 'web' // fetch — HTTP requests
  | 'git' // git — version control
  | 'tree' // tree — directory structure
  | 'code' // lint, format, typecheck — code quality
  | 'test' // test — testing
  | 'package' // install, audit, outdated — package management
  | 'document' // document — documentation
  | 'scaffold' // scaffold — project generation
  | 'todo' // todo — task tracking
  | 'plan' // plan — planning
  | 'task' // task — structured work items
  | 'meta' // tool-use, batch-tool-use, tool-search, tool-help — meta tools
  | 'index' // codebase-index, codebase-search, codebase-stats — code indexing
  | 'json' // json — JSON operations
  | 'diff' // diff — comparing changes
  | 'logs' // logs — log viewing
  | 'settings' // set-working-dir — configuration
  | 'fallback'; // unknown tool — fallback icon

export interface JSONSchema {
  type?: string | undefined;
  properties?: Record<string, JSONSchema>;
  required?: string[] | undefined;
  items?: JSONSchema | undefined;
  enum?: unknown[] | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  additionalProperties?: boolean | JSONSchema | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  patternProperties?: Record<string, JSONSchema> | undefined;
  allOf?: JSONSchema[] | undefined;
  anyOf?: JSONSchema[] | undefined;
  oneOf?: JSONSchema[] | undefined;
  pattern?: string | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  uniqueItems?: boolean | undefined;
  description?: string | undefined;
  [k: string]: unknown;
}

/**
 * Tool progress event — yielded by `Tool.executeStream` to give the UI
 * something to render while a long-running tool works. The executor
 * publishes each event via EventBus as `tool.progress` so the TUI, logger,
 * and observability layer can consume them uniformly.
 *
 * Keep events small. They are buffered through the EventBus synchronously
 * and rendered on the main thread.
 */
export interface ToolProgressEvent {
  /**
   * - `log`           — verbose informational message (e.g. "scanning…")
   * - `warning`       — non-fatal issue (e.g. "skipped X due to ENOENT")
   * - `metric`        — numeric data (e.g. files scanned so far)
   * - `file_changed`  — a tool that mutates the workspace announces a write
   * - `partial_output` — stream of textual output (bash stdout, fetch body)
   */
  type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
  text?: string | undefined;
  data?: Record<string, unknown>;
  /** Canonical or project-relative target for file_changed events. */
  path?: string | undefined;
  operation?: 'write' | 'edit' | 'delete' | 'rename' | undefined;
  line?: number | undefined;
  endLine?: number | undefined;
}

/**
 * Terminal event for `executeStream`. The output must match the tool's
 * declared output type — the executor unwraps `output` and treats it like
 * a normal `execute` return value.
 */
export interface ToolFinalEvent<O> {
  type: 'final';
  output: O;
}

export type ToolStreamEvent<O = unknown> = ToolProgressEvent | ToolFinalEvent<O>;

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  /**
   * Pre-computed token estimate for this tool's definition (name +
   * description + JSON-serialized inputSchema). Set by ToolRegistry on
   * registration; consumed by estimateToolDefTokens / estimateRequestTokens
   * to skip redundant JSON.stringify on every context-pressure check.
   */
  _estDefTokens?: number | undefined;
  usageHint?: string | undefined;
  /**
   * Optional host-side, read-only contextual guidance. This is NOT execution:
   * it must not import project executable code, call tools or mutate files.
   * Tool Coach invokes it once per user turn, only for enabled auto/read tools
   * whose declared metadata input is also auto-allowed by the current policy.
   * The host bounds its deadline and note size; failures omit the advice.
   */
  turnGuidance?:
    | {
        /** Enabled executable routes needed to make this advice actionable. */
        requiredTools?: readonly string[] | undefined;
        permissionInput: unknown;
        create(options: { task: string; projectRoot: string; signal: AbortSignal }): Promise<{
          initialNote: string | null;
          afterTools(
            uses: readonly ToolUseBlock[],
            results: readonly ToolResultBlock[],
            settlements?: ReadonlyMap<string, ToolSettlement>,
          ): string | null;
        }>;
      }
    | undefined;
  /** Structured guidance for choosing between similar tools. */
  selection?:
    | {
        /** A concise boundary where this tool should not be selected. */
        doNotUseWhen: string;
        /** Tool names the model should prefer for that boundary. */
        useInstead?: readonly string[] | undefined;
      }
    | undefined;
  /**
   * Values the system-prompt builder interpolates into this tool's guidance
   * section (e.g. `delegate` → `roleList`). Host-side only: never part of the
   * wire definition, so it costs no schema tokens on every request.
   */
  promptVars?: Readonly<Record<string, string>> | undefined;
  /** Optional category for grouping in help lists and system prompts. */
  category?: string | undefined;
  inputSchema: JSONSchema;
  /**
   * Optional canonical JSON output contract for tools.data(name, input) in ToolFlow.
   * The executor validates and scrubs the value before exposing it. Text calls
   * retain their existing serializer, preview and budget behavior.
   */
  outputSchema?: JSONSchema | undefined;
  /** Pure projection for structured callers; defaults to the execute result. */
  programmaticOutput?(output: O, input: I): unknown;
  permission: Permission;
  mutating: boolean;
  /**
   * Risk tier for selective YOLO gating. When YOLO is active, clearly
   * destructive calls still emit `confirm`. Defaults to `standard` when
   * omitted — callers should always check `riskTier` after the basic
   * permission decision.
   */
  riskTier?: RiskTier | undefined;
  /**
   * Input-field name that the permission policy should match trust rules
   * against. Without this, the policy falls back to a heuristic
   * (`command` / `path` / `url` / `name`) that can collide across tools —
   * e.g. an HTTP tool whose `path` means "request path" would be checked
   * against filesystem-path trust rules. Set explicitly to avoid the
   * cross-tool subject collision.
   *
   * The named field's value must be a string at runtime; non-string values
   * fall back to the heuristic.
   */
  subjectKey?: string | undefined;
  /**
   * Extra input fields folded into the permission subject, after `subjectKey`.
   *
   * For a shell-style tool the subject is the whole command line, so the trust
   * rule is as specific as the invocation. A tool whose parameters are NAMED
   * FIELDS rather than an argv array has no such luck: `git` sets
   * `subjectKey: 'command'`, whose value is an enum subcommand, so every
   * `git push` — any branch, `force` or not — rendered to the subject `"push"`
   * and one "always allow" covered them all (audit 2026-08-20).
   *
   * List the fields that change what the call actually does. Absent fields are
   * skipped, so adding a field only narrows existing rules (they degrade to a
   * confirm prompt) and never silently widens one.
   */
  subjectFields?: readonly string[] | undefined;
  maxOutputBytes?: number | undefined;
  /**
   * Return the serialized tool result to the model without artifact previewing
   * or iteration-budget truncation. The output still consumes the remaining
   * iteration budget for accounting; an oversized result reduces it to zero.
   *
   * Use only when completeness is part of the tool contract and the tool
   * already bounds its own work. Most tools must stay on the default bounded
   * path to avoid flooding the model context.
   */
  preserveFullOutput?: boolean | undefined;
  timeoutMs?: number | undefined;
  /**
   * The tool owns its timeout/idle policy and only needs the executor to
   * propagate the parent abort signal. Use this sparingly for orchestration
   * tools such as `delegate` that already enforce a heartbeat-aware timeout;
   * otherwise the executor's fixed max-tool timeout can kill healthy work.
   */
  managesOwnTimeout?: boolean | undefined;
  /**
   * Hint for the TUI spinner — does NOT affect actual timeout enforcement.
   * Use `timeoutMs` for hard limits. Leave undefined when duration varies
   * unpredictably.
   */
  estimatedDurationMs?: number | undefined;

  /**
   * Declarative security capabilities granted by this tool.
   *
   * Examples: "shell.arbitrary", "fs.write", "fs.write.outside-project",
   * "net.outbound", "mcp.proxy", "subagent.spawn", "config.mutate".
   *
   * These are used by permission policies (especially subagent guards) and
   * future capability-based allowlists. Prefer well-known values over ad-hoc strings.
   *
   * This field is optional for backward compatibility. Tools without it are
   * treated conservatively by guards.
   */
  capabilities?: readonly string[] | undefined;
  /**
   * Icon identifier for this tool — consumed by all UIs (WebUI/TUI/REPL) to
   * render a tool-specific icon instead of a generic fallback.
   * Each UI maps this id to its own icon library.
   */
  icon?: ToolIconId | undefined;
  execute(
    input: I,
    ctx: AgentContext,
    opts: {
      signal: AbortSignal;
      /** The id of this call, when the executor runs it for a `tool_use` block. */
      toolUseId?: string | undefined;
      /** Effective session mode supplied by the host after permission checks. */
      autonomy?: 'prompt' | 'yolo' | 'yolo-plus' | undefined;
    },
  ): Promise<O>;
  /**
   * Optional cross-field validation hook. Called by the executor AFTER
   * JSON Schema validation passes and AFTER PreToolUse hooks may have
   * rewritten the input, but BEFORE permission checks and execution.
   *
   * Use this for invariants the JSON Schema cannot express — e.g.
   * `old_string !== new_string` in edit, or `end > start` in a range tool.
   * Return an array of validation errors (empty = valid). The executor
   * surfaces them to the model just like schema validation errors, so the
   * model can self-correct without the tool's `execute()` running.
   *
   * P3 #16 (before-release.md): tools that implement cross-field checks
   * inside `execute()` can migrate them here for earlier rejection and
   * consistent error formatting.
   */
  validate?(input: I): string[];
  /**
   * Optional declaration of the filesystem paths this call would write.
   *
   * Called synchronously by the permission layer BEFORE execution for two
   * consumers (VULN-001 Phase 2): the agent-state write gate in both
   * permission policies (which unions this with its input-key heuristic, so
   * the result can only ever ADD scrutiny) and the confirmation prompt
   * payload (`ToolConfirmPendingResult` / `tool.confirm_needed`), so the
   * user sees real destinations instead of an innocuous `subjectKey` value.
   *
   * Use this when destinations live inside a payload body the heuristic
   * cannot see — e.g. `patch`'s destinations are encoded in its diff text,
   * while its permission subject is just `directory: "."`.
   *
   * Contract:
   * - Synchronous and pure — no I/O, no ctx access, no throwing. A hook that
   *   throws is treated as absent (the heuristic alone decides).
   * - Best-effort candidates, typically relative and pre-realpath. This is
   *   VISIBILITY, not authorization: `execute()` remains the authority on
   *   whether any destination is actually permitted (containment, realpath
   *   checks, fail-closed refusals).
   */
  writeTargets?(input: I): string[];
  /**
   * Optional streaming variant. When defined, the executor prefers this
   * over `execute` — yielded events become `tool.progress` EventBus events
   * and the terminal `final` event provides the output. Tools that don't
   * have intermediate state shouldn't implement this; the default `execute`
   * path is more efficient.
   */
  executeStream?(
    input: I,
    ctx: AgentContext,
    opts: { signal: AbortSignal; autonomy?: 'prompt' | 'yolo' | 'yolo-plus' | undefined },
  ): AsyncIterable<ToolStreamEvent<O>>;
  /**
   * Optional teardown hook fired by the executor when the tool's run is
   * aborted (signal triggered). Errors thrown here are swallowed so they
   * never mask the originating failure.
   *
   * **When to use `cleanup` vs `ctx.registerAbortHook`:**
   *
   * - Use `cleanup` for resources **owned by the tool author** that are
   *   established at execute-time: child processes spawned by the tool,
   *   file handles opened by the tool, network connections initiated by
   *   the tool. The lifecycle is co-located with the tool definition, so
   *   readers see the resource and its teardown in one place.
   *
   *   ```ts
   *   async execute(input, ctx, opts) {
   *     const child = spawn(...);
   *     // … tool work …
   *   },
   *   async cleanup(_input, _ctx) {
   *     // best-effort kill of any child still running
   *   }
   *   ```
   *
   * - Use `ctx.registerAbortHook` for **context-scoped teardown** registered
   *   dynamically inside `execute`: when the tool delegates to a library
   *   that needs cancellation, or when the resource is created lazily
   *   somewhere down the call stack and the natural cleanup point isn't
   *   at the tool boundary. The hook fires when the **agent run** ends,
   *   not when this specific tool call aborts.
   *
   *   ```ts
   *   async execute(input, ctx, opts) {
   *     const handle = openHelper();
   *     ctx.registerAbortHook(() => handle.dispose());
   *     // … work …
   *   }
   *   ```
   *
   * If both are registered for the same resource, `cleanup` fires first
   * (on tool abort) and the abort-hook fires after on the wider run abort.
   * Avoid double-free by gating one on the other's effect, or pick a single
   * teardown channel per resource.
   */
  cleanup?(input: I, ctx: AgentContext): Promise<void>;
  /**
   * Optional custom output serializer. When present, the executor's output
   * serializer calls this INSTEAD of the central `renderToolObject()` switch
   * — the tool owns its own pretty-printing.
   *
   * Return a string representation of the output that the model will see in
   * its tool_result block. By default the executor applies artifact previewing
   * and the iteration output cap after this runs. Tools whose contract requires
   * the complete serialized result may explicitly set `preserveFullOutput`.
   *
   * P3 #21 (before-release.md): `renderToolObject()` is a god function with
   * 30+ per-tool branches, far from each tool's definition. New tools that
   * want custom output no longer need to add a branch there — they implement
   * this method instead. Existing branches stay until migrated incrementally.
   */
  serialize?(output: O, input: I): string;
}

export interface ToolCallContext {
  tool: Tool;
  input: unknown;
  callId: string;
  ctx: AgentContext;
  signal: AbortSignal;
}

/**
 * Error categories for tool execution failures.
 * Used by the executor to classify errors and determine retry strategy.
 */
export enum ToolErrorCategory {
  TRANSIENT = 'transient', // ETIMEDOUT, ECONNRESET, network timeout, HTTP 429/503
  NOT_FOUND = 'not_found', // ENOENT, ENOTDIR, HTTP 404
  PERMISSION = 'permission', // EACCES, EPERM, HTTP 401/403
  VALIDATION = 'validation', // schema validation error, HTTP 400
  FATAL = 'fatal', // unhandled exception, crash, invariant violation
}

/**
 * How one tool call settled. Recorded for EVERY call — including the ones that
 * never ran — so a denied, declined or aborted call is a typed fact in the
 * journal and on `tool.executed`, not only a sentence inside an error result.
 *
 * - `completed` / `failed` — the tool ran; `failed` means it threw or
 *   returned an error result.
 * - `unknown_tool` — no tool by that name is registered.
 * - `invalid_input` — malformed arguments, schema or cross-field validation.
 * - `blocked_by_hook` — a PreToolUse hook denied it (or rewrote it into an
 *   invalid shape).
 * - `denied_by_policy` — the permission policy, a session lock (subagents
 *   disabled) or the Kanban boundary refused it.
 * - `declined` — the confirmation prompt said no: the user, or Brain after
 *   the approval timeout.
 * - `aborted` — the run was aborted before or while the call ran.
 */
export type ToolSettlement =
  | 'completed'
  | 'failed'
  | 'unknown_tool'
  | 'invalid_input'
  | 'blocked_by_hook'
  | 'denied_by_policy'
  | 'declined'
  | 'aborted';

/**
 * Structured tool error information for the LLM and retry logic.
 */
export interface ToolErrorInfo {
  readonly category: ToolErrorCategory;
  /** Whether the operation can be retried automatically. */
  readonly retryable: boolean;
  /** User-facing message describing the error. */
  readonly userMessage: string;
  /** Optional technical detail for debugging. */
  readonly detail?: string;
}

/**
 * A function that wraps (decorates) an existing tool. Receives the
 * original tool and returns a modified version — typically the same
 * tool with a wrapped `execute` / `executeStream`, or with modified
 * metadata (description, permission).
 *
 * Use `ToolRegistry.wrap()` to apply; the wrapper is called immediately
 * and the result replaces the registered tool. Multiple wraps stack —
 * each wrapper receives the output of the previous.
 *
 * @example
 * ```ts
 * registry.wrap('read', (original) => ({
 *   ...original,
 *   async execute(input, ctx, opts) {
 *     console.log('read called');
 *     return original.execute(input, ctx, opts);
 *   }
 * }));
 * ```
 */
export type ToolWrapper = (tool: Tool) => Tool;
