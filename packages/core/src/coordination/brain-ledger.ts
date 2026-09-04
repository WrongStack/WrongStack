/**
 * BrainDecisionLedger — the Brain's persistent memory + learning loop.
 *
 * Every Brain decision already flows over the EventBus (`brain.decision_*`,
 * `brain.intervention` — emitted by `ObservableBrainArbiter` and
 * `BrainMonitor`). The ledger subscribes to those events, appends each
 * decision to a JSONL file, and — the part that makes it a LEARNING loop —
 * correlates decisions with their real-world outcomes using events the host
 * already emits, with ZERO changes to the deciders:
 *
 *   - budget extensions — `subagent.budget_extended` carries subagentId +
 *     kind, which deterministically reconstructs the director's decision id
 *     (`director-budget-<subagentId>-<kind>`). When that subagent's task
 *     later lands (`subagent.task_completed`), the extension decision gets a
 *     success/failure outcome: "we granted more budget — did it help?"
 *   - steers — a `brain.intervention` of the same kind re-triggering within
 *     the retry window means the previous steer did NOT fix the problem →
 *     failure outcome for the earlier intervention.
 *
 * Outcomes are appended as their own JSONL rows, re-emitted as
 * `brain.outcome` events for the UI surfaces, and folded into
 * `digestFor(request)` — a short text block the LLM/council tiers inject
 * into their decision prompts so the Brain sees how its past similar calls
 * actually turned out ("the last 3 extends all failed — stop extending").
 *
 * The file survives sessions: `start()` seeds the in-memory ring from the
 * JSONL tail, so learning carries across runs of the same project.
 *
 * @module brain-ledger
 */

import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { EventBus } from '../kernel/events.js';
import { SECRET_FILE_MODE } from '../security/file-permissions.js';
import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from './brain.js';
import { emitBrainTierTransition, markDecisionTier } from './brain-telemetry.js';

export interface BrainLedgerEntry {
  at: number;
  sessionId?: string | undefined;
  /** `BrainDecisionRequest.id` this row belongs to. */
  requestId: string;
  kind: 'answered' | 'denied' | 'ask_human' | 'intervention' | 'outcome';
  source?: string | undefined;
  risk?: string | undefined;
  question?: string | undefined;
  optionId?: string | undefined;
  /** Rationale / deny reason / outcome detail (truncated). */
  detail?: string | undefined;
  outcome?: 'success' | 'failure' | undefined;
}

export interface BrainDecisionLedgerOptions {
  events: EventBus;
  /** JSONL file the ledger appends to (e.g. `<projectDir>/brain-ledger.jsonl`). */
  filePath: string;
  /** In-memory ring size (also the seed size read from disk). Default 500. */
  maxMemoryEntries?: number | undefined;
  /**
   * A same-kind BrainMonitor intervention re-triggering within this window
   * marks the PREVIOUS steer as a failure. Default 10 minutes.
   */
  interventionRetryWindowMs?: number | undefined;
  /** Override the clock for deterministic tests. */
  now?: (() => number) | undefined;
}

const QUESTION_MAX = 200;
const DETAIL_MAX = 240;

const truncate = (s: string | undefined, max: number): string | undefined =>
  s === undefined ? undefined : s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * Group similar decisions: identical questions about different subjects
 * (subagent ids, task ids, counts) should share one history. Tokens that
 * contain a digit are id/number-shaped — collapse them to `#`.
 */
