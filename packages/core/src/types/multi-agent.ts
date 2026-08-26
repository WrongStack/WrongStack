import type { SubagentBudget } from '../coordination/subagent-budget.js';
import type { AgentBridge, BridgeMessage } from './agent-bridge.js';
import type { ModelRuntimeConfig } from './config.js';

/** Internal, non-user-authored budget/depth inheritance for nested directors. */
export interface SubagentSpawnLineage {
  parentDirectorId: string;
  /** Depth of the spawned child; root Director is depth 0. */
  spawnDepth: number;
  /** Hard ceiling inherited by descendants. */
  maxSpawnDepth: number;
  fleetBudget: {
    maxSpawns?: number | undefined;
    remainingSpawns?: number | undefined;
    maxTokens?: number | undefined;
    remainingTokens?: number | undefined;
    maxCostUsd?: number | undefined;
    remainingCostUsd?: number | undefined;
  };
}

export interface SubagentConfig {
  id?: string | undefined;
  name: string;
  role?: string | undefined;
  prompt?: string | undefined;
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  maxCostUsd?: number | undefined;
  /** Hard wall-clock cap (ms) from start. Opt-in; prefer `idleTimeoutMs`. */
  timeoutMs?: number | undefined;
  /**
   * Idle timeout (ms): reap the subagent only after this long with no
   * activity. Resets on every iteration / tool call / streamed progress, so
   * an actively-working agent runs until its task naturally ends. This is the
   * default reaper for delegated subagents (see `applyRosterBudget`).
   */
  idleTimeoutMs?: number | undefined;
  /**
   * Fraction of `timeoutMs` at which the proactive pre-empt fires (0.0–1.0).
   * At this point the watchdog negotiates a ceiling extension while the
   * agent is still under its limit, so a progressing agent gets its
   * ceiling raised before ever entering a timed-out state.
   * Defaults to `TIMEOUT_PREEMPT_FRACTION` (0.85). Lower values fire earlier;
   * higher values fire closer to the deadline. Ignored when `timeoutMs` is unset.
   */
  preemptFraction?: number | undefined;
  /** Stable capability ids resolved to the host's concrete tool surface. */
  capabilities?: string[] | undefined;
  tools?: string[] | undefined;
  /**
   * Tools to explicitly disable for this subagent. These tools will be
   * removed from the subagent's tool list even if they are normally available.
   * Use this to enforce constraints that the baseline prompt alone cannot
   * fully enforce (e.g., preventing delegation by removing the delegate tool).
   */
  disabledTools?: string[] | undefined;
  /**
   * Capability allowlist for this subagent's `AutoApprovePermissionPolicy`.
   * Subagents run non-interactively, so the policy auto-approves only tools
   * whose declared capabilities intersect this list; everything else is
   * denied by the subagent guard. Defaults (when omitted) to the read-only
   * safe set `['fs.read', 'net.outbound']`. Widen it per-spawn when a task
   * legitimately needs more — e.g. `/techstack` adds `'fs.write'` so the
   * subagent can write its report. Never grant `shell.*` unless the task
   * truly requires arbitrary command execution.
   */
  allowedCapabilities?: readonly string[] | undefined;
  model?: string | undefined;
  priority?: number | undefined;

  /**
   * Exempt this spawn from the director's lifetime `maxSpawns` budget.
   * Ephemeral infrastructure agents (Chimera reviewers, cascade agents) set
   * this so background review traffic cannot exhaust the leader's
   * deliberate-delegation budget: the `max_spawns` admission check is skipped
   * and the lifetime spawn counter is NOT incremented. All other caps
   * (spawn depth, fleet cost/tokens, leader context load) still apply.
   * Deliberate leader spawns must leave this unset.
   */
  spawnBudgetExempt?: boolean | undefined;

  /**
   * Director-authored recursion/budget inheritance. Director.spawn overwrites
   * caller input so a model cannot forge a shallower depth or larger budget.
   */
  spawnLineage?: SubagentSpawnLineage | undefined;

  /**
   * Working directory for this subagent's tools. Defaults to the factory's
   * cwd. Goal sets this to a per-phase git worktree so parallel phases
   * edit isolated checkouts instead of clobbering one shared working tree.
   * `projectRoot` is intentionally left unchanged — tools resolve the
   * worktree's `.git` gitlink from `cwd` while staying bounded to the repo.
   */
  cwd?: string | undefined;

