/**
 * Public option, policy and tunable types for BrainMonitor. Split out of
 * brain-monitor.ts.
 */
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { BrainArbiter } from './brain.js';

export interface BrainInterventionInput {
  subject: string;
  body: string;
  /**
   * The session whose distress triggered this intervention.
   *
   * The steer has to reach THAT leader. A host that resolves the target from
   * its own "current session" instead delivers the correction to whichever
   * session is in front — with several sessions live under one host, the tab
   * that is struggling gets nothing and an unrelated one is told to change
   * approach. Undefined only when the signal itself carried no session.
   */
  sessionId?: string | undefined;
}

/**
 * How a detected distress signal is resolved.
 *
 * - `llm` (default) — consult the Brain. Historically the ONLY behaviour, and
 *   an expensive one: the monitor's request carries options, `medium` risk and
 *   `fallback: 'ask_human'`, which defeats `quickDecide` (it declines
 *   option-bearing requests) and the low-risk policy fast path alike, so every
 *   engagement reached a provider. Deterministic handling is available without
 *   leaving this mode by adding a `brain.rules` entry matching
 *   `source: 'system'` with `offersOption: 'steer'` — the rule tier runs in
 *   front of everything that costs tokens.
 * - `steer` — always intervene, no Brain call at all.
 * - `observe` — never intervene; only emit `brain.intervention` for the
 *   surfaces. Useful to measure how often signals fire before acting on them.
 */
export type BrainMonitorPolicy = 'llm' | 'steer' | 'observe';

/** Per-signal kill switches. Omitted = enabled. */
export interface BrainMonitorSignalToggles {
  toolFailureStreak?: boolean | undefined;
  errorStorm?: boolean | undefined;
  agentStall?: boolean | undefined;
  fileChurn?: boolean | undefined;
}

export interface BrainMonitorOptions {
  events: EventBus;
  brain: BrainArbiter;
  /** Active host session id, read lazily so resume/new-session switches are reflected. */
  sessionId?: (() => string | undefined) | undefined;
  /**
   * Leader session id used to filter out subagent events. The BrainMonitor
   * subscribes to global events (tool.executed, agent.run.*, error, etc.)
   * which fire for BOTH the leader agent and subagents. Without this filter,
   * a subagent's tool failures or stalls incorrectly trigger a steer to the
   * leader — disrupting the leader's work for problems it didn't cause.
   *
   * When set, any event whose `sessionId` differs from this value is skipped.
   * Events without a `sessionId` field are always passed through (backward
   * compatibility). Pass a **lazy getter** when the session id may change
   * at runtime (session resume), or a string for static sessions.
   */
  leaderSessionId?: string | (() => string | undefined) | undefined;
  /**
   * Deliver a corrective steer to the working agent(s). Hosts typically
   * send a `steer` mail to this session's leader via the project mailbox — the agent loop injects it before the next LLM call.
   */
  intervene: (input: BrainInterventionInput) => Promise<void>;
  /** Consecutive failures of the SAME tool before engaging. Default 3. */
  toolFailureStreak?: number | undefined;
  /** Number of `error` events within the window before engaging. Default 4. */
  errorStormCount?: number | undefined;
  /** Sliding window for the error storm signal (ms). Default 60_000. */
  errorStormWindowMs?: number | undefined;
  /**
   * Active run with no observable progress (tool call / iteration) for this
   * long, with no tool still running → agent-stall signal.
   * Default 300_000 (5 min). 0 disables.
   */
  stallMs?: number | undefined;
  /** How often the stall watchdog checks (ms). Default 30_000. */
  stallCheckIntervalMs?: number | undefined;
  /** Edits to the SAME file within the churn window before engaging. Default 20. */
  fileChurnThreshold?: number | undefined;
  /** Sliding window for the file-churn signal (ms). Default 600_000 (10 min). */
  fileChurnWindowMs?: number | undefined;
  /** Minimum gap between engagements of the same signal kind (ms). Default 120_000. */
  cooldownMs?: number | undefined;
  /** Master kill switch. Default true; false makes `start()` a no-op. */
  enabled?: boolean | undefined;
  /** How an engagement is resolved. Default 'llm'. */
  policy?: BrainMonitorPolicy | undefined;
  /** Per-signal kill switches. Omitted signals stay enabled. */
  signals?: BrainMonitorSignalToggles | undefined;
  /**
   * Tool names whose successful execution counts as a file edit for the
   * churn signal. Replaces the built-in set; matched case-insensitively.
   * Needed by hosts whose edit tools are named differently — otherwise the
   * churn signal silently never fires for them.
   */
  fileEditTools?: readonly string[] | undefined;
}

/**
 * The subset of `BrainMonitorOptions` that can be re-applied to a running
 * monitor via `reconfigure()` — everything except the wiring (`events`,
 * `brain`, `intervene`, session-id resolvers), which is fixed for the
 * monitor's lifetime. Mirrors `BrainConfig.monitor`.
 */
export type BrainMonitorTunables = Partial<
  Pick<
    BrainMonitorOptions,
    | 'enabled'
    | 'policy'
    | 'signals'
    | 'toolFailureStreak'
    | 'errorStormCount'
    | 'errorStormWindowMs'
    | 'stallMs'
    | 'stallCheckIntervalMs'
    | 'fileChurnThreshold'
    | 'fileChurnWindowMs'
    | 'cooldownMs'
    | 'fileEditTools'
  >
>;
