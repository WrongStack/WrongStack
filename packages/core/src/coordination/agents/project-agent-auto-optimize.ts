/**
 * Automatic learning optimization.
 *
 * Capture is automatic, but distillation used to be a button someone had to
 * press — so a role kept accumulating raw directives and its skills never grew
 * unless a human remembered to run `/agent-improve <role> optimize`. This
 * scheduler closes that gap: it watches captures, decides when a role has
 * earned a pass, and runs `optimizeProjectAgentLearning` in the background.
 *
 * Design constraints, in priority order:
 *
 * 1. **Never block user-facing work.** Every pass is detached and debounced;
 *    a capture returns immediately.
 * 2. **Never stampede.** One pass at a time process-wide, one pending pass per
 *    role, and a per-role cooldown so a chatty fleet cannot spend the budget
 *    on back-to-back optimizations of the same buffer.
 * 3. **Never crash the host.** Failures are swallowed into an exponential
 *    backoff; a dead provider degrades to "no optimization" and not to a hot
 *    retry loop or a rejected promise nobody awaits.
 * 4. **Do something useful without a model.** With no LLM available the pass
 *    still writes the deterministic per-skill addenda, so tagged learning
 *    reaches the skill layer on a headless box.
 */

import { loadConsolidationMetadata, readRawLearnedEntries } from './project-agent-consolidation.js';
import { LEARNED_SOFT_LIMIT } from './project-agent-learning-normalize.js';
import { loadProjectAgentLearningPolicy } from './project-agent-learning-policy.js';
import {
  type LearningOptimizerLlm,
  type OptimizeLearningResult,
  optimizeProjectAgentLearning,
} from './project-agent-optimizer.js';
import { assertProjectAgentRole } from './project-agent-paths.js';
import { listProjectSkillAugmentations } from './project-agent-skill-layer.js';

export interface AutoOptimizePolicy {
  /** Master switch. Default true. */
  enabled: boolean;
  /** Raw buffer size that makes a role eligible. Default = the soft limit. */
  thresholdBytes: number;
  /** Never optimize a nearly-empty buffer, whatever its byte size. */
  minEntries: number;
  /**
   * Directives already routed to a skill that has no addendum yet. Reaching
   * this count makes a role eligible even below `thresholdBytes` — getting
   * learning into the skill layer promptly is the point of the loop, and
   * waiting for the buffer to fatten delays it for no reason.
   */
  minPendingSkillDirectives: number;
  /** Minimum gap between two automatic passes for one role. */
  minIntervalMs: number;
  /** Quiet period after the last capture before a pass may start. */
  debounceMs: number;
}

export const DEFAULT_AUTO_OPTIMIZE_POLICY: AutoOptimizePolicy = {
  enabled: true,
  thresholdBytes: LEARNED_SOFT_LIMIT,
  minEntries: 4,
  minPendingSkillDirectives: 3,
  minIntervalMs: 6 * 60 * 60_000,
  debounceMs: 20_000,
};

/** Shape accepted from config, where every field is independently optional. */
export type AutoOptimizePolicyOverrides = {
  [K in keyof AutoOptimizePolicy]?: AutoOptimizePolicy[K] | undefined;
} & { sweepOnStart?: boolean | undefined };

export function resolveAutoOptimizePolicy(
  overrides?: AutoOptimizePolicyOverrides | undefined,
): AutoOptimizePolicy {
  const base = DEFAULT_AUTO_OPTIMIZE_POLICY;
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    enabled: overrides?.enabled !== false,
    thresholdBytes: positive(overrides?.thresholdBytes, base.thresholdBytes),
    minEntries: positive(overrides?.minEntries, base.minEntries),
    minPendingSkillDirectives: positive(
      overrides?.minPendingSkillDirectives,
      base.minPendingSkillDirectives,
    ),
    minIntervalMs: positive(overrides?.minIntervalMs, base.minIntervalMs),
    debounceMs: positive(overrides?.debounceMs, base.debounceMs),
  };
}

