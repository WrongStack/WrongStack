export interface FleetEventMap {
  // ── Fleet supervisor ─────────────────────────────────────────────────────
  // Emitted by FleetSupervisor (coordination/fleet-supervisor.ts) — the
  // brain-gated shadow watcher over the generic Director fleet. Every
  // engagement leaves a signal → decision → action trail so surfaces (and
  // /supervisor log) can show WHY the fleet was rebalanced/steered.
  /**
   * A supervision rule detected a condition worth engaging on (starvation,
   * overload, backlog, stuck agent, failure streak). Fires even when the
   * subsequent decision is "do nothing" — the signal trail is the audit log.
   */
  'fleet.supervisor.signal': {
    sessionId?: string | undefined;
    /** Rule kind, e.g. 'pinned_starvation' | 'overloaded_worker' | 'backlog' | 'stuck_agent' | 'failure_streak' | 'idle_with_work'. */
    kind: string;
    subagentId?: string | undefined;
    taskId?: string | undefined;
    detail: string;
  };
  /**
   * The supervisor consulted its decision path for a signal. `via:'rule'`
   * means the deterministic policy answered without an LLM; `via:'brain'`
   * means the tiered BrainArbiter was engaged. `outcome:'escalated'` =
   * unresolved ask_human, no action taken.
   */
  'fleet.supervisor.decision': {
    sessionId?: string | undefined;
    kind: string;
    proposedAction: string;
    via: 'rule' | 'brain';
    outcome: 'approved' | 'denied' | 'escalated' | 'skipped';
    rationale?: string | undefined;
  };
  /** The supervisor executed (or failed to execute) an approved action. */
  'fleet.supervisor.action': {
    sessionId?: string | undefined;
    action: 'retarget' | 'spawn_helper' | 'steer' | 'notify_leader' | 'terminate';
    subagentId?: string | undefined;
    taskId?: string | undefined;
    ok: boolean;
    detail?: string | undefined;
  };
}
