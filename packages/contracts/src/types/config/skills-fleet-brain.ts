export type {
  BrainConfig,
  BrainCouncilConfig,
  BrainCouncilVoterConfig,
  BrainModelEntry,
} from './brain-config.js';

export interface SkillsConfig {
  /** Local bundled-skill recommendations and bounded primary body preload. Default true; no API/account. */
  localSuggest?: boolean | undefined;
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
  /**
   * Per-turn skill suggestion via TypeSafe's System One API. OFF by default.
   *
   * When on, the latest user message and the roster's skill names + trigger
   * lines are sent to TypeSafe before each new turn, and at most one skill
   * name is appended to the system prompt as a suggestion the model is told it
   * may ignore. See `skills/suggest/skill-suggester.ts` for the two passes and
   * `docs/skills-suggestion.md` for how to evaluate the thresholds.
   *
   * Credentials and endpoint live in top-level `typesafe`, shared with the
   * dispatch classifier. This subtree is stripped from in-project config:
   * `enabled` alone turns on outbound transmission of the user's prompts.
   */
  suggest?: SkillSuggestConfig | undefined;
}

/** Settings for the TypeSafe-backed skill suggester. Account: `config.typesafe`. */
export interface SkillSuggestConfig {
  /** Master switch. Default `false`. */
  enabled?: boolean | undefined;
  /** Candidates carried from the wide ranking into the detailed pass. Default 3. */
  shortlistSize?: number | undefined;
  /** Body characters each shortlisted skill contributes as evidence. Default 700. */
  excerptChars?: number | undefined;
  /**
   * Mean of the three "does this turn need a skill at all" probabilities below
   * which nothing is suggested. Default 0.3. Raise it to suggest less often.
   */
  gateThreshold?: number | undefined;
  /**
   * Best per-candidate "does this skill do the thing asked for" probability
   * below which the whole shortlist is dropped. Default 0.3.
   */
  fitsThreshold?: number | undefined;
  /** Hard deadline for both passes combined, in ms. Default 3000. */
  deadlineMs?: number | undefined;
  /** Skip turns whose latest user message is shorter than this. Default 12. */
  minRequestChars?: number | undefined;
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
  /**
   * Agent dispatcher: how an ambiguous free-form task picks a specialist role.
   *
   * Lives under `fleet` for the same reason `delegate` does — it inherits the
   * whole-subtree in-project denial, so a repo-committed config cannot start
   * sending task descriptions to a third party.
   */
  dispatch?:
    | {
        /**
         * Resolve ambiguous dispatches with a TypeSafe `Choice` instead of a
         * prose-and-parse LLM call. Default false.
         *
         * Only fires when the keyword heuristic is already ambiguous, so it
         * costs one request on the minority of dispatches the heuristic cannot
         * settle. Needs a `typesafe` account.
         */
        typesafeClassifier?: boolean | undefined;
        /**
         * Decline (fall back to the heuristic / the generalist) when "does any
         * candidate genuinely fit" lands below this. Default 0.35.
         */
        fitThreshold?: number | undefined;
        /**
         * Decline when the Choice's own confidence is below this. Default 0.2 —
         * deliberately low, because several equally acceptable roles spread
         * probability the same way genuine confusion does.
         */
        minConfidence?: number | undefined;
      }
    | undefined;
  /**
   * `delegate` tool behaviour. Lives under `fleet` so it inherits the
   * in-project denial: a repo config cannot turn on autonomous wakes.
   */
  delegate?:
    | {
        /**
         * Default for the tool's `wait` input when the model omits it.
         * Default false (background). Temporary rollback switch: set true to
         * restore the historical blocking behaviour.
         */
        defaultWait?: boolean | undefined;
        /** Start a leader turn when a background result arrives and the leader is idle. Default true. */
        autoWake?: boolean | undefined;
        /** Coalescing window for auto-wake. Default 1500. */
        autoWakeDebounceMs?: number | undefined;
        /** Consecutive woken turns without user input before holding results. Default 5. */
        maxChainedWakes?: number | undefined;
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
   * subagent; findings return via same-session notes. Default enabled.
   */
  exploreCompanion?: ExploreCompanionConfig | undefined;
  /**
   * Skill Companion — background skill picker behind the leader. On a new
   * turn, a todo starting, or the first edit in a new file family, a resident
   * `skill-companion` judges the skill catalog against the work and
   * recommends at most two skills the leader has not loaded. Default enabled.
   */
  skillCompanion?: SkillCompanionConfig | undefined;
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
  /**
   * Loop detections (`tool.loop_detected`) from one subagent with no completed
   * task in between → looping-worker signal. Default 3.
   *
   * The `stuckMs` signal cannot cover this: it keys on the absence of fleet
   * activity, and a worker going in circles is the busiest thing on the bus.
   */
  loopStreak?: number | undefined;
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
  /** Per-signal switches. Omitted signals stay enabled for compatibility. */
  signals?:
    | {
        editUnreadFile?: boolean | undefined;
        searchZeroHits?: boolean | undefined;
        unfamiliarRead?: boolean | undefined;
        todoInProgress?: boolean | undefined;
        errorSymbol?: boolean | undefined;
        mailboxAsk?: boolean | undefined;
      }
    | undefined;
  /** Discard queued automatic probes older than this. Default 120000. Explicit asks survive. */
  maxProbeAgeMs?: number | undefined;
  /** Hard host deadline per probe, including assignment. Default 120000. */
  probeTimeoutMs?: number | undefined;
  /** Runtime tool-call ceiling for each probe. Default 16. */
  maxToolCallsPerProbe?: number | undefined;
  /** Maximum characters forwarded to the leader per result. Default 1800. */
  maxFindingsChars?: number | undefined;
}

/** Config surface for the Skill Companion host wiring. */
export interface SkillCompanionConfig {
  /** Kill switch. Default true. */
  enabled?: boolean | undefined;
  /**
   * What a recommendation does beyond the note. `speed-bump` (default) holds
   * the leader's next file change once until it loads the skill or retries;
   * `off` keeps the note only.
   */
  enforce?: 'speed-bump' | 'off' | undefined;
  /** Judged probes per conversation. Default 8. */
  maxProbesPerSession?: number | undefined;
  /** Minimum self-reported confidence (0..1) a pick needs. Default 0.6. */
  minConfidence?: number | undefined;
  /** Host and worker deadline per probe. Default 300000; larger values are honored. */
  probeTimeoutMs?: number | undefined;
  /**
   * Skills offered to the judge per probe, after eligibility filtering and
   * lexical ranking against the work (best overlap first). Default 80.
   */
  maxCandidates?: number | undefined;
  /**
   * Recommend a skill without a model call when the leader edits a file that
   * matches the skill's frontmatter `paths` globs. Default true.
   */
  pathRules?: boolean | undefined;
  /**
   * Record whether the leader loaded or refused each recommendation
   * (`.wrongstack/agents/skill-companion/outcomes.json`, local) and stop
   * offering a skill it keeps refusing in this project. Default true.
   */
  learnOutcomes?: boolean | undefined;
}

/** Git behavior overrides for agent-run git commands. See `Config.git`. */