export type AutoOptimizeSkipReason =
  | 'disabled'
  | 'learning-paused'
  | 'too-few-entries'
  | 'below-threshold'
  | 'cooling-down';

export type AutoOptimizeDecision =
  | { eligible: true; reason: 'size' | 'pending-skills' }
  | { eligible: false; reason: AutoOptimizeSkipReason };

/**
 * Pure eligibility check — no timers, no I/O beyond reading the role's files.
 * Exported so the decision can be tested and surfaced in a status view
 * without running a pass.
 */
export function evaluateAutoOptimize(
  role: string,
  projectRoot: string | undefined,
  policy: AutoOptimizePolicy,
  now: number = Date.now(),
): AutoOptimizeDecision {
  if (!policy.enabled) return { eligible: false, reason: 'disabled' };
  const normalizedRole = assertProjectAgentRole(role);
  const learningPolicy = loadProjectAgentLearningPolicy(normalizedRole, projectRoot);
  if (!learningPolicy.enabled) {
    return { eligible: false, reason: 'learning-paused' };
  }

  const entries = readRawLearnedEntries(normalizedRole, projectRoot);
  if (entries.length < policy.minEntries) return { eligible: false, reason: 'too-few-entries' };

  // The cooldown is against the last *pass*, not the last consolidation. A pass
  // that ran without a model rewrites every skill addendum and writes no
  // consolidation metadata, so reading metadata alone let a model-less setup
  // re-run a full pass after every single capture.
  const meta = loadConsolidationMetadata(normalizedRole, projectRoot);
  const lastPassAt = [meta?.consolidatedAt, learningPolicy.lastOptimizeAt]
    .map((stamp) => (stamp ? Date.parse(stamp) : Number.NaN))
    // A malformed timestamp parses to NaN; treat it as "no usable cooldown"
    // rather than blocking the role forever.
    .filter((value) => Number.isFinite(value));
  if (lastPassAt.length > 0 && now - Math.max(...lastPassAt) < policy.minIntervalMs) {
    return { eligible: false, reason: 'cooling-down' };
  }

  const bytes = entries.reduce(
    (sum, entry) => sum + Buffer.byteLength(`${entry.what}${entry.why}${entry.how}`, 'utf8'),
    0,
  );
  if (bytes >= policy.thresholdBytes) return { eligible: true, reason: 'size' };

  const developed = new Set(listProjectSkillAugmentations(normalizedRole, projectRoot));
  const pending = entries.filter((entry) => entry.skill && !developed.has(entry.skill)).length;
  if (pending >= policy.minPendingSkillDirectives) {
    return { eligible: true, reason: 'pending-skills' };
  }
  return { eligible: false, reason: 'below-threshold' };
}

export interface AutoOptimizeEvent {
  role: string;
  trigger: 'size' | 'pending-skills' | 'manual-sweep';
  result?: OptimizeLearningResult | undefined;
  error?: string | undefined;
}

export interface LearningOptimizationSchedulerOptions {
  projectRoot: string;
  getPolicy: () => AutoOptimizePolicy;
  /** Resolved lazily so a pass never holds a provider open between runs. */
  getLlm: () => Promise<LearningOptimizerLlm | undefined> | LearningOptimizerLlm | undefined;
  onEvent?: ((event: AutoOptimizeEvent) => void) | undefined;
  /** Injectable clock/timer for deterministic tests. */
  now?: (() => number) | undefined;
  scheduleTimer?: ((fn: () => void, ms: number) => NodeJS.Timeout) | undefined;
  cancelTimer?: ((handle: NodeJS.Timeout) => void) | undefined;
}

/** Backoff after a failed pass, doubling to a ceiling. */
const FAILURE_BACKOFF_START_MS = 5 * 60_000;
const FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60_000;

export class LearningOptimizationScheduler {
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly failures = new Map<string, { until: number; backoffMs: number }>();
  private running: Promise<void> = Promise.resolve();
  private inFlight: string | null = null;
  private disposed = false;

