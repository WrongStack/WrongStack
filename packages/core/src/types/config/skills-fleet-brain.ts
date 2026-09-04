import type { BrainHeuristicsConfig } from '../../coordination/brain-heuristics.js';
import type { BrainRule } from '../../coordination/brain-rules.js';

export interface SkillsConfig {
  /**
   * Read skills from foreign coding-agent directories (`<project>/.claude/skills`
   * and `~/.claude/skills`). Default `true`. Lets Claude Code / Codex / Gemini /
   * `asm` / `gh skill` skills be used without copying them.
   */
  readClaudeSkills?: boolean | undefined;
  /**
   * Scan OTHER coding agents' skill directories (`~/.codex/skills`,
   * `~/.cursor/skills`, `~/.agents/skills`, `~/.qwen/skills`,
   * `~/.trae/skills`, … + their `<project>/.<tool>/…` equivalents). Default
   * `true` (all known tools); pass a tool-id list to restrict, or `false` to
   * disable. Non-existent dirs are skipped. Unknown ids in the list (likely
   * typos) are dropped and surfaced via a config warning.
   */
  foreignSources?: boolean | string[] | undefined;
  /**
   * How skill bodies reach the system prompt.
   * - `'progressive'` (default): inject only the metadata manifest; the agent loads a
   *   skill body on demand via the `skill` tool (the agentskills.io model).
   * - `'eager'`: inject discovered skill bodies up to `eagerMaxChars`.
   */
  mode?: 'eager' | 'progressive' | undefined;
  /**
   * Extra skill directories to scan (lowest priority, after the `.claude`
   * layers). Honored only from the user config; stripped from in-project config.
   */
  extraDirs?: string[] | undefined;
  /**
   * In eager mode, the maximum total chars of skill bodies injected into the
   * prompt (highest-priority skills first; the rest are listed as a manifest the
   * agent loads via the `skill` tool). Bounds prompt cost when many skills are
   * discovered. Default 24000 (~6k tokens). Set very high to disable. Ignored in
   * progressive mode (which injects only the manifest anyway).
   */
  eagerMaxChars?: number | undefined;
  /**
   * Base URL of the skill registry used by `/skill-search` and
   * `/skill-install <registry>:<id>`. Default `https://skills.sh` (the open
   * marketplace backed by mastra-ai/skills-api). Honored only from the user
   * config; stripped from in-project config (a repo-committed override would be
   * an SSRF / prompt-injection vector — the registry response is parsed into the
   * prompt). Set to a self-hosted skills-api instance to use a private catalog.
   */
  registryUrl?: string | undefined;
}

/**
 * Fleet peer-awareness + supervision settings. All sub-features are
 * enabled-by-default with conservative throttles; each has its own kill
 * switch. See `FleetSupervisor` (coordination/fleet-supervisor.ts) for the
 * supervisor semantics.
 */
