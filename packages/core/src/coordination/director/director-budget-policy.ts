import type { BrainArbiter } from '../brain.js';
import type { FleetBus, FleetUsageAggregator } from '../fleet-bus.js';

type BudgetKind = 'timeout' | 'idle_timeout' | 'iterations' | 'tool_calls' | 'tokens' | 'cost';

interface BudgetThresholdPayload {
  kind: BudgetKind;
  used: number;
  limit: number;
  timeoutMs: number;
  extend(extra: Record<string, unknown>): void;
  deny(): void;
}

export interface DirectorBudgetPolicyDeps {
  fleet: FleetBus;
  usage: FleetUsageAggregator;
  brain?: BrainArbiter | undefined;
  maxBudgetExtensions: number;
  maxFleetCostUsd: number;
  currentSessionId(): string | undefined;
  /**
   * When true, this subagent is owned by an active collab-debug session whose
   * own `budget.threshold_reached` handler will grant/deny. Skip director
   * auto-extend so the two policies don't race. Plain `delegate` spawns of
   * critic / bug-hunter / refactor-planner reuse the same id prefixes but are
   * NOT collab-owned — they must fall through to the director grant path or
   * they die at the first soft limit with no extension chance.
   */
  isCollabOwned?: ((subagentId: string) => boolean) | undefined;
}

/** Owns budget-threshold admission, progress heartbeats, and extension history. */
export class DirectorBudgetPolicy {
  private readonly extendTotals = new Map<string, number>();
  /**
   * Per-(subagentId:budgetKind) extension-grant counter. Tracks how many times
   * the director has granted an extension for a specific kind so the
   * `maxBudgetExtensions` ceiling is enforced per kind. Reset to 0 on deny.
   * Promoted from a closure-local so `removeSubagent` can clean stale entries.
   */
  private readonly extendCounts = new Map<string, number>();
  /**
   * Running tool-call count per subagent — the heartbeat signal for timeout
   * extension gating. Incremented on every `tool.executed` event. Promoted
   * from a closure-local so `removeSubagent` can clean stale entries.
   */
  private readonly progressBySubagent = new Map<string, number>();
  /**
   * Per-(subagentId:timeoutKind) last-known tool-call count at the moment an
   * extension was granted. Used by the heartbeat gate: if progress hasn't
   * advanced since the last grant, the next threshold event is denied.
   * Promoted from a closure-local so `removeSubagent` can clean stale entries.
   */
  private readonly lastTimeoutProgress = new Map<string, number>();
  private readonly disposers: Array<() => void> = [];
  private started = false;

