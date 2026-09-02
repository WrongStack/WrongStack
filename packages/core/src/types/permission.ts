import type { AgentContext } from './context.js';
import type { Permission, Tool } from './tool.js';

export interface TrustPolicy {
  [toolNameOrPattern: string]: {
    allow?: string[] | undefined;
    deny?: string[] | undefined;
    auto?: boolean | undefined;
    trustWorkdir?: boolean | undefined;
    denyPrivate?: boolean | undefined;
  };
}

export interface PermissionDecision {
  permission: Permission;
  reason?: string | undefined;
  source:
    | 'default'
    | 'trust'
    | 'yolo'
    | 'yolo_destructive'
    | 'user'
    | 'deny'
    | 'context'
    | 'subagent_guard'
    | 'readonly_mode'
    | 'directory_rules';
  /** Risk tier of the tool, if classified. */
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
}

/**
 * A single evaluation step in the permission explainer trace.
 * Each step records a rule that was checked, whether it matched,
 * and what the effective decision would be if that rule wins.
 */
export interface PermissionTraceStep {
  /** Label identifying the rule, e.g. "session soft deny", "trust deny", "yolo". */
  rule: string;
  /** Whether this rule's condition matched the tool+input pair. */
  matched: boolean;
  /** The permission decision if this rule were the winner. */
  decision: 'auto' | 'deny' | 'confirm';
  /** The source label associated with this step. */
  source: string;
  /** Human-readable explanation of the outcome. */
  detail: string;
}

/**
 * Structured trace of a permission evaluation for debugging and CLI
 * explainer output. Contains every step that was checked and the
 * winning decision.
 */
export interface PermissionTrace {
  toolName: string;
  subject: string | null | undefined;
  /** The ordered list of rules checked, in evaluation priority order. */
  steps: PermissionTraceStep[];
  /** Index into `steps` of the winning rule. */
  winnerIndex: number;
  /** The final effective permission decision. */
  decision: PermissionDecision;
}

/**
 * A single directory-scoped rule entry.
 *
 * A directory rule binds a directory glob (matched against the tool
 * call's resolved path) to a set of restrictions. Multiple rules may
 * apply to a single path; the wrapper merges them with deny-beats-allow
 * precedence (see `DirectoryPermissionPolicy`).
 *
 * Why this exists: the existing `TrustPolicy` is keyed by *tool name*
 * and has no notion of location. A user may want to ban `bash` for any
 * file under `infra/terraform/` or ban the `openai` provider when
 * working in `clients/acme/`. `DirectoryRule` is the shape that
 * captures these per-directory constraints.
 */
export interface DirectoryRule {
  /**
   * Glob pattern matched against the directory portion of the resolved
   * absolute path. Forward slashes, normalized via `path.resolve`.
   * Example patterns: `infra/**`, `clients/acme/**`, secrets star-star.
   */
  directory: string;
  /**
   * Tool names that are blocked when the input path matches this rule.
   * Matched by exact name AND by namespace wildcard (e.g.
   * `mcp__server__*` blocks every tool from that MCP server).
   */
  denyTools?: string[];
  /**
   * Provider ids blocked when the active provider matches. Read off
   * `ctx.provider.id`. A model under a denied provider causes the
   * tool call to be denied (this is the only "soft" rule — provider
   * itself is not a tool so this is enforced at tool-call time).
   */
  denyProviders?: string[];
  /**
   * When declared, ONLY these tools are allowed when the input path
   * matches this rule. An empty list denies every tool. This is stricter
   * than `denyTools` because it cannot be widened by an inner-policy allow.
   */
  allowOnlyTools?: string[];
  /**
   * Optional human-readable description surfaced in the denial reason
   * and in explainer output.
   */
  description?: string;
}

/**
 * The full directory permission policy — the on-disk shape of
 * `.wrongstack/directory-rules.json`.
 *
 * Rules are evaluated in array order; the most specific pattern
 * conventionally appears first, but the wrapper does not require
 * ordering — it computes the longest matching pattern and lets
 * deny-beats-allow resolve conflicts.
 */
export interface DirectoryPolicy {
  /** Schema version. Always 1 for now. */
  schemaVersion: 1;
  /** Ordered list of rules. */
  rules: DirectoryRule[];
}

export interface PermissionPolicy {
  evaluate(tool: Tool, input: unknown, ctx: AgentContext): Promise<PermissionDecision>;
  /**
   * Side-effect-free permission evaluation trace. Returns the same
   * logical result as `evaluate()` without prompting the user,
   * writing to trust files, or mutating session state.
   */
  explain?(tool: Tool, input: unknown, ctx: AgentContext): Promise<PermissionTrace>;
  trust(rule: { tool: string; pattern: string }): Promise<void>;
  /**
   * Persist a permanent deny rule (mirrors trust). Written to trust.json.
   */
  deny(rule: { tool: string; pattern: string }): Promise<void>;
  /**
   * Block this tool+pattern for the remainder of the session (no persistence).
   * Used when user presses 'n' — prevents LLM retry from re-triggering confirm.
   */
  denyOnce(rule: { tool: string; pattern: string }): void;
  /**
   * Auto-approve this tool+pattern once (no persistence). Used when user
   * presses 'y' so the immediate confirmed re-run can proceed without making
   * future destructive calls silent.
   */
  allowOnce(rule: { tool: string; pattern: string }): void;
  reload(): Promise<void>;
  /** Optional runtime query for policies that support leader YOLO toggling. */
  getYolo?(): boolean;
  /** Optional runtime setter for policies that support leader YOLO toggling. */
  setYolo?(enabled: boolean): void;
  /** Optional runtime query for the deprecated destructive YOLO override. */
  getYoloDestructive?(): boolean;
  /** Optional runtime setter for the deprecated destructive YOLO override. */
  setYoloDestructive?(enabled: boolean): void;
  /** Query the deprecated destructive-confirm compatibility flag. */
  getConfirmDestructive?(): boolean;
  /** Compatibility setter; current default policy no longer confirms in YOLO mode. */
  setConfirmDestructive?(enabled: boolean): void;
  /** Set the prompt delegate (optional). */
  setPromptDelegate?(
    delegate:
      | ((
          tool: Tool,
          input: unknown,
          suggestedPattern: string,
        ) => Promise<'yes' | 'no' | 'always' | 'deny'>)
      | undefined,
  ): void;
}