export interface FleetConfig {
  /** Subagent process/registry lifecycle after it is no longer doing work. */
  lifecycle?:
    | {
        /**
         * Remove a spawned or between-task subagent after this much idle time.
         * This is separate from the in-task activity watchdog. Default 300000.
         */
        idleTimeoutMs?: number | undefined;
        /**
         * Retire a subagent as soon as its final task result is delivered and
         * no queued task reused it in the same dispatch cycle. Default true.
         */
        retireOnTaskComplete?: boolean | undefined;
      }
    | undefined;
  /** Fleet-wide hard ceilings. In-flight work may finish; new spawns are refused at the cap. */
  budget?:
    | {
        /** Maximum subagents spawned during one Director lifetime. Default 64 in CLI. */
        maxSpawns?: number | undefined;
        /** Maximum cumulative input+output tokens across all fleet subagents. */
        maxTokens?: number | undefined;
        /** Maximum cumulative estimated USD cost across all fleet subagents. */
        maxCostUsd?: number | undefined;
      }
    | undefined;
  /** Periodic "[FLEET PULSE]" peer-status digest folded into each agent's context. */
  pulse?:
    | {
        /** Default true. */
        enabled?: boolean | undefined;
        /** Inject at most every N agent iterations. Default 5. */
        everyNIterations?: number | undefined;
        /** Hard cap on digest characters. Default 900. */
        maxChars?: number | undefined;
        /** Max peers listed per digest. Default 15. */
        maxAgents?: number | undefined;
      }
    | undefined;
  /** Broadcast `type:'status'` mails on meaningful subagent transitions. */
  statusBroadcasts?:
    | {
        /** Default true. */
        enabled?: boolean | undefined;
        /** Min interval between broadcasts about the same subagent. Default 15000. */
        minIntervalMsPerAgent?: number | undefined;
        /** Global cap on broadcasts per minute (excess dropped + counted). Default 20. */
        globalPerMinuteCap?: number | undefined;
        /**
         * Broadcast recoverable soft-budget warnings to every project agent.
         * Default false: the local fleet UI still tracks warnings/extensions,
         * but routine preemption and auto-extension do not flood peer mailboxes.
         */
        budgetWarnings?: boolean | undefined;
      }
    | undefined;
  /**
   * Per-subagent git-worktree isolation for Director fleets. The default is
   * `auto`: mutating/build-capable subagents run in isolated checkouts and are
   * squash-merged back on success; read-only review agents usually stay on the
   * shared checkout. Set `enabled:false` or `mode:'off'` when a workflow cannot
   * use worktrees.
   */
  worktrees?:
    | {
        /** Kill switch. Default true. */
        enabled?: boolean | undefined;
        /**
         * `auto` (default): isolate only side-effectful subagents.
         * `required`: side-effectful subagents must get a worktree or fail.
         * `off`: never allocate worktrees.
         */
        mode?: 'auto' | 'required' | 'off' | undefined;
        /**
         * Merge successful task branches back into the base checkout. Default
         * true. When false, successful worktrees are committed and kept for
         * manual `/worktree merge`.
         */
        autoMerge?: boolean | undefined;
        /** Keep failed/timeout worktrees when they contain changes. Default true. */
        keepFailed?: boolean | undefined;
      }
    | undefined;
  /** Brain-gated fleet supervisor (rebalance/steer/spawn-helper). */
  supervisor?: FleetSupervisorConfig | undefined;
  /**
   * Explore Companion — state-triggered background codebase explorer behind
   * the leader. Watches the leader's in-progress work state and assigns
   * read-only exploration probes to a resident `explore-companion`
   * subagent; findings return via mailbox. Default enabled.
   */
  exploreCompanion?: ExploreCompanionConfig | undefined;
  /** Roster-agent self-learning: capture → optimize → per-skill addenda. */
  learning?: AgentLearningConfig | undefined;
}

/**
 * Automatic optimization of roster-agent learning.
 *
 * Capture is always automatic. This section governs the *distillation* pass
 * that turns captured directives into per-skill project addenda and a
 * consolidated role document, then archives and resets the raw buffer.
 */
export interface AgentLearningConfig {
  autoOptimize?:
    | {
        /** Run the distillation pass automatically. Default true. */
        enabled?: boolean | undefined;
        /** Raw buffer size (bytes) that makes a role eligible. Default 8192. */
        thresholdBytes?: number | undefined;
        /** Never optimize a buffer with fewer directives than this. Default 4. */
        minEntries?: number | undefined;
        /**
         * Directives routed to a skill that has no addendum yet. Reaching this
         * count makes a role eligible even below `thresholdBytes`. Default 3.
         */
        minPendingSkillDirectives?: number | undefined;
        /** Minimum gap between automatic passes for one role. Default 6h. */
        minIntervalMs?: number | undefined;
        /** Quiet period after the last capture before a pass starts. Default 20s. */
        debounceMs?: number | undefined;
        /**
         * Evaluate every role once when the fleet host starts, so roles that
         * became eligible before this session are not stuck waiting for their
         * next capture. Default true.
         */
        sweepOnStart?: boolean | undefined;
      }
    | undefined;
}

/** Config surface for the brain-gated FleetSupervisor. */
export interface FleetSupervisorConfig {
  /** Kill switch. Default true (active whenever a Director is running). */
  enabled?: boolean | undefined;
  /** Evaluation tick. Default 20000. */
  intervalMs?: number | undefined;
  /** Per-(signal,subject) re-engagement cooldown. Default 120000. */
  cooldownMs?: number | undefined;
  /** Hard cap on interventions touching one subagent per run. Default 3. */
  maxInterventionsPerSubagent?: number | undefined;
  /** Pending task pinned to a busy worker longer than this → starvation signal. Default 60000. */
  pinnedWaitMs?: number | undefined;
  /** ≥ this many pending tasks pinned to one worker (with an idle sibling) → overload signal. Default 2. */
  overloadPinnedThreshold?: number | undefined;
  /** pending > backlogFactor × live workers (sustained) → spawn-helper signal. Default 2. */
  backlogFactor?: number | undefined;
  /** Running subagent with no observable fleet activity for this long → stuck signal. Default 180000. */
  stuckMs?: number | undefined;
  /** Consecutive failed/timeout results from one subagent → failure-streak signal. Default 2. */
  failureStreak?: number | undefined;
  /** Allow the supervisor to spawn helper subagents. Default true. */
  allowSpawn?: boolean | undefined;
  /** Allow the supervisor to terminate subagents (highest risk). Default false. */
  allowTerminate?: boolean | undefined;
}

