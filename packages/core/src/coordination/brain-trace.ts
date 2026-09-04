/**
 * BrainTraceRecorder — the replayable record of HOW a Brain decision was made.
 *
 * `BrainDecisionLedger` answers "what did the Brain decide, and did it work
 * out" — it is a learning loop with a bounded ring and outcome correlation.
 * This module answers a different question: "what actually happened inside
 * the ladder", at a granularity that lets a decision be reconstructed and
 * replayed offline through `runBrainEvaluation`.
 *
 * The two are deliberately SEPARATE files. Trace rows are per-call and
 * high-volume; folding them into the ledger's ring would evict the decision
 * history that `digestFor()` / `failureStreakFor()` scan, quietly breaking
 * the learning loop.
 *
 * Recorded per decision:
 *   - `brain.tier_transition` — every tier the ladder ran, what it returned,
 *     and why the chain did or did not stop there.
 *   - `brain.llm_call` — every pool target attempted, including the failures
 *     the fallback loop swallows, with model, timing and usage.
 *   - `brain.council_vote` / `brain.council_resolved` — each seat's observable
 *     vote plus the deterministic quorum/veto/majority resolution.
 *   - the request and final decision, which together form the replay fixture.
 *
 * ## Content policy
 * Trace is DISABLED by default. Enabling it is the opt-in; `content: 'full'`
 * is then the default because a fixture without the question and context
 * cannot be replayed. `content: 'redacted'` keeps the shape and metadata but
 * scrubs credentials out of free text and truncates it, and `'none'` records
 * metadata only. See
 * `docs/competitive-roadmap-2026-2027/21-brain-evaluation-and-replay.md`.
 *
 * @module brain-trace
 */

import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { EventBus } from '../kernel/events.js';
import { scrubErrorText } from '../security/error-sanitize.js';
import { SECRET_FILE_MODE } from '../security/file-permissions.js';
import type { BrainDecision, BrainDecisionRequest } from './brain.js';
import type { BrainDecisionTier } from './brain-telemetry.js';

/** How much free text a trace may record. */
export type BrainTraceContentMode = 'none' | 'redacted' | 'full';

/** Characters of free text kept per field in `redacted` mode. */
export const BRAIN_TRACE_REDACTED_MAX = 120;

export interface BrainTraceLlmCall {
  tier: 'llm' | 'council' | 'judge';
  providerId?: string | undefined;
  model: string;
  label?: string | undefined;
  attempt: number;
  ok: boolean;
  durationMs: number;
  error?: string | undefined;
  /** Model was cut off at its output budget (see the event docs). */
  truncated?: boolean | undefined;
  responseText?: string | undefined;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
  at: number;
}

export interface BrainTraceCouncilVote {
  seatId: string;
  persona: string;
  status: 'valid' | 'invalid' | 'failed' | 'cancelled';
  /** 1-based deliberation round; 1 is the independent round. */
  round?: number | undefined;
  /** This ballot differs from the same seat's previous round. */
  changed?: boolean | undefined;
  providerId?: string | undefined;
  model?: string | undefined;
  optionId?: string | undefined;
  stance?: string | undefined;
  rationale?: string | undefined;
  weight?: number | undefined;
  veto?: boolean | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  at: number;
}

export interface BrainTraceCouncilResolution {
  status: string;
  resolution: string;
  optionId?: string | undefined;
  configuredSeatCount: number;
  validVoteCount: number;
  distinctTargetCount: number;
  judgeUsed: boolean;
  /** Deliberation rounds run, and how many seats moved in the final one. */
  rounds?: number | undefined;
  deliberationChanges?: number | undefined;
  /** Which model broke the tie, and whether it had already voted. */
  judgeLabel?: string | undefined;
  judgeIsVoter?: boolean | undefined;
  usage?:
    | {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        durationMs: number;
      }
    | undefined;
  /** Panel-integrity warnings (distinctness). Structural — never content-gated. */
  warnings?: string[] | undefined;
  reason?: string | undefined;
  at: number;
}

