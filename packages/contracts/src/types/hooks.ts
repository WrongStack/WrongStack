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

import type { CompactionTrigger } from './compactor.js';

/**
 * Lifecycle phases a hook can subscribe to. Names follow the Claude Code hook
 * vocabulary so a config written for one reads the same here.
 *
 * The first five can steer the run (block, rewrite input, add context). The
 * rest are OBSERVATIONAL: they fire at their lifecycle point with a typed
 * payload, but their outcome is ignored — they cannot block or inject.
 */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'Stop'
  | ObservationalHookEvent;

/** Hook events whose outcome is ignored; see {@link HookEvent}. */
export type ObservationalHookEvent =
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'SessionEnd'
  | 'Notification';

/** Every hook event, in lifecycle order. The one list validation and docs read. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Stop',
  'SessionEnd',
];

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Matcher for a hook registration: a pipe-delimited list of exact names, or
 * `*` for all. What it matches depends on the event — the tool name for
 * `PreToolUse`/`PostToolUse`, the subagent target (roster role or name) for
 * `SubagentStart`/`SubagentStop`, the notification kind (`permission` |
 * `input`) for `Notification`, and the trigger (`auto` | `manual` |
 * `overflow` | `tool`) for `PreCompact`/`PostCompact`. Examples: `"Bash"`,
 * `"edit|write"`, `"*"`. Ignored (treated as `*`) for the other events.
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
   * use this for purely advisory hooks (format-on-save, diff-summary,
   * etc.) where the LLM doesn't need same-turn feedback.
   *
   * PreToolUse hooks ignore this flag — they must complete before the
   * tool runs for correctness and security.
   *
   * Default: false (hooks block the tool result).
   */
  background?: boolean | undefined;
  /**
   * PostToolUse only: ALSO run when PreToolUse allowed the call but the tool
   * then never ran — permission denied, the user rejected the prompt, the run
   * aborted, or the tool threw. The hook sees `toolResult.isError: true` and
   * the reason as content. For hooks that release what their PreToolUse half
   * claimed (a file lock); without it a denied write held the lock until TTL
   * and blocked every other session from that file.
   *
   * Default: false — ordinary PostToolUse hooks only see tools that ran.
   */
  runWhenToolSkipped?: boolean | undefined;
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
  /**
   * The tool's declared capabilities (PreToolUse), so a policy hook can key on
   * WHAT a tool does instead of what it is called.
   *
   * `matcher` is a list of tool names, which is the only vocabulary a hook had
   * for "tools that write". `path-guard` matched `write|edit|bash|exec` and
   * therefore never saw `patch`, `scaffold`, or any plugin- or MCP-registered
   * writer — a protected path was guarded through four doors and open through
   * the rest. Names cannot be enumerated ahead of a plugin that has not been
   * written yet; capabilities can.
   */
  toolCapabilities?: readonly string[] | undefined;
  /** The tool's `mutating` flag (PreToolUse). See `toolCapabilities`. */
  toolMutating?: boolean | undefined;
  /** Tool result preview (PostToolUse only). */
  toolResult?: {
    content: string;
    isError: boolean;
    /** Bounded file scope reported by a completed bulk-write tool, before output clipping. */
    modifiedPaths?: string[] | undefined;
    /** Additional path entries not represented in modifiedPaths. */
    modifiedPathsOmitted?: number | undefined;
  };
  /** The submitted user text (UserPromptSubmit only). */
  prompt?: string | undefined;
  /** PreCompact / PostCompact: what triggered the pass and its size. */
  compaction?:
    | {
        trigger: CompactionTrigger;
        aggressive: boolean;
        /** Message tokens before the pass (PostCompact only). */
        tokensBefore?: number | undefined;
        /** Message tokens after the pass (PostCompact only). */
        tokensAfter?: number | undefined;
      }
    | undefined;
  /** SubagentStart / SubagentStop: the delegation this event belongs to. */
  subagent?:
    | {
        /** Roster role or free-form subagent name. */
        target: string;
        task: string;
        subagentId?: string | undefined;
        delegationId?: string | undefined;
        mode?: 'background' | 'wait' | undefined;
        /** SubagentStop only. */
        ok?: boolean | undefined;
        status?: string | undefined;
        summary?: string | undefined;
        durationMs?: number | undefined;
      }
    | undefined;
  /** Notification: the run is waiting on the user. */
  notification?:
    | {
        kind: 'permission' | 'input';
        message: string;
        /** The tool awaiting approval (`permission` only). */
        toolName?: string | undefined;
      }
    | undefined;
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
  runWhenToolSkipped?: boolean | undefined;
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

/**
 * Lifecycle hook registry behind `TOKENS.HookRegistry`. Implementation:
 * `hooks/registry.ts`.
 */
export interface HookRegistryPort {
  /** Register an in-process hook. Returns an unsubscribe function. */
  registerInProcess(
    event: HookEvent,
    matcher: HookMatcher | undefined,
    hook: InProcessHook,
    owner?: string | undefined,
    options?: HookRegistrationOptions,
  ): () => void;
  registerShell(event: HookEvent, hook: ShellHook): () => void;
  registerHttp(event: HookEvent, hook: HttpHook): () => void;
  loadShellHooks(
    hooks: Partial<Record<HookEvent, ConfiguredHook[]>> | undefined,
    options?: { policyOnly?: boolean | undefined },
  ): void;
  replaceShellHooks(
    hooks: Partial<Record<HookEvent, ConfiguredHook[]>> | undefined,
    options?: { policyOnly?: boolean | undefined },
  ): void;
  list(event: HookEvent): readonly HookEntry[];
  has(event: HookEvent): boolean;
  all(): readonly HookEntry[];
  drainByOwner(owner: string): number;
  countByOwner(owner: string): number;
  clear(): void;
}