/** Config surface for the ExploreCompanion host wiring. */
export interface ExploreCompanionConfig {
  /** Kill switch. Default true. */
  enabled?: boolean | undefined;
  /** Min gap between probes on the same subject (ms). Default 120000. */
  cooldownMs?: number | undefined;
  /** Pending probe queue cap (drop oldest when full). Default 8. */
  maxPending?: number | undefined;
  /** Mailbox poll interval for explicit asks (ms). Default 5000. */
  pollIntervalMs?: number | undefined;
}

/**
 * One member of the Brain's LLM pool or council. String entries elsewhere
 * (`Config.brain.models`, council voters) parse with the same `parseModelRef`
 * grammar as `fallbackModels`: bare `model`, `provider/model`, or
 * `provider model`.
 */
export interface BrainModelEntry {
  /** Provider id (a key of `Config.providers` or a catalog id). Defaults to the session provider. */
  provider?: string | undefined;
  /** Model id, required. */
  model: string;
}

/** One voting seat on the Brain council. */
export interface BrainCouncilVoterConfig extends BrainModelEntry {
  /**
   * Decision lens for this seat. Built-ins: 'executor' (progress-biased),
   * 'skeptic' (risk-hunting), 'auditor' (cost/waste-focused), 'security'
   * (trust boundaries, abuse cases), 'maintainer' (complexity, compatibility)
   * and 'user-advocate' (usability, recovery). Any other string is registered
   * as an ad-hoc lens whose instruction is the string itself.
   */
  persona?: string | undefined;
  /** Vote weight in the tally. Default 1. */
  weight?: number | undefined;
  /** When true, this seat's explicit refusal denies the request outright. */
  veto?: boolean | undefined;
}

/** Multi-LLM council configuration for high-stakes Brain decisions. */
export interface BrainCouncilConfig {
  /** Kill switch. Default: enabled when `voters` is non-empty or ≥2 pool models exist. */
  enabled?: boolean | undefined;
  /**
   * Minimum request risk that convenes the council instead of the single-LLM
   * tier. Default 'high'. 'critical' = council only for critical questions;
   * 'medium' = council for most non-trivial questions (slow + expensive).
   */
  minRisk?: 'medium' | 'high' | 'critical' | undefined;
  /**
   * Voting seats. String entries use the `parseModelRef` grammar and get
   * default personas (executor, skeptic w/ veto, auditor) assigned in order.
   * When omitted, seats are derived from `brain.models` (up to 3).
   */
  voters?: Array<string | BrainCouncilVoterConfig> | undefined;
  /** Fraction of seats that must return a valid vote. Default 0.5. */
  quorum?: number | undefined;
  /** Fraction of cast vote weight the winning option must exceed. Default 0.5. */
  approval?: number | undefined;
  /**
   * Per-seat completion timeout (ms). Defaults to `brain.decisionTimeoutMs`,
   * then 45000 — the council convenes for high-stakes decisions only, and
   * reasoning models often need well over the single-LLM tier's 15s before
   * their first token.
   */
  perCallTimeoutMs?: number | undefined;
  /** Seats polled concurrently, 1..8. Default 3. */
  maxConcurrency?: number | undefined;
  /**
   * Warn when the panel is not diverse enough: 'none' (default), 'model'
   * (seats must use distinct models) or 'provider' (distinct providers).
   * A same-model "council" agrees with itself and adds cost without adding
   * independence.
   */
  distinctness?: 'none' | 'model' | 'provider' | undefined;
  /**
   * Output budget per voter seat call. Default 2000. Reasoning models spend
   * their thinking tokens from this same budget, so a small value starves
   * them into `invalid` votes (empty or truncated JSON) — raise it if seat
   * errors report "response truncated at maxTokens".
   */
  voterMaxTokens?: number | undefined;
  /** Output budget for the judge call. Default follows the seat budget. */
  judgeMaxTokens?: number | undefined;
  /**
   * Voting rounds per decision. Default 2.
   *
   * Round 1 is independent — no seat sees another. From round 2 on, every
   * seat is shown the others' previous ballots and votes again; only the
   * final round is tallied. A seat that missed a consequence another lens
   * caught can revise on it.
   *
   * Cost is LINEAR: 2 rounds means two provider calls per seat on every
   * council decision, not only contested ones. Set 1 to restore the
   * single-round panel.
   *
   * The trade is independence for information, and it is not free — models
   * converge on a stated majority whether or not the majority brought an
   * argument. Watch `deliberationChanges` on the resolution: a panel where
   * most seats flip every round has stopped being a panel, and the
   * orchestrator warns when that happens.
   */
  deliberationRounds?: number | undefined;