  constructor(private readonly opts: LearningOptimizationSchedulerOptions) {}

  private get now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private schedule(fn: () => void, ms: number): NodeJS.Timeout {
    if (this.opts.scheduleTimer) return this.opts.scheduleTimer(fn, ms);
    const handle = setTimeout(fn, ms);
    // A pending optimization must never hold the process open on exit.
    handle.unref?.();
    return handle;
  }

  /**
   * Called after a capture persisted new directives. Debounced per role: a
   * burst of captures collapses into one pass.
   */
  notifyCaptured(role: string): void {
    if (this.disposed) return;
    const policy = this.opts.getPolicy();
    if (!policy.enabled) return;
    let normalizedRole: string;
    try {
      normalizedRole = assertProjectAgentRole(role);
    } catch {
      return;
    }
    const existing = this.pending.get(normalizedRole);
    if (existing) (this.opts.cancelTimer ?? clearTimeout)(existing);
    this.pending.set(
      normalizedRole,
      this.schedule(() => {
        this.pending.delete(normalizedRole);
        void this.runIfEligible(normalizedRole);
      }, policy.debounceMs),
    );
  }

  /**
   * Evaluate every role that has learning data and queue the eligible ones.
   * Run once at host start so roles that crossed the threshold before the
   * scheduler existed are not stuck waiting for their next capture.
   */
  sweep(roles: readonly string[]): void {
    if (this.disposed) return;
    for (const role of roles) void this.runIfEligible(role, 'manual-sweep');
  }

  private async runIfEligible(role: string, trigger?: 'manual-sweep'): Promise<void> {
    if (this.disposed) return;
    const backoff = this.failures.get(role);
    if (backoff && this.now < backoff.until) return;
    let decision: AutoOptimizeDecision;
    try {
      decision = evaluateAutoOptimize(role, this.opts.projectRoot, this.opts.getPolicy(), this.now);
    } catch {
      return;
    }
    if (!decision.eligible) return;
    await this.enqueue(role, trigger ?? decision.reason);
  }

  /** Serialize passes: one optimization at a time, process-wide. */
  private enqueue(role: string, trigger: AutoOptimizeEvent['trigger']): Promise<void> {
    const next = this.running.then(() => this.execute(role, trigger));
    // Keep the chain alive even if a link rejects — `execute` never throws, but
    // a future caller adding one must not wedge the queue.
    this.running = next.catch(() => {});
    return this.running;
  }

  private async execute(role: string, trigger: AutoOptimizeEvent['trigger']): Promise<void> {
    if (this.disposed) return;
    this.inFlight = role;
    try {
      const llm = await this.opts.getLlm();
      const result = await optimizeProjectAgentLearning(role, this.opts.projectRoot, {
        ...(llm ? { llm } : {}),
        trigger: 'automatic',
      });
      if (result.status === 'failed') {
        this.recordFailure(role);
        this.opts.onEvent?.({ role, trigger, result, error: result.error });
        return;
      }
      this.failures.delete(role);
      this.opts.onEvent?.({ role, trigger, result });
    } catch (error) {
      this.recordFailure(role);
      this.opts.onEvent?.({
        role,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = null;
    }
  }

  private recordFailure(role: string): void {
    const previous = this.failures.get(role);
    const backoffMs = Math.min(
      previous ? previous.backoffMs * 2 : FAILURE_BACKOFF_START_MS,
      FAILURE_BACKOFF_MAX_MS,
    );
    this.failures.set(role, { until: this.now + backoffMs, backoffMs });
  }

  /** Role currently being optimized, for status surfaces. */
  activeRole(): string | null {
    return this.inFlight;
  }

  /** Cancel pending debounces. Safe to call more than once. */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.pending.values()) {
      (this.opts.cancelTimer ?? clearTimeout)(handle);
    }
    this.pending.clear();
  }

  /** Await the queue — tests only; production never blocks on a pass. */
  async idle(): Promise<void> {
    await this.running;
  }
}