  constructor(private readonly deps: DirectorBudgetPolicyDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    this.disposers.push(
      this.deps.fleet.filter('tool.executed', (event) => {
        const current = this.progressBySubagent.get(event.subagentId) ?? 0;
        this.progressBySubagent.set(event.subagentId, current + 1);
      }),
      this.deps.fleet.filter('budget.threshold_reached', (event) => {
        // Only skip agents that are currently inside a collab-debug session.
        // Id-prefix alone is not enough: `delegate({ role: 'critic' })` mints
        // `critic-<uuid>` ids for ordinary one-shot work, and without this
        // fall-through nobody answers budget.threshold_reached → negotiation
        // times out at DECISION_TIMEOUT_MS and the worker dies with budget_timeout.
        if (
          this.isCollabAgent(event.subagentId) &&
          (this.deps.isCollabOwned?.(event.subagentId) ?? false)
        ) {
          return;
        }
        const payload = event.payload as BudgetThresholdPayload;
        if (payload.kind === 'timeout' || payload.kind === 'idle_timeout') {
          this.handleTimeoutThreshold(event.subagentId, event.taskId, payload);
          return;
        }

        const guardKey = `${event.subagentId}:${payload.kind}`;
        const prior = this.extendCounts.get(guardKey) ?? 0;
        if (prior >= this.deps.maxBudgetExtensions) {
          payload.deny();
          this.extendCounts.delete(guardKey);
          return;
        }
        if (payload.kind === 'cost' && this.deps.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
          const totalCost = this.deps.usage.snapshot().total?.cost ?? 0;
          if (totalCost >= this.deps.maxFleetCostUsd) {
            payload.deny();
            return;
          }
        }

        const grant = () =>
          this.grantBoundedExtension(event.subagentId, event.taskId, payload, guardKey, prior);
        if (payload.kind !== 'cost' || !this.deps.brain) {
          grant();
          return;
        }
        this.requestCostDecision(event.subagentId, event.taskId, payload, prior, grant);
      }),
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.started = false;
  }

  extensionsFor(subagentId: string): number {
    return this.extendTotals.get(subagentId) ?? 0;
  }

  removeSubagent(subagentId: string): void {
    this.extendTotals.delete(subagentId);
    // Clean up per-subagent entries from all extension/heartbeat maps. These
    // were previously closure-locals in start(), unreachable from this method,
    // so every retired subagent leaked its entries for the session lifetime.
    this.progressBySubagent.delete(subagentId);
    for (const key of this.extendCounts.keys()) {
      if (key.startsWith(`${subagentId}:`)) this.extendCounts.delete(key);
    }
    for (const key of this.lastTimeoutProgress.keys()) {
      if (key.startsWith(`${subagentId}:`)) this.lastTimeoutProgress.delete(key);
    }
  }

  private handleTimeoutThreshold(
    subagentId: string,
    taskId: string | undefined,
    payload: BudgetThresholdPayload,
  ): void {
    const heartbeatKey = `${subagentId}:${payload.kind}`;
    const progress = this.progressBySubagent.get(subagentId) ?? 0;
    const lastProgress = this.lastTimeoutProgress.get(heartbeatKey) ?? -1;
    if (progress <= lastProgress) {
      payload.deny();
      return;
    }
    this.lastTimeoutProgress.set(heartbeatKey, progress);
    const field = payload.kind === 'timeout' ? 'timeoutMs' : 'idleTimeoutMs';
    setImmediate(() => {
      const newLimit = Math.min(Math.ceil(payload.limit * 2), 24 * 60 * 60_000);
      this.recordExtension(subagentId, taskId, payload.kind, newLimit);
      payload.extend({ [field]: newLimit });
    });
  }

  private grantBoundedExtension(
    subagentId: string,
    taskId: string | undefined,
    payload: BudgetThresholdPayload,
    guardKey: string,
    prior: number,
  ): void {
    setImmediate(() => {
      const extra: Record<string, unknown> = {};
      const base = Math.max(payload.limit, payload.used);
      const grow = (ceiling: number) => Math.min(Math.ceil(base * 1.5), ceiling);
      let newLimit = base;
      switch (payload.kind) {
        case 'iterations':
          newLimit = grow(50_000);
          extra.maxIterations = newLimit;
          break;
        case 'tool_calls':
          newLimit = grow(100_000);
          extra.maxToolCalls = newLimit;
          break;
        case 'tokens':
          newLimit = grow(5_000_000);
          extra.maxTokens = newLimit;
          break;
        case 'cost':
          newLimit = Math.min(base * 1.5, 100);
          extra.maxCostUsd = newLimit;
          break;
      }
      this.extendCounts.set(guardKey, prior + 1);
      this.recordExtension(subagentId, taskId, payload.kind, newLimit);
      payload.extend(extra);
    });
  }

  private requestCostDecision(
    subagentId: string,
    taskId: string | undefined,
    payload: BudgetThresholdPayload,
    prior: number,
    grant: () => void,
  ): void {
    void this.deps.brain
      ?.decide({
        id: `director-budget-${subagentId}-${payload.kind}`,
        sessionId: this.deps.currentSessionId(),
        source: 'director',
        question: `Should the director extend the ${payload.kind} budget for subagent ${subagentId}?`,
        context: [
          taskId ? `Task id: ${taskId}` : undefined,
          `Used: ${payload.used}`,
          `Limit: ${payload.limit}`,
          `Prior extensions for this kind: ${prior}`,
        ]
          .filter(Boolean)
          .join('\n'),
        // 'medium', not 'high': a cost extension is BOUNDED and REVERSIBLE.
        // `grantBoundedExtension` grows the limit by ×1.5 against hard
        // ceilings ($100 / 5M tokens / 50k iterations), and a wrong grant
        // costs money that the ceiling caps — it destroys nothing. This
        // question also fires per subagent per budget kind, so it is by far
        // the most FREQUENT Brain call in a fleet run.
        //
        // Declaring it 'high' put it above the council floor, which meant the
        // multi-LLM panel convened for routine budget pressure while the
        // genuinely irreversible questions (see phase-orchestrator's conflict
        // resolution, now 'critical') got the same treatment. Keeping the
        // risk vocabulary honest is what lets the council floor and the
        // autonomy ceiling separate those two classes at all.
        risk: 'medium',
        fallback: 'continue',
        options: [
          {
            id: 'extend',
            label: 'Grant the director default budget extension',
            consequence: 'The subagent continues with a larger cost budget.',
            risk: 'medium',
            recommended: true,
          },
          {
            id: 'stop',
            label: 'Stop this subagent at the current budget limit',
            consequence: 'The current task will fail or stop due to budget pressure.',
            risk: 'low',
          },
        ],
      })
      .then((decision) => {
        if (
          decision.type === 'deny' ||
          decision.type === 'ask_human' ||
          decision.optionId === 'stop'
        ) {
          payload.deny();
          return;
        }
        grant();
      })
      .catch(() => payload.deny());
  }

  private recordExtension(
    subagentId: string,
    taskId: string | undefined,
    kind: string,
    newLimit: number,
  ): void {
    const total = (this.extendTotals.get(subagentId) ?? 0) + 1;
    this.extendTotals.set(subagentId, total);
    const sessionId = this.deps.currentSessionId?.();
    this.deps.fleet.emit({
      subagentId,
      taskId,
      ts: Date.now(),
      type: 'budget.extended',
      payload: {
        ...(sessionId ? { sessionId } : {}),
        kind,
        newLimit,
        totalExtensions: total,
      },
    });
  }

  private isCollabAgent(subagentId: string): boolean {
    return (
      subagentId.startsWith('bug-hunter-') ||
      subagentId.startsWith('refactor-planner-') ||
      subagentId.startsWith('critic-')
    );
  }
}