  /**
   * Persona rotation for seats without an explicit one. Replaces the built-in
   * executor / skeptic(veto) / auditor cycle.
   */
  seats?: Array<{ persona: string; veto?: boolean | undefined }> | undefined;
  /**
   * Tie-breaker / synthesizer model (`parseModelRef` grammar or entry).
   * Sees every vote's rationale and issues the final structured decision.
   * Default: the first pool/voter model.
   */
  judge?: string | BrainModelEntry | undefined;
}

/**
 * Brain decision-layer configuration. SECURITY: in the in-project config
 * DENY list — a repo-committed config must not be able to raise the
 * autonomy ceiling, remove the human tier, or point Brain decisions at an
 * attacker-chosen provider. Only honoured from the active-profile config.
 */
export interface BrainConfig {
  /**
   * 'headless'    — the Brain NEVER blocks on a human. Escalations resolve
   *                 via the terminal policy (recommended option for low/medium
   *                 risk, request fallback semantics, otherwise deny).
   * 'interactive' — escalations prompt the human in the TUI/WebUI.
   * Default (resolved at boot by `resolveBrainConfigDefaults`): 'headless' —
   * minimum-human out of the box. Switch live with `/brain mode <m>`.
   */
  mode?: 'headless' | 'interactive' | undefined;
  /**
   * Initial autonomy ceiling for the LLM tier. Default (resolved at boot):
   * adaptive — 'all' when a council can convene (≥2 voters/pool models),
   * otherwise 'high'. Live-set via `/brain risk`.
   */
  maxAutoRisk?: 'off' | 'low' | 'medium' | 'high' | 'all' | undefined;
  /**
   * Ordered LLM pool for Brain decisions (`parseModelRef` grammar or
   * entries). With `strategy: 'fallback'` the first entry is primary and the
   * rest are tried in order when it fails; with 'round-robin' calls rotate
   * across the pool. Default (resolved at boot): the user's `fallbackModels`
   * chain; with none configured, the session provider/model is used.
   */
  models?: Array<string | BrainModelEntry> | undefined;
  /** Pool selection strategy. Default 'fallback'. */
  strategy?: 'fallback' | 'round-robin' | undefined;
  /**
   * Per-LLM-call decision timeout (ms). Default 45000 — reasoning models
   * spend their budget thinking, and the previous 15s aborted them
   * mid-response. The whole pool walk is separately capped at three
   * attempts' worth of this budget, so a deep fallback chain of dead
   * endpoints cannot block the caller for N x this value.
   */
  decisionTimeoutMs?: number | undefined;
  /**
   * Quality gate for the single-LLM tier — what counts as a usable answer.
   * The tier used to wrap ANY returned text in an `answer`, so an empty
   * response or an "I don't know" became a decision the caller acted on.
   */
  llm?:
    | {
        /**
         * Output budget per decision call. Default 2000.
         *
         * The RESPONSE is one decision plus a one-sentence rationale, but a
         * reasoning model's thinking tokens come out of the same allowance —
         * a tight budget yields an empty or mid-JSON response that the tier
         * reports as `unparseable`, i.e. the LLM tier silently stops
         * deciding. Lower it only for a pool of non-reasoning models.
         */
        maxTokens?: number | undefined;
        /**
         * Treat a declined/empty response as "this tier could not decide"
         * rather than as an answer. Default true.
         */
        rejectUncertain?: boolean | undefined;
        /**
         * Reject answers whose self-reported confidence is below this (0..1).
         * Default 0 = off. Responses reporting no confidence always pass.
         */
        minConfidence?: number | undefined;
        /**
         * Whether a `deny` from the single-LLM tier ends the decision.
         *
         * The tier reports three very different things as `deny`: a dead
         * provider pool, an unparseable response, and a model that actually
         * refused. Historically all three fell through to the escalation
         * tier, so a genuine refusal could never be terminal.
         *
         * - 'never'        — always fall through (legacy behaviour; the LLM
         *                    tier can then agree but never disagree)
         * - 'when-decided' — DEFAULT. A real refusal is terminal;
         *                    infrastructure failures (dead pool, unparseable
         *                    response) still fall through to the next tier.
         * - 'always'       — any deny is terminal (strict; a dead pool then
         *                    denies the request instead of escalating)
         *
         * NOTE the default is resolved in `createBrainRuntime`, not in
         * `createTieredBrainArbiter` — the raw arbiter stays at 'never' for
         * callers that wire it directly, exactly as it stays at 'medium' for
         * `maxAutoRisk` while the product resolves that adaptively.
         */
        denyIsTerminal?: 'never' | 'when-decided' | 'always' | undefined;
        /**
         * Failure memory for the pool. A dead pool otherwise costs
         * `models.length × decisionTimeoutMs` on EVERY decision.
         */
        circuitBreaker?:
          | {
              /** Consecutive failures before the tier is skipped. Default 3. 0 disables. */
              failureThreshold?: number | undefined;
              /** How long the tier stays skipped before one probe is allowed (ms). Default 60000. */
              cooldownMs?: number | undefined;
            }
          | undefined;
      }
    | undefined;
  /**
   * Interactive mode only: how long an ask-human prompt may stay unanswered
   * before it resolves through the terminal policy instead of blocking
   * forever. Default (resolved at boot): 120000. Set 0 to wait indefinitely
   * (legacy behavior).
   */
  humanTimeoutMs?: number | undefined;
  /**
   * Deterministic rule table, evaluated BEFORE the policy tier and therefore
   * before anything that costs a provider call. First match wins; a rule
   * whose action is `defer` explicitly hands the request to the next tier.
   *
   * This is the intended place to make the Brain cheaper and more
   * predictable: any question the operator can characterise up front
   * (question/context patterns, source, risk band, offered options) can be
   * settled here for free instead of being sent to a model.
   *
   * Invalid rules are dropped with a reported error rather than taking the
   * Brain down. Like the rest of `brain`, this is honoured only from the
   * active-profile config — never from a repo-committed one.
   */
  rules?: BrainRule[] | undefined;
  /**
   * Toggles for the built-in pattern heuristics (low-risk fast path,
   * blocked-resolved, deadlock-skip, retry-exhausted, continue-ping). Every
   * flag defaults to enabled, so omitting this block preserves the historical
   * behaviour. Turn one off when its guess is wrong for your workload, or
   * replace `blockedResolvedMarkers` to match your own vocabulary.
   */
  heuristics?: BrainHeuristicsConfig | undefined;
  /**
   * How a headless escalation resolves when no human is available.
   * - 'conservative' (default) — accept a caller-recommended option at
   *   low/medium risk, honour `fallback: 'continue'`, otherwise deny.
   * - 'deny-all' — never auto-accept; every escalation denies.
   * - 'continue-on-recommended' — accept a recommended option at ANY risk.
   */
  terminalPolicy?: 'conservative' | 'deny-all' | 'continue-on-recommended' | undefined;
  /** Rolling in-memory decision log size for `/brain status`. Default 20. */
  decisionLogMaxEntries?: number | undefined;
  /**
   * Replay a previous COUNCIL/LLM verdict for an identical repeated question
   * instead of paying for it again. Deterministic tiers are never cached
   * (they are already free) and `ask_human` is never cached. A decision the
   * ledger later observes to have FAILED is evicted, so the cache cannot
   * cement a bad call. Disabled by default — caching a judgement is opt-in.
   */
  cache?:
    | {
        enabled?: boolean | undefined;
        /** Entry lifetime (ms). Default 300000. */
        ttlMs?: number | undefined;
        /** Maximum live entries. Default 200. */
        maxEntries?: number | undefined;
      }
    | undefined;
  /** Multi-LLM council for high-stakes decisions. */
  council?: BrainCouncilConfig | undefined;
  /**
   * Persistent decision ledger (`<project>/.wrongstack/brain-ledger.jsonl`):
   * every decision + observed outcome is appended, and outcome stats for
   * similar past decisions are fed back into the LLM/council prompts.
   * Default: enabled.
   */
  ledger?:
    | {
        enabled?: boolean | undefined;
        /**
         * Deterministic guard: once this many consecutive approvals of a
         * decision group ended in observed failures, deny outright without
         * consulting any LLM (a later success lifts the guard). Default 3.
         * 0 disables.
         */
        autoDenyAfterFailures?: number | undefined;
        /** In-memory ring size, also the seed size read from disk. Default 500. */
        maxMemoryEntries?: number | undefined;
        /**
         * A same-kind monitor intervention re-firing within this window marks
         * the previous steer as a failure. Default 600000 (10 min).
         */
        interventionRetryWindowMs?: number | undefined;
      }
    | undefined;
  /**
   * Replay trace: a per-decision JSONL record of HOW the ladder decided —
   * every tier it ran, every pool target it called (including the failures
   * the fallback loop swallows), and every council seat's vote, with timings
   * and token usage. Rows convert to `BrainEvaluationCaseV1` fixtures for
   * offline replay via `runBrainEvaluation`.
   *
   * DISABLED by default: enabling it is the opt-in that permits production
   * decision content to be written to disk. Kept in its own file rather than
   * the ledger, whose bounded ring powers the learning loop.
   */
  trace?:
    | {
        /** Default false. */
        enabled?: boolean | undefined;
        /** JSONL path. Default `<project>/.wrongstack/brain-trace.jsonl`. */
        path?: string | undefined;
        /**
         * Free-text policy once enabled. Default 'full' — a fixture without
         * the question and context cannot reproduce the original decision.
         * 'redacted' truncates free text; 'none' records metadata only
         * (models, timings, tokens, vote ids, quorum/veto), which still
         * answers "what is the LLM doing" without storing content.
         */
        content?: 'none' | 'redacted' | 'full' | undefined;
        /** Cap on concurrently open (undecided) records. Default 200. */
        maxOpenRecords?: number | undefined;
      }
    | undefined;
  /**
   * BrainMonitor distress-signal thresholds (self-activation). All optional;
   * defaults match `BrainMonitorOptions`.
   */
  monitor?:
    | {
        /** Master kill switch. Default true. */
        enabled?: boolean | undefined;
        /**
         * How a detected signal is resolved. Default 'llm' (consult the
         * Brain). 'steer' always intervenes and 'observe' never does — both
         * without any provider call. Note that monitor engagements can also
         * be made deterministic while staying on 'llm' by adding a
         * `brain.rules` entry matching `source: 'system'`.
         */
        policy?: 'llm' | 'steer' | 'observe' | undefined;
        /** Per-signal kill switches. Omitted signals stay enabled. */
        signals?:
          | {
              toolFailureStreak?: boolean | undefined;
              errorStorm?: boolean | undefined;
              agentStall?: boolean | undefined;
              fileChurn?: boolean | undefined;
            }
          | undefined;
        /** Consecutive failures of the same tool before engaging. Default 3. */
        toolFailureStreak?: number | undefined;
        /** Errors within the storm window before engaging. Default 4. */
        errorStormCount?: number | undefined;
        /** Sliding window for the error-storm signal (ms). Default 60000. */
        errorStormWindowMs?: number | undefined;
        /** Active run with no progress for this long → stall signal (ms). Default 300000. 0 disables. */
        stallMs?: number | undefined;
        /** How often the stall watchdog ticks (ms). Default 30000. */
        stallCheckIntervalMs?: number | undefined;
        /** Edits to the same file within the churn window before engaging. Default 5. */
        fileChurnThreshold?: number | undefined;
        /** Sliding window for the file-churn signal (ms). Default 600000. */
        fileChurnWindowMs?: number | undefined;
        /**
         * Tool names that count as file edits for the churn signal. REPLACES
         * the built-in list (edit, write, patch, multi_edit, multiedit,
         * str_replace); set it when your edit tools are named differently, or
         * the churn signal will never fire for them.
         */
        fileEditTools?: string[] | undefined;
        /** Per-signal re-engagement cooldown (ms). Default 120000. */
        cooldownMs?: number | undefined;
      }
    | undefined;
}

/** Git behavior overrides for agent-run git commands. See `Config.git`. */
