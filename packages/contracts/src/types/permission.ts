import type { AgentContext } from './context.js';
import type { Permission, Tool } from './tool.js';

/**
 * WHAT kind of damage a command would do, as the user-facing categories the
 * YOLO confirmation menu is built from.
 *
 * These are not new taxonomy — each one is a check that already existed in
 * `security/yolo-risk.ts`, which classifies commands into them. Naming them is what lets the user keep, say, `git-history` gated while
 * letting `bulk-delete` through, instead of the all-or-nothing `yoloDestructive`
 * switch (which no surface ever wired up anyway).
 */
export type DestructiveKind =
  /** Wipes a disk or the machine: mkfs, dd to a raw device, format C:, fork bomb. */
  | 'disk-wipe'
  /** Powers the machine down or restarts it. */
  | 'system-halt'
  /** Recursive force-delete that escapes the project, or hits a system/home root. */
  | 'delete-outside'
  /** Deletes across many matches at once: `find -exec rm`, an inline `rmSync`, container volumes, database drops. */
  | 'bulk-delete'
  /** Destroys VCS history or published refs: reset --hard, clean -f, push --force, filter-branch. */
  | 'git-history'
  /** Pushes outward and is hard to retract: npm publish, docker push, kubectl delete namespace. */
  | 'publish'
  /** Runs code fetched off the network — the damage is unknowable in advance. */
  | 'download-and-run'
  /** Writes WrongStack's own trusted state (config.json / trust.json / auth.json). */
  | 'agent-state'
  /** Binds a well-known third-party credential to a provider endpoint. */
  | 'credential-bind';

export interface TrustPolicy {
  [toolNameOrPattern: string]: {
    allow?: string[] | undefined;
    deny?: string[] | undefined;
    auto?: boolean | undefined;
    trustWorkdir?: boolean | undefined;
    denyPrivate?: boolean | undefined;
    /**
     * W6 #9 — epoch ms after which `allow` stops applying.
     *
     * An `always` answer used to persist its trust rule forever, so a single
     * approval granted standing authorization with no expiry and no reminder.
     * This bounds it. Absent means "no expiry", which is what a hand-authored
     * trust.json entry keeps — only rules a prompt created are timed.
     *
     * Fail-closed by construction: an expiry can only ever withdraw
     * authorization, never add it, so a wrong value re-prompts rather than
     * opening a path.
     */
    allowUntil?: number | undefined;
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
    /**
     * YOLO stopped to ask because a rule the USER wrote forbids this call (a
     * session "no", a trust-file or `/permissions` deny, a directory rule).
     * Only the user may answer it: an unanswered one is refused, never handed
     * to the Brain, and an "always allow" answer runs it once — the rule stays.
     */
    | 'yolo_user_rule'
    | 'user'
    | 'deny'
    | 'context'
    | 'subagent_guard'
    | 'readonly_mode'
    | 'directory_rules'
    /** A `/permissions allow|deny` rule of this session. */
    | 'session_override';
  /** Risk tier of the tool, if classified. */
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
  /**
   * YOLO+ allowed this call: the user has allowed everything, so nothing the
   * executor would add on top — a Kanban scope-boundary confirm — may turn it
   * back into a question. A boundary or hook DENY still refuses.
   */
  allowAll?: true | undefined;
  /**
   * The `auto` came from a tool the operator named with `--allowed-tools` at
   * launch. Unlike a remembered trust pattern it is a deliberate, per-process
   * decision that no repo can plant, so the executor's dangerous-capability
   * confirm does not re-prompt for it (destructive calls still confirm).
   */
  launchGrant?: true | undefined;
  /**
   * The `auto` came from an approval the user gave at a confirm prompt ("same
   * args", "this command", "this tool"), remembered in the user's own trust
   * file. Like `launchGrant`, it is the user's decision rather than a pattern
   * a repo or a hand-edited broad glob put there, so the executor honours it
   * for dangerous-capability tools too; without this every "always allow" for
   * bash, write or edit asked again on the very next identical call.
   */
  approvalGrant?: true | undefined;
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
  /**
   * Which entry of the compiled rule list this step matched, when the step
   * checks several (one trust pattern, one directory rule, one session rule).
   * Equal to that {@link PermissionRule.ref}.
   */
  ref?: string | undefined;
}

/**
 * One entry of the permission rule list: every setting that decides a tool
 * call, compiled in the order the policy checks them. The first rule that
 * matches a call decides it (`compilePermissionRules`). The list is a view:
 * the policy still evaluates its own settings, and the explain parity test
 * checks that every decision lands on a listed rule.
 */
export interface PermissionRule {
  /** 1-based position in the list. */
  n: number;
  /** The check this rule belongs to; equal to `PermissionTraceStep.rule`. */
  step: string;
  /** Tells apart the rules of one check (see `PermissionTraceStep.ref`). */
  ref?: string | undefined;
  /** Where the rule comes from. */
  source:
    | 'directory-rules'
    | 'trust-file'
    | 'session'
    | 'prompt-answer'
    | 'allowed-tools'
    | 'tool'
    | 'yolo'
    | 'built-in'
    | 'executor';
  /** The tool name or glob it applies to; `*` is every tool. */
  action: string;
  /** The input it applies to: a subject glob, a directory, or a condition; `*` is any. */
  resource: string;
  effect: 'allow' | 'ask' | 'deny';
  note?: string | undefined;
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
  /**
   * The rules this policy checks, in order, for one conversation (its YOLO,
   * session rules and prompt answers). Unnumbered; see `compilePermissionRules`.
   */
  listRules?(ctx?: AgentContext | undefined): Promise<Omit<PermissionRule, 'n'>[]>;
  /**
   * Persist an allow rule. `ttlMs` bounds how long a prompt-driven "always"
   * stays valid; omitted (a hand-authored rule) means permanent.
   */
  trust(rule: { tool: string; pattern: string; ttlMs?: number | undefined }): Promise<void>;
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
  /**
   * YOLO+: the user has allowed everything. No call ever prompts — not even
   * the destructive kinds or the locked ones. Explicit deny rules still refuse.
   */
  getYoloPlus?(): boolean;
  /** Turn YOLO+ on or off. On implies YOLO. */
  setYoloPlus?(enabled: boolean): void;
  /**
   * The YOLO level in force for ONE conversation (per-tab meta first). Lets a
   * wrapping policy apply the same rule to its own refusals: off and YOLO+
   * refuse, YOLO asks.
   */
  yoloModeFor?(ctx?: { meta?: Record<string, unknown> | undefined } | undefined): {
    yolo: boolean;
    yoloPlus: boolean;
  };
  /**
   * All-or-nothing view of the destructive gate: `true` when nothing but the
   * locked kinds still prompts. Superseded by the per-kind pair below, and kept
   * because the CLI flag and older embedders still speak it.
   */
  getYoloDestructive?(): boolean;
  /** All-or-nothing setter; `true` un-gates every kind that is not locked. */
  setYoloDestructive?(enabled: boolean): void;
  /** Which kinds of damage still require approval while YOLO is on. */
  getYoloConfirmKinds?(): ReadonlySet<DestructiveKind>;
  /**
   * Replace that set. The locked kinds are re-added regardless, so this can
   * never be used to switch off the writes that disable approval itself.
   */
  setYoloConfirmKinds?(kinds: Iterable<DestructiveKind>): void;
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
        ) => Promise<
          'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny'
        >)
      | undefined,
  ): void;
}