  /**
   * Git-worktree isolation override for this subagent.
   *
   * - `undefined` / `'auto'`: follow the fleet policy. Mutating/build-capable
   *   agents get isolated worktrees; read-only review agents can stay on the
   *   shared checkout.
   * - `true` / `'required'`: require an isolated worktree. If allocation fails,
   *   the task fails instead of falling back to the shared cwd.
   * - `false` / `'off'`: never allocate a worktree for this subagent.
   */
  worktree?: boolean | 'auto' | 'required' | 'off' | undefined;

  // --- Director orchestration extensions ---

  /**
   * Provider registry id (e.g. `'anthropic'`, `'openai'`, `'google'`).
   * Allows a director to mix providers across siblings — for example, one
   * subagent on a planner model and another on a verifier model. Falls back to the
   * factory's default provider when omitted, which is the legacy
   * single-provider behavior.
   */
  provider?: string | undefined;

  /**
   * Ordered fallback model chain for THIS subagent (entries: `model` or
   * `provider/model`). When the subagent's primary model 429s or stream-hangs,
   * the factory's fallback extension rotates to the next entry. Empty/undefined
   * → the factory's own default fallback behavior (usually the leader's config).
   */
  fallbackModels?: string[] | undefined;

  /**
   * Named live fallback profile for this subagent. Unlike `fallbackModels`, the
   * factory re-resolves this profile from ConfigStore on every provider attempt,
   * so WebUI edits and reordering affect already-running workers immediately.
   */
  fallbackProfile?: string | undefined;

  /** Closed provider/model policy applied by a project roster role. */
  modelPolicy?:
    | {
        allowed: Array<{ provider: string; model: string }>;
        fallbacks?: Array<{ provider: string; model: string }> | undefined;
        strict?: boolean | undefined;
      }
    | undefined;

  /** Optional working-hours policy; built-in system roles treat it as advisory. */
  availability?:
    | {
        timezone: string;
        days: number[];
        start: string;
        end: string;
        mode?: 'advisory' | 'enforce' | undefined;
      }
    | undefined;

  /**
   * Model-driven completion policy. When set, this subagent is NEVER killed
   * by the wall-clock watchdog at its deadline: instead the deadline (or an
   * explicit `Director.requestFinish()`) triggers an in-band
   * `subagent.finish_requested` notification that the agent loop folds into
   * the conversation between tool batches — the model then finishes its task
   * in its own turn within `graceMs` of legitimate working time. Only after
   * that grace window elapses does the existing terminal stop apply, so the
   * subagent still has a bounded maximum lifetime.
   *
   * `undefined` (default) keeps the legacy watchdog behavior unchanged.
   */
  gracefulFinish?: boolean | { graceMs?: number | undefined } | undefined;

  /**
   * Runtime request overrides for THIS subagent. When present, these are merged
   * over the leader's `Config.modelRuntime` before the subagent request pipeline
   * maps reasoning/cache/parameters onto provider requests. Used by the model
   * matrix to give roles their own reasoning effort without changing the leader.
   */
  modelRuntime?: ModelRuntimeConfig | undefined;

  /**
   * Per-subagent session JSONL path. When omitted the orchestrator-
   * supplied factory derives a path under `<sessionRoot>/<runId>/`.
   * Override to redirect the transcript elsewhere (long-term storage,
   * a different filesystem, etc.).
   */
  sessionPath?: string | undefined;

  /**
   * Additional text appended to the role's base system prompt. Does not
   * replace it. Useful for last-mile guidance like "you may only call
   * read tools, never write" or "respond in JSON only".
   */
  systemPromptOverride?: string | undefined;

  /**
   * Skill names the host should prioritize for this subagent. Distinct from
   * `Config.skills`, which configures discovery. The runtime resolves installed
   * bodies through `SkillLoader`; missing optional skills are skipped safely.
   */
  skillNames?: string[] | undefined;

  /**
   * Every skill this role may draw on, before per-project ranking. The catalog
   * sets this to the full curated set while `skillNames` holds the default
   * eager slice; the spawn path ranks the pool by project skill-affinity so a
   * skill the project actually developed can displace an unused sibling.
   */
  skillPool?: string[] | undefined;

  /** Optional smart-dispatch metadata for dynamically created project roles. */
  dispatch?:
    | {
        summary: string;
        keywords: string[];
      }
    | undefined;