export interface BrainTraceTierStep {
  tier: BrainDecisionTier;
  outcome: 'answer' | 'deny' | 'ask_human' | 'error' | 'skipped';
  terminal: boolean;
  reason?: string | undefined;
  durationMs?: number | undefined;
  at: number;
}

export const BRAIN_TRACE_VERSION = 1 as const;

/** One complete decision, start to finish. Appended as a single JSONL row. */
export interface BrainTraceRecord {
  version: typeof BRAIN_TRACE_VERSION;
  requestId: string;
  sessionId?: string | undefined;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  /** The request as issued. Free-text fields follow the content mode. */
  request: BrainDecisionRequest;
  /** The decision the caller received. */
  decision?: BrainDecision | undefined;
  /** Tier that produced `decision`, when provenance was recorded. */
  tier?: BrainDecisionTier | undefined;
  steps: BrainTraceTierStep[];
  llmCalls: BrainTraceLlmCall[];
  councilVotes: BrainTraceCouncilVote[];
  councilResolution?: BrainTraceCouncilResolution | undefined;
  /** Totals across every provider call this decision made. */
  totals: {
    llmCalls: number;
    failedLlmCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface BrainTraceRecorderOptions {
  events: EventBus;
  /** JSONL file trace records are appended to. */
  filePath: string;
  /** Free-text policy. Default 'full' — see the module docs. */
  content?: BrainTraceContentMode | undefined;
  /**
   * Cap on concurrently open (undecided) decisions. A decision whose
   * `brain.decision_*` event never arrives would otherwise leak its partial
   * record forever. Oldest entries are dropped past this. Default 200.
   */
  maxOpenRecords?: number | undefined;
}

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Apply the content policy to one free-text field. */
export function applyContentMode(
  value: string | undefined,
  mode: BrainTraceContentMode,
): string | undefined {
  if (value === undefined) return undefined;
  if (mode === 'none') return undefined;
  // WS-063: this used to only `truncate()`. The mode is named `redacted` and
  // is documented as the middle setting between `none` and `full`, so an
  // operator enabling it reasonably expects credentials to be removed — but a
  // key pasted into a Brain question sits well inside the first 120 characters
  // and was written to the trace file verbatim. Scrub first, then truncate, so
  // the cut cannot leave a half-redacted token behind.
  if (mode === 'redacted') return truncate(scrubErrorText(value), BRAIN_TRACE_REDACTED_MAX);
  return value;
}

/**
 * Strip a request down to what the content policy allows. Structure
 * (ids, risk, fallback, option ids) is always preserved: it is what makes a
 * fixture runnable, and it carries no free-text production content.
 */
export function sanitizeRequest(
  request: BrainDecisionRequest,
  mode: BrainTraceContentMode,
): BrainDecisionRequest {
  const question = applyContentMode(request.question, mode);
  return {
    ...request,
    question: question ?? '[redacted]',
    context: applyContentMode(request.context, mode),
    options: request.options?.map((option) => ({
      ...option,
      label: applyContentMode(option.label, mode) ?? option.id,
      consequence: applyContentMode(option.consequence, mode),
    })),
  };
}

/** Strip a decision's free text under the content policy. */
export function sanitizeDecision(
  decision: BrainDecision,
  mode: BrainTraceContentMode,
): BrainDecision {
  switch (decision.type) {
    case 'answer':
      return {
        ...decision,
        text: applyContentMode(decision.text, mode) ?? '',
        rationale: applyContentMode(decision.rationale, mode),
      };
    case 'deny':
      return { ...decision, reason: applyContentMode(decision.reason, mode) ?? '' };
    case 'ask_human':
      return {
        ...decision,
        prompt: applyContentMode(decision.prompt, mode) ?? '',
        rationale: applyContentMode(decision.rationale, mode),
      };
  }
}

interface OpenRecord {
  requestId: string;
  sessionId?: string | undefined;
  startedAt: number;
  request: BrainDecisionRequest;
  steps: BrainTraceTierStep[];
  llmCalls: BrainTraceLlmCall[];
  councilVotes: BrainTraceCouncilVote[];
  councilResolution?: BrainTraceCouncilResolution | undefined;
}

/**
 * Correlates the Brain's per-call events into one record per decision and
 * appends it as JSONL when the decision resolves.
 */
export class BrainTraceRecorder {
  private readonly open = new Map<string, OpenRecord>();
  private readonly unsubscribers: Array<() => void> = [];
  private writeChain: Promise<unknown> = Promise.resolve();
  private pendingWriteCount = 0;
  private pendingWriteBytes = 0;
  private static readonly MAX_PENDING_WRITES = 1_000;
  private static readonly MAX_PENDING_WRITE_BYTES = 8 * 1024 * 1024;
  private dirReady = false;

  private readonly content: BrainTraceContentMode;
  private readonly maxOpenRecords: number;

  constructor(private readonly opts: BrainTraceRecorderOptions) {
    this.content = opts.content ?? 'full';
    this.maxOpenRecords = opts.maxOpenRecords ?? 200;
  }

  start(): void {
    const { events } = this.opts;

    this.unsubscribers.push(
      events.on('brain.decision_requested', (e) => {
        this.open.set(e.request.id, {
          requestId: e.request.id,
          sessionId: e.sessionId,
          startedAt: e.at,
          request: sanitizeRequest(e.request, this.content),
          steps: [],
          llmCalls: [],
          councilVotes: [],
        });
        this.evictOverflow();
      }),

      events.on('brain.tier_transition', (e) => {
        this.open.get(e.requestId)?.steps.push({
          tier: e.tier,
          outcome: e.outcome,
          terminal: e.terminal,
          reason: e.reason,
          durationMs: e.durationMs,
          at: e.at,
        });
      }),

      events.on('brain.llm_call', (e) => {
        this.open.get(e.requestId)?.llmCalls.push({
          tier: e.tier,
          providerId: e.providerId,
          model: e.model,
          label: e.label,
          attempt: e.attempt,
          ok: e.ok,
          durationMs: e.durationMs,
          error: e.error,
          truncated: e.truncated,
          responseText: applyContentMode(e.responseText, this.content),
          // Provider `Usage` is {input, output, cache*}; normalize to the
          // council's {input,output,total} token vocabulary so both sources
          // aggregate into one set of totals.
          usage: e.usage
            ? {
                inputTokens: e.usage.input,
                outputTokens: e.usage.output,
                totalTokens: e.usage.input + e.usage.output,
              }
            : undefined,
          at: e.at,
        });
      }),

      events.on('brain.council_vote', (e) => {
        this.open.get(e.requestId)?.councilVotes.push({
          seatId: e.seatId,
          persona: e.persona,
          status: e.status,
          round: e.round,
          changed: e.changed,
          providerId: e.providerId,
          model: e.model,
          optionId: e.optionId,
          stance: applyContentMode(e.stance, this.content),
          rationale: applyContentMode(e.rationale, this.content),
          weight: e.weight,
          veto: e.veto,
          durationMs: e.durationMs,
          error: e.error,
          at: e.at,
        });
      }),

      events.on('brain.council_resolved', (e) => {
        const record = this.open.get(e.requestId);
        if (!record) return;
        record.councilResolution = {
          status: e.status,
          resolution: e.resolution,
          optionId: e.optionId,
          configuredSeatCount: e.configuredSeatCount,
          validVoteCount: e.validVoteCount,
          distinctTargetCount: e.distinctTargetCount,
          judgeUsed: e.judgeUsed,
          rounds: e.rounds,
          deliberationChanges: e.deliberationChanges,
          judgeLabel: e.judgeLabel,
          judgeIsVoter: e.judgeIsVoter,
          usage: e.usage,
          warnings: e.warnings,
          reason: applyContentMode(e.reason, this.content),
          at: e.at,
        };
      }),
    );

    for (const name of [
      'brain.decision_answered',
      'brain.decision_denied',
      'brain.decision_ask_human',
    ] as const) {
      this.unsubscribers.push(
        events.on(name, (e) => {
          // A PENDING ask_human is the escalation prompt, not the outcome:
          // the queue is still waiting on a human and the same request will
          // resolve into answered/denied. Closing here would file the record
          // early and discard the human's actual answer along with every
          // step that follows it.
          if ('pending' in e && e.pending === true) return;
          this.close(e.request.id, e.decision, e.tier, e.at);
        }),
      );
    }
  }

  /** Unsubscribe and drain pending writes. Safe to call twice. */
  async stop(): Promise<void> {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.open.clear();
    await this.writeChain.catch(() => {});
  }

  /** Decisions still awaiting their resolution event. */
  get openCount(): number {
    return this.open.size;
  }

  private evictOverflow(): void {
    // A decision whose resolution event never arrives (a host that bypasses
    // ObservableBrainArbiter, a crash mid-ladder) would pin its partial
    // record forever; bound the map rather than leak.
    while (this.open.size > this.maxOpenRecords) {
      const oldest = this.open.keys().next();
      if (oldest.done) break;
      this.open.delete(oldest.value);
    }
  }

  private close(
    requestId: string,
    decision: BrainDecision,
    tier: BrainDecisionTier | undefined,
    at: number,
  ): void {
    const record = this.open.get(requestId);
    if (!record) return;
    this.open.delete(requestId);

    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    for (const call of record.llmCalls) {
      inputTokens += call.usage?.inputTokens ?? 0;
      outputTokens += call.usage?.outputTokens ?? 0;
      totalTokens += call.usage?.totalTokens ?? 0;
    }
    if (record.councilResolution?.usage) {
      inputTokens += record.councilResolution.usage.inputTokens;
      outputTokens += record.councilResolution.usage.outputTokens;
      totalTokens += record.councilResolution.usage.totalTokens;
    }

    const full: BrainTraceRecord = {
      version: BRAIN_TRACE_VERSION,
      requestId,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      completedAt: at,
      durationMs: Math.max(0, at - record.startedAt),
      request: record.request,
      decision: sanitizeDecision(decision, this.content),
      tier,
      steps: record.steps,
      llmCalls: record.llmCalls,
      councilVotes: record.councilVotes,
      councilResolution: record.councilResolution,
      totals: {
        llmCalls: record.llmCalls.length,
        failedLlmCalls: record.llmCalls.filter((c) => !c.ok).length,
        inputTokens,
        outputTokens,
        totalTokens,
      },
    };
    this.append(full);
  }

  private append(record: BrainTraceRecord): void {
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      return;
    }
    const bytes = Buffer.byteLength(line, 'utf8');
    if (
      this.pendingWriteCount >= BrainTraceRecorder.MAX_PENDING_WRITES ||
      bytes > BrainTraceRecorder.MAX_PENDING_WRITE_BYTES ||
      this.pendingWriteBytes + bytes > BrainTraceRecorder.MAX_PENDING_WRITE_BYTES
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
        // WS-035: under `content: 'full'` every trace row holds the question and
        // context verbatim. Create owner-only.
        await appendFile(this.opts.filePath, line, { encoding: 'utf8', mode: SECRET_FILE_MODE });
      })
      .catch(() => {
        // Tracing is best-effort — it must never destabilize the host.
      })
      .finally(() => {
        this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
        this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - bytes);
      });
  }
}

/** Read trace records back from a JSONL file, skipping corrupt rows. */
export async function readBrainTrace(filePath: string): Promise<BrainTraceRecord[]> {
  try {
    await access(filePath);
  } catch {
    return [];
  }
  const records: BrainTraceRecord[] = [];
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as BrainTraceRecord;
        if (parsed?.version === BRAIN_TRACE_VERSION && typeof parsed.requestId === 'string') {
          records.push(parsed);
        }
      } catch {
        // A partial tail is still useful history.
      }
    }
  } catch {
    return records;
  } finally {
    lines.close();
    input.destroy();
  }
  return records;
}