export function brainDecisionKey(source: string | undefined, question: string): string {
  const normalized = question
    .toLowerCase()
    .replace(/[^\s]*\d[^\s]*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${source ?? '?'}:${normalized}`;
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export interface LedgerGuardBrainArbiterOptions {
  inner: BrainArbiter;
  /** Typically `BrainDecisionLedger.failureStreakFor`. */
  failureStreakFor: (request: Pick<BrainDecisionRequest, 'source' | 'question' | 'id'>) => number;
  /**
   * Deny deterministically once this many consecutive failure outcomes are
   * on record for the request's decision group. Default 3. 0 disables.
   */
  denyAfter?: number | undefined;
  /**
   * Bus for the `brain.tier_transition` step recorded when the guard denies.
   * A guard denial is terminal and costs nothing, so without this step the
   * hardest stop in the whole ladder is also its most invisible one.
   */
  events?: EventBus | undefined;
}

/**
 * Deterministic guard derived from the ledger's outcome history: when the
 * last `denyAfter` approvals of a decision group ALL ended in observed
 * failures, the request is denied outright — no LLM call, no council, no
 * escalation. Deny is safe by contract at every Brain call site ("do not
 * take the proposed action"), so this converts repeated observed waste
 * (budget extensions that never help, steers that never stick) into a hard
 * policy rule. A later observed success resets the streak and lifts the
 * guard automatically.
 *
 * Position OUTSIDE the tiered arbiter (between it and the escalation
 * router): a guard denial must be terminal, not a fall-through to the
 * escalation tier where a `recommended: true` option could resurrect the
 * very action the history condemned.
 */
export function createLedgerGuardBrainArbiter(opts: LedgerGuardBrainArbiterOptions): BrainArbiter {
  const denyAfter = opts.denyAfter ?? 3;
  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const startedAt = Date.now();
      if (denyAfter > 0) {
        const streak = opts.failureStreakFor(request);
        if (streak >= denyAfter) {
          markDecisionTier(request, 'ledger-guard');
          emitBrainTierTransition(
            opts.events,
            request,
            'ledger-guard',
            'deny',
            true,
            startedAt,
            `${streak} consecutive observed failures on record`,
          );
          return {
            type: 'deny',
            reason:
              `Ledger guard: the last ${streak} approved decisions of this kind all ` +
              `ended in observed failures — denying deterministically until a success ` +
              `is recorded. (${request.question.slice(0, 120)})`,
          };
        }
      }
      return opts.inner.decide(request);
    },
  };
}

export class BrainDecisionLedger {
  private readonly entries: BrainLedgerEntry[] = [];
  private readonly outcomeByRequest = new Map<string, 'success' | 'failure'>();
  /** subagentId → decision request ids awaiting that subagent's task result. */
  private readonly pendingBudgetOutcomes = new Map<string, Set<string>>();
  private readonly lastInterventionByKind = new Map<string, { requestId: string; at: number }>();
  private readonly unsubscribers: Array<() => void> = [];
  /** Serialized fire-and-forget writes — awaited by `stop()` (drain). */
  private writeChain: Promise<unknown> = Promise.resolve();
  private pendingWriteCount = 0;
  private pendingWriteBytes = 0;
  private static readonly MAX_PENDING_WRITES = 1_000;
  private static readonly MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
  /** Rotate the JSONL to `.1` past this size so it can't grow unbounded. */
  private static readonly MAX_FILE_BYTES = 5 * 1024 * 1024;
  /** Stat the file for rotation only once per this many writes. */
  private static readonly ROTATE_CHECK_EVERY = 100;
  private writesSinceRotateCheck = 0;
  private dirReady = false;

  private readonly maxMemoryEntries: number;
  private readonly retryWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: BrainDecisionLedgerOptions) {
    this.maxMemoryEntries = opts.maxMemoryEntries ?? 500;
    this.retryWindowMs = opts.interventionRetryWindowMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Subscribe to the EventBus and seed the in-memory ring from the JSONL
   * tail. The returned promise resolves once the seed load finished
   * (best-effort — a missing/corrupt file is an empty history, not an error).
   */
  async start(): Promise<void> {
    const { events } = this.opts;
    this.unsubscribers.push(
      events.on('brain.decision_answered', (e) => {
        this.record({
          at: e.at,
          sessionId: e.sessionId,
          requestId: e.request.id,
          kind: 'answered',
          source: e.request.source,
          risk: e.request.risk,
          question: truncate(e.request.question, QUESTION_MAX),
          optionId: e.decision.type === 'answer' ? e.decision.optionId : undefined,
          detail:
            e.decision.type === 'answer'
              ? truncate(e.decision.rationale ?? e.decision.text, DETAIL_MAX)
              : undefined,
        });
      }),
      events.on('brain.decision_denied', (e) => {
        this.record({
          at: e.at,
          sessionId: e.sessionId,
          requestId: e.request.id,
          kind: 'denied',
          source: e.request.source,
          risk: e.request.risk,
          question: truncate(e.request.question, QUESTION_MAX),
          detail: e.decision.type === 'deny' ? truncate(e.decision.reason, DETAIL_MAX) : undefined,
        });
      }),
      events.on('brain.decision_ask_human', (e) => {
        this.record({
          at: e.at,
          sessionId: e.sessionId,
          requestId: e.request.id,
          kind: 'ask_human',
          source: e.request.source,
          risk: e.request.risk,
          question: truncate(e.request.question, QUESTION_MAX),
        });
      }),
      events.on('brain.intervention', (e) => {
        this.record({
          at: e.at,
          sessionId: e.sessionId,
          requestId: e.request.id,
          kind: 'intervention',
          source: e.request.source,
          risk: e.request.risk,
          question: truncate(`[${e.kind}] ${e.request.question}`, QUESTION_MAX),
          detail: e.intervened ? 'steered' : 'observed only',
        });
        if (!e.intervened) return;
        // A same-kind re-engagement inside the retry window means the
        // previous steer did not fix the underlying problem.
        const prev = this.lastInterventionByKind.get(e.kind);
        if (prev && e.at - prev.at <= this.retryWindowMs) {
          this.recordOutcome(
            prev.requestId,
            'failure',
            `same signal (${e.kind}) re-triggered ${fmtAge(e.at - prev.at).replace(' ago', ' later')}`,
            e.sessionId,
          );
        }
        this.lastInterventionByKind.set(e.kind, { requestId: e.request.id, at: e.at });
      }),
      // ── Outcome correlation: budget extensions ────────────────────────
      events.on('subagent.budget_extended', (e) => {
        // The director's decision id is deterministic — reconstruct it.
        const requestId = `director-budget-${e.subagentId}-${e.kind}`;
        if (!this.entries.some((entry) => entry.requestId === requestId)) return;
        let set = this.pendingBudgetOutcomes.get(e.subagentId);
        if (!set) {
          set = new Set();
          this.pendingBudgetOutcomes.set(e.subagentId, set);
        }
        set.add(requestId);
      }),
      events.on('subagent.task_completed', (e) => {
        const pending = this.pendingBudgetOutcomes.get(e.subagentId);
        if (!pending) return;
        this.pendingBudgetOutcomes.delete(e.subagentId);
        const outcome = e.status === 'success' ? 'success' : 'failure';
        for (const requestId of pending) {
          this.recordOutcome(
            requestId,
            outcome,
            `budget-extended subagent's task ${e.status}`,
            e.sessionId,
          );
        }
      }),
    );
    await this.load();
  }

  /** Unsubscribe and drain pending writes. Safe to call twice. */
  async stop(): Promise<void> {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    await this.writeChain.catch(() => {});
  }

  /**
   * Attach a real-world outcome to an earlier decision. Appended to the
   * JSONL, folded into future digests, and re-emitted as `brain.outcome`.
   */
  recordOutcome(
    requestId: string,
    outcome: 'success' | 'failure',
    detail?: string,
    sessionId?: string,
  ): void {
    this.outcomeByRequest.set(requestId, outcome);
    this.record({
      at: this.now(),
      sessionId,
      requestId,
      kind: 'outcome',
      outcome,
      detail: truncate(detail, DETAIL_MAX),
    });
    this.opts.events.emit('brain.outcome', {
      sessionId,
      requestId,
      outcome,
      detail,
      at: this.now(),
    });
  }

  /** Last `n` ledger rows, oldest first. */
  tail(n: number): BrainLedgerEntry[] {
    return this.entries.slice(-n);
  }

  /**
   * Consecutive most-recent FAILURE outcomes among answered decisions of
   * this request's group. Decisions whose outcome is still unknown are
   * skipped (they neither extend nor break the streak); the first known
   * SUCCESS ends it. Powers the deterministic ledger guard: "the last K
   * times we approved this, it went wrong — stop approving".
   */
  failureStreakFor(request: Pick<BrainDecisionRequest, 'source' | 'question' | 'id'>): number {
    const key = brainDecisionKey(request.source, request.question);
    let streak = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (
        e?.kind !== 'answered' ||
        e.requestId === request.id ||
        e.question === undefined ||
        brainDecisionKey(e.source, e.question) !== key
      ) {
        continue;
      }
      const outcome = this.outcomeByRequest.get(e.requestId);
      if (outcome === undefined) continue;
      if (outcome === 'success') break;
      streak += 1;
    }
    return streak;
  }

  /**
   * Short decision-history block for the LLM/council prompt: how similar
   * past decisions went and — when known — how they turned OUT. Returns
   * undefined when there is no relevant history (no prompt noise).
   */
  digestFor(request: Pick<BrainDecisionRequest, 'source' | 'question' | 'id'>): string | undefined {
    const key = brainDecisionKey(request.source, request.question);
    const related = this.entries.filter(
      (e) =>
        (e.kind === 'answered' || e.kind === 'denied') &&
        e.requestId !== request.id &&
        e.question !== undefined &&
        brainDecisionKey(e.source, e.question) === key,
    );
    if (related.length === 0) return undefined;

    const recent = related.slice(-5).reverse();
    const now = this.now();
    const lines = recent.map((e) => {
      const what =
        e.kind === 'denied' ? 'denied' : e.optionId ? `chose [${e.optionId}]` : 'answered';
      const outcome = this.outcomeByRequest.get(e.requestId);
      const suffix =
        outcome === 'failure'
          ? ' → later FAILED'
          : outcome === 'success'
            ? ' → later succeeded'
            : '';
      return `- ${fmtAge(now - e.at)}: ${what}${suffix}`;
    });
    const approved = related.filter((e) => e.kind === 'answered');
    const failedAfter = approved.filter(
      (e) => this.outcomeByRequest.get(e.requestId) === 'failure',
    ).length;
    const summary =
      `Summary: ${related.length} similar decision(s); ` +
      `${approved.length} answered${failedAfter > 0 ? ` (${failedAfter} later failed)` : ''}, ` +
      `${related.length - approved.length} denied.`;
    return [...lines, summary].join('\n');
  }

  // ── Private ───────────────────────────────────────────────────────────

  private record(entry: BrainLedgerEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxMemoryEntries) {
      // Collect requestIds from the evicted entries so we can prune
      // outcomeByRequest entries whose decision has been forgotten.
      const evictedRequestIds = new Set<string>();
      const evictCount = this.entries.length - this.maxMemoryEntries;
      const evicted = this.entries.splice(0, evictCount);
      for (const e of evicted) {
        if (e.requestId) evictedRequestIds.add(e.requestId);
      }
      if (evictedRequestIds.size > 0) {
        // Build a set of requestIds that still have entries in the ring.
        // Only outcomes for those are still queryable via digestFor().
        const remainingRequestIds = new Set<string>();
        for (const e of this.entries) {
          if (e.requestId) remainingRequestIds.add(e.requestId);
        }
        for (const id of evictedRequestIds) {
          if (!remainingRequestIds.has(id)) this.outcomeByRequest.delete(id);
        }
      }
    }
    this.append(entry);
  }

  private append(entry: BrainLedgerEntry): void {
    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch {
      return;
    }
    const bytes = Buffer.byteLength(line, 'utf8');
    if (
      this.pendingWriteCount >= BrainDecisionLedger.MAX_PENDING_WRITES ||
      bytes > BrainDecisionLedger.MAX_PENDING_WRITE_BYTES ||
      this.pendingWriteBytes + bytes > BrainDecisionLedger.MAX_PENDING_WRITE_BYTES
    ) {
      return;
    }
    this.pendingWriteCount += 1;
    this.pendingWriteBytes += bytes;
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.dirReady) {
          await mkdir(dirname(this.opts.filePath), { recursive: true });
          this.dirReady = true;
        }
        await this.maybeRotate();
        await appendFile(this.opts.filePath, line, { encoding: 'utf8', mode: SECRET_FILE_MODE });
      })
      .catch(() => {
        // Ledger persistence is best-effort — never destabilize the host.
      })
      .finally(() => {
        this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
        this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - bytes);
      });
  }

  /**
   * Size-bounded rotation: past {@link MAX_FILE_BYTES} the file moves to a
   * single `.1` sibling (previous `.1` is overwritten), bounding disk to
   * ~2× the cap. Checked once per {@link ROTATE_CHECK_EVERY} writes; runs on
   * the write chain, so it never races an append. The ring `load()` reads
   * only the tail, so rotation never costs queryable history.
   */
  private async maybeRotate(): Promise<void> {
    this.writesSinceRotateCheck += 1;
    if (this.writesSinceRotateCheck < BrainDecisionLedger.ROTATE_CHECK_EVERY) return;
    this.writesSinceRotateCheck = 0;
    try {
      const info = await stat(this.opts.filePath);
      if (info.size < BrainDecisionLedger.MAX_FILE_BYTES) return;
      await rename(this.opts.filePath, `${this.opts.filePath}.1`);
    } catch {
      // Missing file or a locked rename — rotation retries on a later check.
    }
  }

  /** Seed the in-memory ring from the JSONL tail (cross-session learning). */
  private async load(): Promise<void> {
    try {
      await access(this.opts.filePath);
    } catch {
      return; // No ledger yet.
    }
    const seed: BrainLedgerEntry[] = [];
    const input = createReadStream(this.opts.filePath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as BrainLedgerEntry;
          if (typeof parsed?.requestId === 'string' && typeof parsed.at === 'number') {
            seed.push(parsed);
            if (seed.length > this.maxMemoryEntries) seed.shift();
          }
        } catch {
          // Skip corrupt rows — a partial tail is still useful history.
        }
      }
    } catch {
      return;
    } finally {
      lines.close();
      input.destroy();
    }
    // Entries recorded while the file was loading stay AFTER the seed.
    this.entries.unshift(...seed);
    if (this.entries.length > this.maxMemoryEntries) {
      this.entries.splice(0, this.entries.length - this.maxMemoryEntries);
    }
    for (const e of this.entries) {
      if (e.kind === 'outcome' && e.outcome) this.outcomeByRequest.set(e.requestId, e.outcome);
    }
  }
}