  /**
   * Project-level identity customization for this agent role.
   * When set, the runtime loads project-specific overrides and learned
   * wisdom files from `.wrongstack/agents/<role>/` and merges them
   * on top of the base catalog definition.
   */
  projectIdentity?:
    | {
        /** Path to the project root (defaults to the factory's projectRoot). */
        projectRoot?: string | undefined;
        /**
         * When true, the agent may update its own `learned.md` file after a
         * task to pass project-specific patterns to future invocations.
         */
        canLearn?: boolean | undefined;
        /**
         * Static identity appendix overrides the identity.md file when set.
         * Useful for programmatic overrides from CI or orchestration flows.
         */
        identityOverride?: string | undefined;
      }
    | undefined;

  /**
   * Domain-specific knowledge injected into the subagent's system prompt after
   * shared memory and before the role persona. Callers may supply this directly;
   * runtimes append resolved `skillNames` content when available.
   */
  skillContent?: string | undefined;

  /** Optional task/mode selectors combined with the stable role for project agent-memory lookup. */
  memoryContext?:
    | {
        taskType?: string | undefined;
        mode?: string | undefined;
      }
    | undefined;

  /**
   * Routing for streaming output. `'director'` (default) forwards
   * text/tool events to the parent's FleetBus so the director can read
   * the subagent's stream. `'silent'` keeps everything subagent-local;
   * the director only sees the final task result. `'user'` forwards
   * direct to the user-facing renderer (gate this behind an explicit
   * config flag — it can confuse the chat surface).
   */
  textStream?: 'director' | 'silent' | 'user' | undefined;
  toolStream?: 'director' | 'silent' | 'user' | undefined;
}

/**
 * Discriminator for every distinct failure mode a subagent can hit. The
 * coordinator's classifier (`classifySubagentError` in
 * coordination/multi-agent-coordinator.ts) maps raw exceptions to one of
 * these — callers (delegate tool, /agents UI, retry policies) can then
 * branch on `kind` instead of grepping `error.message`. Each kind
 * documents its retryability so an orchestrator can act on it without
 * extra knowledge.
 */
export type SubagentErrorKind =
  /** Provider returned 5xx. Transient server-side issue — safe to retry with backoff. */
  | 'provider_5xx'
  /** Provider returned 429. Rate-limited — retry with `backoffMs` delay. */
  | 'provider_rate_limit'
  /** Provider call timed out at the network layer (TCP / TLS / read). Retry safe. */
  | 'provider_timeout'
  /** Provider rejected the credentials (401/403). NOT retryable — config fix required. */
  | 'provider_auth'
  /** Model returned a "context length exceeded" error. Retrying without trimming will fail again. */
  | 'context_overflow'
  /** A tool's `execute()` returned `ok:false`. Logical task failure, not a crash. */
  | 'tool_failed'
  /** A tool's `execute()` threw an exception. Often retryable but cause-dependent. */
  | 'tool_threw'
  /** Hit the per-subagent `maxIterations` budget. Either raise budget or narrow task. */
  | 'budget_iterations'
  /** Hit the per-subagent `maxToolCalls` budget. Either raise budget or narrow task. */
  | 'budget_tool_calls'
  /** Hit the per-subagent `maxTokens` budget. */
  | 'budget_tokens'
  /** Hit the per-subagent `maxCostUsd` budget. */
  | 'budget_cost'
  /** Hit the per-subagent `timeoutMs` wall-clock budget. */
  | 'budget_timeout'
  /** Parent agent's AbortController fired (user Ctrl+C, parent unwound, sibling failure cascade). */
  | 'aborted_by_parent'
  /** LLM returned end_turn with no textual content. Often a prompt issue. */
  | 'empty_response'
  /** Parent-child bridge transport failed (rare — IPC / writer crash). */
  | 'bridge_failed'
  /** Everything else. Classifier fallback — should narrow over time as new modes appear. */
  | 'unknown';

/**
 * Structured failure envelope. Replaces the prior `error?: string` so
 * callers can switch on `kind`, respect `retryable`, and apply
 * provider-suggested `backoffMs` instead of guessing from substring
 * matches on the message.
 */
export interface SubagentError {
  /** Discriminator — see SubagentErrorKind doc strings for semantics. */
  kind: SubagentErrorKind;
  /** Human-readable summary, suitable for direct UI display. Always populated. */
  message: string;
  /** True if the operation can be retried as-is (possibly with backoff). */
  retryable: boolean;
  /** Suggested backoff before retry, in ms. Set for `provider_rate_limit` and `provider_5xx`. */
  backoffMs?: number | undefined;
  /** Original cause snapshot for diagnostics — never used for control flow. */
  cause?: { name: string; message: string; stack?: string | undefined } | undefined;
}

