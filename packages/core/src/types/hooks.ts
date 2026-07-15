/**
 * Lifecycle hook types — the pure, serializable contract shared by the config
 * layer, the in-process plugin API, and the shell-hook executor.
 *
 * These types intentionally avoid referencing the live `Context` (which lives
 * in `core/`, a higher layer) so `types/config.ts` can import them without
 * creating a layering cycle. The runtime pieces (`hooks/registry`,
 * `hooks/runner`, `hooks/shell-executor`) translate live run state into the
 * serializable `HookInput` below.
 */

/** Lifecycle phases a hook can subscribe to. */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'Stop';

/**
 * Tool-name matcher for `PreToolUse`/`PostToolUse` hooks. A pipe-delimited
 * list of exact tool names, or `*` for all tools. Examples: `"Bash"`,
 * `"edit|write"`, `"*"`. Ignored (treated as `*`) for non-tool events.
 */
export type HookMatcher = string;

/** What to do when a hook crashes, times out, or returns malformed output. */
export type HookFailurePolicy = 'open' | 'closed';

/**
 * PreToolUse hooks run in two phases. Mutators compose first; validators then
 * inspect the final arguments and may no longer rewrite them.
 */
export type PreToolUseStage = 'mutate' | 'validate';

/** Per-registration runtime controls shared by every hook transport. */
export interface HookRegistrationOptions {
  /** Stable name used in logs and model-visible fail-closed errors. */
  name?: string | undefined;
  /** Per-invocation deadline in milliseconds (default 5000). */
  timeoutMs?: number | undefined;
  /** `open` skips a failed hook; `closed` converts failure to a denial. */
  failurePolicy?: HookFailurePolicy | undefined;
  /** PreToolUse phase. Legacy registrations default to `mutate`. */
  stage?: PreToolUseStage | undefined;
  /**
   * Trusted enforcement hook. Policy hooks remain active under `--no-hooks`;
   * ordinary automation hooks do not.
   */
  policy?: boolean | undefined;
  /**
   * PostToolUse only: when true, the hook runs fire-and-forget in the
   * background. The tool executor returns immediately without waiting for
   * the hook to complete. The hook's `additionalContext` is discarded —
   * use this for purely advisory hooks (format-on-save, code-metrics,
   * etc.) where the LLM doesn't need same-turn feedback.
   *
   * PreToolUse hooks ignore this flag — they must complete before the
   * tool runs for correctness and security.
   *
   * Default: false (hooks block the tool result).
   */
  background?: boolean | undefined;
}

/** Deadline/cancellation context passed to in-process hooks. */
export interface HookInvocationContext {
  signal: AbortSignal;
  /** Absolute Unix epoch deadline in milliseconds. */
  deadlineAt: number;
}

/**
 * The JSON payload handed to a hook. For shell hooks this is serialized to
 * stdin; for in-process hooks it is passed as the sole argument. Kept flat and
 * serializable so both transports see the same shape.
 */
export interface HookInput {
  event: HookEvent;
  /** Present for PreToolUse / PostToolUse. */
  toolName?: string | undefined;
  /** Tool arguments (PreToolUse / PostToolUse). */
  toolInput?: unknown | undefined;
  /** Tool result preview (PostToolUse only). */
  toolResult?: { content: string; isError: boolean };
  /** The submitted user text (UserPromptSubmit only). */
  prompt?: string | undefined;
  /** Absolute working directory of the session. */
  cwd: string;
  /** Active session id, when known. */
  sessionId?: string | undefined;
}

/**
 * What a hook returns. Every field is optional — an empty object (or a hook
 * that returns nothing) is a no-op "allow".
 */
export interface HookOutcome {
  /**
   * `block` stops the action (PreToolUse → tool not run; UserPromptSubmit →
   * turn short-circuited). `allow` is the explicit no-op. Omitted = allow.
   */
  decision?: 'block' | 'allow' | undefined;
  /** Human-readable reason, surfaced to the model when blocking. */
  reason?: string | undefined;
  /**
   * PreToolUse only: replacement tool arguments. The executor swaps these in
   * and RE-VALIDATES them against the tool's input schema before running.
   */
  modifiedInput?: Record<string, unknown>;
  /**
   * Extra context to fold back to the model — appended to the tool_result
   * (PostToolUse), the user message (UserPromptSubmit), or the system preamble
   * (SessionStart).
   */
  additionalContext?: string | undefined;
  /**
   * Where the additionalContext should appear. `inline` (default) appends it
   * to the tool_result / user message content so it renders as part of that
   * block. `separate` appends it as a new user message, keeping plugin notices
   * visually separated from the actual tool output.
   */
  contextAs?: 'inline' | 'separate' | undefined;
}

/**
 * Preferred, mutually-exclusive PreToolUse result. `allow` means only that
 * this hook has no objection; it never bypasses the core permission policy.
 */
export type PreToolUseOutcome = {
  additionalContext?: string | undefined;
  contextAs?: 'inline' | 'separate' | undefined;
} & (
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'mutate'; input: Record<string, unknown>; reason?: string | undefined }
);

/** New and legacy hook outputs accepted at the transport boundary. */
export type AnyHookOutcome = HookOutcome | PreToolUseOutcome;

/** An in-process hook function (registered via the plugin API). */
export type InProcessHook = (
  input: HookInput,
  runtime: HookInvocationContext,
) => AnyHookOutcome | void | Promise<AnyHookOutcome | void>;

interface ConfiguredHookBase extends HookRegistrationOptions {
  /** Tool-name matcher (defaults to `*`). */
  matcher?: HookMatcher | undefined;
}

/**
 * A shell-command hook (declared in `config.hooks`). Claude-compatible: the
 * `HookInput` JSON is written to the command's stdin; a JSON `HookOutcome` may
 * be printed to stdout, and exit code 2 forces `decision: 'block'`.
 */
export interface ShellHook extends ConfiguredHookBase {
  type?: 'command' | undefined;
  /** Command line run via the platform shell. */
  command: string;
}

/** Native HTTP hook. The HookInput JSON is POSTed and JSON output is parsed. */
export interface HttpHook extends ConfiguredHookBase {
  type: 'http';
  url: string;
  headers?: Record<string, string> | undefined;
}

export type ConfiguredHook = ShellHook | HttpHook;

interface HookEntryBase {
  event: HookEvent;
  matcher: HookMatcher;
  name: string;
  timeoutMs?: number | undefined;
  failurePolicy: HookFailurePolicy;
  stage: PreToolUseStage;
  policy: boolean;
  background: boolean;
}

/** A registered hook entry, discriminated by transport. */
export type HookEntry =
  | (HookEntryBase & {
      kind: 'inprocess';
      hook: InProcessHook;
      owner?: string | undefined;
    })
  | (HookEntryBase & { kind: 'shell'; command: string })
  | (HookEntryBase & { kind: 'http'; url: string; headers?: Record<string, string> | undefined });