/**
 * Bounded, best-effort work recovered before a non-successful task ended.
 * This is deliberately separate from `result`: callers must not mistake an
 * incomplete stream tail for a completed deliverable.
 */
export interface SubagentPartialResult {
  /** Last useful assistant text observed, capped by the coordinator. */
  text: string;
  /** Where the snapshot came from. */
  source: 'stream' | 'run_result' | 'runner';
  capturedAt: number;
}

/**
 * Compact machine-readable result submitted independently from the agent's
 * human-facing final text. Additive and optional for legacy/custom runners.
 */
export interface SubagentStructuredReport {
  summary: string;
  findings: string[];
  files_examined: string[];
  /** 0.0 (uncertain) through 1.0 (fully verified). */
  confidence: number;
  suggested_next_steps: string[];
  /**
   * `complete` means this worker finished the assigned task. `partial` is an
   * intentional checkpoint: the delegate tool may give `remaining_work` to a
   * fresh worker when its bounded handoff policy allows it.
   */
  completion?: 'complete' | 'partial' | undefined;
  /** Concrete remainder for a successor. Required when completion is `partial`. */
  remaining_work?: string | undefined;
}

export interface TaskResult<T = unknown> {
  subagentId: string;
  taskId: string;
  status: 'success' | 'failed' | 'timeout' | 'stopped';
  result?: T | undefined;
  /**
   * Structured failure envelope. Populated whenever `status !== 'success'`.
   * Prefer reading `error.kind` over substring-matching `error.message`.
   */
  error?: SubagentError | undefined;
  /** Verified control-plane report, when the subagent called submit_result. */
  report?: SubagentStructuredReport | undefined;
  /** Useful incomplete work captured before timeout/abort/failure. */
  partial?: SubagentPartialResult | undefined;
  iterations: number;
  toolCalls: number;
  durationMs: number;
}

export interface TaskSpec {
  id: string;
  description: string;
  subagentId?: string | undefined;
  priority?: number | undefined;
  maxToolCalls?: number | undefined;
  timeoutMs?: number | undefined;
  context?: Record<string, unknown>;
}

export interface DoneCondition {
  type: 'iterations' | 'tool_calls' | 'output_match' | 'custom' | 'all_tasks_done' | 'directive';
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  pattern?: string | undefined;
  predicate?: string | undefined;
  /**
   * For `directive` type — stop when model emits [done] and keep going
   * on [continue]/[next step]/[proceed] WITHOUT returning to the outer runner.
   * When false (default), the runner behaves normally (one agent.run per loop).
   * When true, the runner passes `autonomousContinue: true` to the agent and
   * re-runs internally when the model signals continue.
   */
  autonomous?: boolean | undefined;
}

export interface MultiAgentConfig {
  coordinatorId: string;
  leaderSystemPrompt?: string | undefined;
  subagents?: SubagentConfig[] | undefined;
  maxConcurrent?: number | undefined;
  doneCondition: DoneCondition;
  timeoutMs?: number | undefined;
  /**
   * Optional default budget applied to every spawned subagent. Per-subagent
   * fields in `SubagentConfig` override these. Coordinator enforces them by
   * constructing a `SubagentBudget` per spawn — see `SubagentRunContext.budget`.
   */
  defaultBudget?: {
    maxIterations?: number | undefined;
    maxToolCalls?: number | undefined;
    maxTokens?: number | undefined;
    maxCostUsd?: number | undefined;
    timeoutMs?: number | undefined;
    idleTimeoutMs?: number | undefined;
  };
}

export interface SpawnResult {
  subagentId: string;
  agentId: string;
}

export interface TaskDelegation {
  task: TaskSpec;
  subagentId: string;
}

export interface CoordinatorEvents {
  'task.assigned': { task: TaskSpec; subagentId: string };
  'task.completed': { task: TaskSpec; result: TaskResult };
  'subagent.started': { subagent: SubagentConfig };
  'subagent.stopped': { subagentId: string; reason: string };
  done: { results: TaskResult[]; totalIterations: number };
}

/**
 * Result of {@link MultiAgentCoordinator.awaitTasksAny} — a partial drain of a
 * task-id batch. `completed` holds every requested id that has already
 * settled (at least one, unless `timedOut`); `pending` holds the rest, so the
 * caller can loop "handle finishers, re-await the remainder".
 */
export interface AwaitAnyResult {
  completed: TaskResult[];
  pending: string[];
  /** Set when `timeoutMs` elapsed with zero completions among the requested ids. */
  timedOut?: boolean;
}

export interface MultiAgentCoordinator {
  readonly coordinatorId: string;
  readonly config: MultiAgentConfig;

  spawn(subagent: SubagentConfig): Promise<SpawnResult>;
  assign(task: TaskSpec): Promise<void>;
  delegate(to: string, msg: BridgeMessage): Promise<void>;
  stop(subagentId: string): Promise<void>;
  stopAll(): Promise<void>;
  /**
   * Stop a subagent and remove it from the coordinator. Releases all
   * associated resources. The subagent id can be reused in a future spawn.
   */
  remove(subagentId: string): Promise<void>;
  getStatus(): CoordinatorStatus;
  /**
   * Wait for one or more tasks to complete and return their results.
   * If a task is already done when called, returns immediately.
   * Resolves to an array in the same order as `taskIds`.
   */
  awaitTasks(taskIds: string[]): Promise<TaskResult[]>;
  /**
   * Wait until AT LEAST ONE of the named tasks completes, then return every
   * requested result available at that moment plus the still-pending ids.
   * Ids that already completed resolve immediately (drain-what's-done). With
   * `timeoutMs`, resolves (never rejects) with `timedOut: true` and zero
   * completions when the window elapses first.
   */
  awaitTasksAny(taskIds: string[], opts?: { timeoutMs?: number }): Promise<AwaitAnyResult>;
  /** Snapshot of completed task results. */
  results(): readonly TaskResult[];
  /** Defensive snapshot of the still-queued (not yet dispatched) tasks. */
  listPendingTasks(): readonly TaskSpec[];
  /**
   * Re-pin a still-pending task to a different subagent (`undefined` =
   * unpin) and try to dispatch. Returns `false` when the task is no longer
   * pending (dispatched/completed/unknown) or the target subagent does not
   * exist. Running tasks can never be pulled — steer or terminate instead.
   */
  retargetPendingTask(taskId: string, subagentId: string | undefined): boolean;
}

/**
 * Caller-supplied runner that actually executes a task. The coordinator
 * provides isolated state (own budget, own AbortSignal, own bridge handle)
 * and enforces concurrency limits — the runner just runs the task and reports
 * the outcome. This is the injection seam that decouples the coordinator
 * from `Agent` so it can be tested with mocks and reused for non-Agent
 * subagents (workers, MCP-driven subagents, etc.).
 */
export type SubagentRunner = (
  task: TaskSpec,
  ctx: SubagentRunContext,
) => Promise<SubagentRunOutcome>;

export interface SubagentRunContext {
  subagentId: string;
  config: SubagentConfig;
  budget: SubagentBudget;
  signal: AbortSignal;
  /**
   * The session that spawned this subagent, fixed at spawn time.
   *
   * A worker belongs to one session for its whole life. Runners must stamp
   * their events with THIS rather than re-reading the host's current session:
   * with four tabs live, the host's session moves whenever the user switches
   * tabs, and a late-firing event would then be filed under whichever tab
   * happened to be in front.
   */
  sessionId?: string | undefined;
  /** Null until `setSubagentBridge` is called for this subagent. */
  bridge: AgentBridge | null;
  /** Publish a bounded in-memory snapshot that survives timeout races. */
  reportProgress?: ((partial: SubagentPartialResult) => void) | undefined;
}

export interface SubagentRunOutcome {
  result?: unknown | undefined;
  report?: SubagentStructuredReport | undefined;
  iterations: number;
  toolCalls: number;
}

export interface CoordinatorStatus {
  coordinatorId: string;
  subagents: {
    id: string;
    name: string;
    status: 'running' | 'idle' | 'stopped' | 'error';
    currentTask?: string | undefined;
    /** Cumulative budget auto-extensions granted to this subagent, when the
     *  status is produced by a Director that tracks them. */
    extensions?: number | undefined;
  }[];
  pendingTasks: number;
  completedTasks: number;
  totalIterations: number;
  done: boolean;
}

export interface SubagentContext {
  subagentId: string;
  tasks: TaskSpec[];
  /**
   * Two-phase initialization: `spawn()` creates the subagent before the
   * bridge is wired (`setSubagentBridge()`), so `parentBridge` is nullable
   * by design. Readers must `hasParentBridge()`-guard or null-check before
   * use; the prior `null as never as AgentBridge` cast was a type lie
   * that hid this from the compiler.
   */
  parentBridge: AgentBridge | null;
  doneCondition: DoneCondition;
  maxConcurrent: number;
}
