/**
 * AutonomyBrain — a self-driving decision layer for autonomous workflows.
 *
 * Unlike the standard BrainArbiter which asks the human when uncertain,
 * AutonomyBrain makes decisions autonomously within configured risk
 * boundaries, keeping the system running unattended. It uses the session
 * LLM to evaluate situations and produce decisions.
 *
 * ## Identity
 * The AutonomyBrain is NOT the main agent. It is a dedicated decision
 * engine with a single purpose: evaluate blocked/stuck situations in
 * autonomous workflows and decide whether to continue, pivot, or stop.
 *
 * ## Decision Flow
 * 1. RISK GATE — if request risk > maxAutoRisk, auto-deny
 * 2. HEURISTIC — fast pattern-match for common situations (deadlock, retry-exhausted)
 * 3. LLM EVALUATION — complex decisions (goal completion, conflict resolution)
 *
 * ## Decision Logging
 * Every decision is emitted via `onDecision` callback with a human-readable
 * summary suitable for chat history and journal entries.
 *
 * Usage:
 *   const brain = createAutonomyBrain({
 *     provider, model, maxAutoRisk: 'high',
 *     onDecision: (summary) => journal.push(summary),
 *   });
 */

import type { Provider, Usage } from '../types/provider.js';
import {
  BRAIN_RISK_LEVELS,
  type BrainArbiter,
  type BrainDecision,
  type BrainDecisionRequest,
} from '../coordination/brain.js';
import {
  type BrainHeuristicsConfig,
  COMPETING_ALTERNATIVE,
  isBlockedResolved,
  resolveBrainHeuristics,
} from '../coordination/brain-heuristics.js';
import { markDecisionTier } from '../coordination/brain-telemetry.js';
import type { BrainCircuitBreaker } from './brain-circuit.js';
import type { EventBus } from '../kernel/events.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
import { safeParse } from '../utils/safe-json.js';

/** One (provider, model) pair the Brain may call for a decision. */
export interface BrainLlmTarget {
  provider: Provider;
  model: string;
  /** Display label for logs/status (e.g. "anthropic/claude-haiku"). */
  label?: string | undefined;
}

export interface AutonomyBrainOptions {
  /** LLM provider for decision-making. Ignored when `targets` is non-empty. */
  provider?: Provider | undefined;
  /** Model to use for decisions (should be fast + cheap). Ignored when `targets` is non-empty. */
  model?: string | undefined;
  /**
   * Ordered LLM pool. With `strategy: 'fallback'` (default) the first target
   * is primary and later ones are tried in order when a call fails/times
   * out; with 'round-robin' successive decisions rotate the starting target.
   * At least one of `targets` / (`provider` + `model`) must be provided.
   */
  targets?: BrainLlmTarget[] | undefined;
  /** Pool selection strategy. Default 'fallback'. */
  strategy?: 'fallback' | 'round-robin' | undefined;
  /** Maximum risk level the brain will auto-decide. Default: 'high'.
   *  'low'    — only auto-decide low-risk questions
   *  'medium' — auto-decide low/medium
   *  'high'   — auto-decide low/medium/high
   *  'all'    — auto-decide everything (including critical)
   */
  maxAutoRisk?: 'low' | 'medium' | 'high' | 'all' | undefined;
  /** Timeout for each decision call (ms). Default: 15_000. */
  decisionTimeoutMs?: number | undefined;
  /** Per-heuristic toggles for `quickDecide`. Omitted fields default to enabled. */
  heuristics?: BrainHeuristicsConfig | undefined;
  /**
   * Bus for `brain.llm_call` trace events — one per pool target per decision,
   * including the failures the fallback loop otherwise swallows.
   */
  events?: EventBus | undefined;
  /** Include raw response text in trace events. Off by default (production content). */
  traceContent?: boolean | undefined;
  /** Output budget per decision call. Default `DEFAULT_BRAIN_MAX_TOKENS` (200). */
  maxTokens?: number | undefined;
  /**
   * Reject responses in which the model declined to decide ("I don't know",
   * "insufficient evidence", empty text) instead of presenting them as an
   * answer. Default true — an empty or hedging response is not a decision.
   */
  rejectUncertain?: boolean | undefined;
  /**
   * Reject answers whose self-reported `confidence` is below this (0..1).
   * Default 0 = off. Responses that report no confidence are never rejected
   * by this gate.
   */
  minConfidence?: number | undefined;
  /**
   * Failure memory for the pool. When the breaker is open the tier is skipped
   * outright instead of paying `pool.length × decisionTimeoutMs` again for a
   * conclusion the previous decision already reached.
   */
  circuit?: BrainCircuitBreaker | undefined;
  /**
   * Decision-history digest for the LLM prompt (typically
   * `BrainDecisionLedger.digestFor`): how similar past decisions went and
   * how they turned out. Appended to the user message when non-empty.
   */
  getDecisionDigest?: ((request: BrainDecisionRequest) => string | undefined) | undefined;
  /**
   * Called after every decision with a human-readable summary.
   * Use this to log decisions into chat history, journal, or status line.
   * Example: "🧠 Brain: skipped deadlocked tasks → continuing with phase 3/5"
   */
  onDecision?: ((summary: string, decision: BrainDecision, request: BrainDecisionRequest) => void) | undefined;
}

/** Re-exported under the historical local name; canonical copy lives with `BrainRisk`. */
const RISK_LEVELS = BRAIN_RISK_LEVELS;

/** Runtime-adjustable autonomy ceiling for the tiered brain. */
export type BrainAutoRisk = 'off' | 'low' | 'medium' | 'high' | 'all';

/**
 * Resolve an autonomy ceiling to a level comparable against `RISK_LEVELS`.
 *
 * `RISK_LEVELS` is keyed by REQUEST risk (`low|medium|high|critical`), but a
 * ceiling is keyed by `BrainAutoRisk`, whose `'off'` and `'all'` values have
 * no entry there. Looking a ceiling up directly therefore silently produced
 * the fallback level — `'all'` resolved to `2` (= `high`), so
 * `createAutonomyBrain({ maxAutoRisk: 'all' })` auto-denied every `critical`
 * request despite being explicitly configured as permissive (see
 * `assembleBrainTiers`, which passes `'all'` precisely to keep the inner tier
 * ungated and let the tiered ceiling do the gating).
 *
 * Both the tiered arbiter and the single-LLM brain now share this one
 * resolver so the two ladders cannot drift apart again.
 *
 * @returns `-1` for `'off'` (nothing is auto-decidable), `3` for `'all'`
 *   (including `critical`), otherwise the matching `RISK_LEVELS` entry.
 */
export function resolveRiskCeiling(ceiling: BrainAutoRisk | undefined): number {
  if (ceiling === 'off') return -1;
  if (ceiling === 'all') return 3;
  return RISK_LEVELS[ceiling ?? 'medium'] ?? 1;
}

export interface TieredBrainArbiterOptions {
  /** Fast deterministic policy layer (DefaultBrainArbiter). Consulted first. */
  policy: BrainArbiter;
  /** LLM-backed autonomous layer (createAutonomyBrain). Consulted when the
   *  policy layer would escalate to the human and the request's risk is
   *  within the live ceiling. */
  autonomous?: BrainArbiter | undefined;
  /**
   * Live autonomy ceiling — read on EVERY decision so `/brain risk <level>`
   * changes take effect immediately. 'off' disables the autonomous layer
   * entirely (everything the policy can't answer goes to the human).
   */
  getMaxAutoRisk?: (() => BrainAutoRisk) | undefined;
  /**
   * Multi-LLM council (createCouncilBrainArbiter). When present, requests at
   * or above the council risk floor are decided by the council INSTEAD of
   * the single-LLM layer. Council answers AND denies are terminal — a panel
   * that considered the question and refused is a real decision, not a
   * failure. Only `ask_human` (quorum not met / judge unavailable) falls
   * through to the escalation tier.
   */
  council?: BrainArbiter | undefined;
  /** Live council risk floor. Default 'high'. Read on every decision. */
  getCouncilMinRisk?: (() => 'medium' | 'high' | 'critical') | undefined;
  /**
   * Whether an LLM-tier `deny` ends the decision. Read per decision.
   * Default 'never' — see `BrainConfig.llm.denyIsTerminal`.
   */
  getDenyIsTerminal?: (() => 'never' | 'when-decided' | 'always') | undefined;
  /**
   * Bus for `brain.tier_transition` events — one per tier the ladder ran,
   * recording what it returned and why the chain did or did not stop there.
   * Without it a decision's path through the ladder is unrecoverable.
   */
  events?: EventBus | undefined;
}

/**
 * The standard Brain positioning: policy first, LLM/council second,
 * escalation last.
 *
 *   1. POLICY  — deterministic DefaultBrainArbiter (low-risk fast path,
 *      fallback semantics). Denies and option-backed answers pass through
 *      untouched. A fallback-produced `continue` answer (no optionId, the
 *      request declared `fallback: 'continue'`) is only PROVISIONAL: it
 *      means "nobody could decide", not "this is the right call", so the
 *      LLM tier still gets consulted within the ceiling. Historically it
 *      short-circuited here, which meant e.g. goal-completion checks never
 *      reached the LLM at all.
 *   2. COUNCIL — requests at/above the council floor (default 'high') are
 *      decided by the multi-LLM council when one is wired.
 *   3. LLM     — everything else within the live ceiling goes to the
 *      single-LLM autonomous brain. Only a real `answer` short-circuits;
 *      denials/failures fall through.
 *   4. ESCALATION — anything left escalates. Callers wrap this in
 *      `EscalationRoutingBrainArbiter` (interactive prompt or headless
 *      terminal policy) or the legacy `HumanEscalatingBrainArbiter`.
 */
export function createTieredBrainArbiter(opts: TieredBrainArbiterOptions): BrainArbiter {
  const trace = (
    request: BrainDecisionRequest,
    tier: 'policy' | 'council' | 'llm',
    outcome: 'answer' | 'deny' | 'ask_human' | 'error' | 'skipped',
    terminal: boolean,
    startedAt: number,
    reason?: string,
  ): void => {
    opts.events?.emit('brain.tier_transition', {
      sessionId: request.sessionId,
      requestId: request.id,
      tier,
      outcome,
      terminal,
      ...(reason ? { reason } : {}),
      durationMs: Date.now() - startedAt,
      at: Date.now(),
    });
  };

  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const policyAt = Date.now();
      const policyDecision = await opts.policy.decide(request);
      // Provisional = the policy merely echoed the request's continue
      // fallback (no optionId means it did not pick a concrete option).
      const provisionalContinue =
        policyDecision.type === 'answer' &&
        policyDecision.optionId === undefined &&
        request.fallback === 'continue';
      if (policyDecision.type !== 'ask_human' && !provisionalContinue) {
        trace(request, 'policy', policyDecision.type, true, policyAt);
        return policyDecision;
      }
      trace(
        request,
        'policy',
        policyDecision.type,
        false,
        policyAt,
        provisionalContinue ? 'provisional continue — forwarded for a real judgement' : 'policy escalated',
      );

      // 'off' resolves to -1, so the comparison below short-circuits every
      // request back to the policy decision without a special case.
      const ceilingLevel = resolveRiskCeiling(opts.getMaxAutoRisk?.() ?? 'medium');
      const requestLevel = RISK_LEVELS[request.risk] ?? 2;
      if (requestLevel > ceilingLevel) {
        trace(request, 'llm', 'skipped', false, policyAt, `risk ${request.risk} exceeds the autonomy ceiling`);
        return policyDecision;
      }

      // COUNCIL — high-stakes questions get the multi-LLM panel.
      if (opts.council) {
        const floor = opts.getCouncilMinRisk?.() ?? 'high';
        const floorLevel = RISK_LEVELS[floor] ?? 2;
        if (requestLevel >= floorLevel) {
          const councilAt = Date.now();
          try {
            const councilDecision = await opts.council.decide(request);
            if (councilDecision.type !== 'ask_human') {
              markDecisionTier(request, 'council');
              trace(request, 'council', councilDecision.type, true, councilAt);
              return councilDecision;
            }
            trace(request, 'council', 'ask_human', false, councilAt, 'council abstained');
          } catch (err) {
            // Council failure degrades to the single-LLM tier below.
            trace(
              request,
              'council',
              'error',
              false,
              councilAt,
              err instanceof Error ? err.message : String(err),
            );
          }
        } else {
          trace(request, 'council', 'skipped', false, policyAt, `risk ${request.risk} below the council floor`);
        }
      }

      if (!opts.autonomous) {
        trace(request, 'llm', 'skipped', false, policyAt, 'no LLM tier configured');
        return policyDecision;
      }
      const llmAt = Date.now();
      try {
        const llmDecision = await opts.autonomous.decide(request);
        if (llmDecision.type === 'answer') {
          trace(request, 'llm', 'answer', true, llmAt);
          return llmDecision;
        }
        // A deny may be a real refusal or just a dead pool. `readLlmDenyKind`
        // tells them apart; without that distinction every refusal had to be
        // discarded to stay safe against infrastructure failures.
        if (llmDecision.type === 'deny') {
          const policy = opts.getDenyIsTerminal?.() ?? 'never';
          const kind = readLlmDenyKind(llmDecision);
          const terminal =
            policy === 'always' || (policy === 'when-decided' && kind === undefined);
          if (terminal) {
            markDecisionTier(request, 'llm');
            trace(request, 'llm', 'deny', true, llmAt, `denyIsTerminal: ${policy}`);
            return llmDecision;
          }
        }
        trace(request, 'llm', llmDecision.type, false, llmAt, 'non-answer discarded by the ladder');
      } catch (err) {
        // LLM layer is best-effort — fall through to the escalation tier.
        trace(request, 'llm', 'error', false, llmAt, err instanceof Error ? err.message : String(err));
      }
      // The LLM tier marked itself before we rejected its non-answer; restore
      // the provenance to the decision we are actually returning.
      markDecisionTier(request, 'policy');
      return policyDecision;
    },
  };
}

/**
 * Create a self-driving brain that makes autonomous decisions.
 * Never asks the human — within its risk boundary it answers, above it denies.
 */
export function createAutonomyBrain(opts: AutonomyBrainOptions): BrainArbiter {
  const maxRisk = opts.maxAutoRisk ?? 'high';
  const maxRiskLevel = resolveRiskCeiling(maxRisk);
  const timeoutMs = opts.decisionTimeoutMs ?? 15_000;
  const targets: BrainLlmTarget[] =
    opts.targets && opts.targets.length > 0
      ? opts.targets
      : opts.provider && opts.model
        ? [{ provider: opts.provider, model: opts.model }]
        : [];
  if (targets.length === 0) {
    throw new Error('createAutonomyBrain: provide `targets` or `provider` + `model`.');
  }
  const strategy = opts.strategy ?? 'fallback';
  // Round-robin rotation cursor — advances once per decision, not per attempt.
  let rrCursor = 0;

  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const requestLevel = RISK_LEVELS[request.risk] ?? 2;

      // RISK GATE — above our risk boundary → auto-deny
      if (requestLevel > maxRiskLevel) {
        const reason = `Auto-denied: risk "${request.risk}" exceeds max "${maxRisk}"`;
        const decision: BrainDecision = { type: 'deny', reason };
        opts.onDecision?.(
          `🧠 Brain: DENIED — ${request.question.slice(0, 80)} (risk: ${request.risk} > ${maxRisk})`,
          decision,
          request,
        );
        return decision;
      }

      // HEURISTIC — fast pattern-match
      const heuristic = quickDecide(request, opts.heuristics);
      if (heuristic) {
        markDecisionTier(request, 'heuristic');
        opts.onDecision?.(formatDecisionSummary(heuristic, request), heuristic, request);
        return heuristic;
      }

      // CIRCUIT BREAKER — a dead pool must not cost a full timeout sweep on
      // every decision. Skipping here returns the same `unavailable` deny the
      // sweep would have produced, so the ladder behaves identically minus
      // the wait.
      if (opts.circuit && !opts.circuit.shouldAttempt()) {
        const decision = markDenyKind(
          {
            type: 'deny',
            reason: 'Autonomy Brain LLM tier is circuit-broken after repeated failures.',
          },
          'unavailable',
        );
        opts.onDecision?.(formatDecisionSummary(decision, request), decision, request);
        return decision;
      }

      // LLM EVALUATION — complex decisions. Try the pool in order; the first
      // target that produces a usable response wins.
      // Wrap the cursor in place rather than letting it grow unbounded, so a
      // long-lived session cannot drift it toward Number.MAX_SAFE_INTEGER.
      let start = 0;
      if (strategy === 'round-robin') {
        start = rrCursor;
        rrCursor = (rrCursor + 1) % targets.length;
      }
      const rotated = [...targets.slice(start), ...targets.slice(0, start)];
      // Known-bad targets go last so a recovered model is still reached.
      const ordered = opts.circuit
        ? opts.circuit.orderTargets(rotated, (t) => t.label ?? t.model)
        : rotated;
      const digest = opts.getDecisionDigest?.(request);
      const llmDecision = await llmDecide(
        request,
        ordered,
        timeoutMs,
        digest,
        opts.events ? { events: opts.events, content: opts.traceContent === true } : undefined,
        opts.maxTokens,
        {
          rejectUncertain: opts.rejectUncertain ?? true,
          minConfidence: opts.minConfidence ?? 0,
        },
        opts.circuit,
      );
      markDecisionTier(request, 'llm');
      opts.onDecision?.(formatDecisionSummary(llmDecision, request), llmDecision, request);
      return llmDecision;
    },
  };
}

/**
 * Format a decision as a human-readable one-liner for chat history.
 */
export function formatDecisionSummary(
  decision: BrainDecision,
  request: BrainDecisionRequest,
): string {
  const question = request.question.length > 80
    ? request.question.slice(0, 77) + '…'
    : request.question;

  if (decision.type === 'deny') {
    return `🧠 Brain: DENIED — "${question}" → ${decision.reason}`;
  }

  if (decision.type === 'answer') {
    const action = decision.optionId
      ? `chose [${decision.optionId}]`
      : decision.text.length > 60
        ? decision.text.slice(0, 57) + '…'
        : decision.text;
    return `🧠 Brain: DECIDED — "${question}" → ${action}`;
  }

  return `🧠 Brain: ASKED HUMAN — "${question}"`;
}

/**
 * Fast heuristic decisions that don't need an LLM call.
 *
 * Deliberately narrow: heuristics never fire on option-bearing requests
 * (options are control-plane input demanding a structured choice, not a
 * keyword guess) and the continue fast-path only fires when the caller
 * itself declared continue the safe fallback AND the question offers no
 * alternative — "Should we continue or stop?" must reach the LLM.
 */
export function quickDecide(
  request: BrainDecisionRequest,
  heuristics?: BrainHeuristicsConfig | undefined,
): BrainDecision | null {
  if (request.options?.length) return null;

  const h = resolveBrainHeuristics(heuristics);
  const q = request.question.toLowerCase();
  const ctx = request.context?.toLowerCase() ?? '';

  // Deadlock with failed tasks → skip and continue. The context must mention
  // "failed" anchored to a work-unit noun (task, step, job, …) so that
  // incidental mentions like "login failed" don't trigger the fast path.
  if (h.deadlockSkip && q.includes('deadlock') && /\bfailed\s+(?:task|step|job|build|test|phase|stage|item|unit)s?\b/.test(ctx)) {
    return {
      type: 'answer',
      text: 'Skip deadlocked tasks and continue with remaining work. Failed tasks will be reported in the final summary.',
      rationale: 'Heuristic: deadlocked tasks blocked by failed dependencies — skipping unblocks remaining work.',
    };
  }

  // Repeated failure with retries demonstrably exhausted → move on. Requires
  // an explicit exhausted marker or a concrete ≥3 attempt/failure count —
  // a bare "3" anywhere in the context is not evidence.
  if (
    h.retryExhausted &&
    (q.includes('failed') || q.includes('retry')) &&
    (/\bexhausted\b/.test(ctx) ||
      /\b(?:[3-9]|\d{2,})\s+(?:consecutive\s+)?(?:times|attempts|retries|failures)\b/.test(ctx) ||
      /\b(?:attempt|retr(?:y|ies)|failure)s?\W{0,3}(?:[3-9]|\d{2,})\b/.test(ctx))
  ) {
    return {
      type: 'answer',
      text: 'Mark as failed and move on. Note the failure for the final report.',
      rationale: 'Heuristic: retries exhausted — continuing would waste resources.',
    };
  }

  // Blocked dependency explicitly resolved → continue. Requires the caller
  // to have declared continue safe and no competing alternative in the
  // question. The context must contain an explicit resolution marker so
  // that "blocked by X" without evidence of resolution still reaches the LLM.
  if (
    h.blockedResolved &&
    request.fallback === 'continue' &&
    isBlockedResolved(q, ctx, h.blockedResolvedMarkers)
  ) {
    return {
      type: 'answer',
      text: 'Blocker resolved. Continue with the previously blocked work.',
      rationale: 'Heuristic: blocking dependency explicitly resolved — resuming.',
    };
  }

  // Goal complete verification → needs LLM evaluation
  if (q.includes('goal complete') || q.includes('mission complete')) {
    return null;
  }

  // Plain continue/proceed ping whose caller declared continue safe, with no
  // competing alternative in the question → yes without burning an LLM call.
  if (
    h.continuePing &&
    request.fallback === 'continue' &&
    /\b(?:continue|proceed)\b/.test(q) &&
    !/\b(?:stop|abort|halt|cancel|pause|rollback)\b/.test(q) &&
    !COMPETING_ALTERNATIVE.test(q)
  ) {
    return {
      type: 'answer',
      text: 'Continue execution. Do not stop.',
      rationale: 'Heuristic: autonomy mode — continue until all work is complete.',
    };
  }

  return null;
}

/**
 * Render a decision request as the user message for a Brain LLM call.
 * Shared by the single-LLM tier and every council voter so all of them see
 * the same question/context/options shape.
 */
export function buildBrainUserMessage(request: BrainDecisionRequest): string {
  const optionsText = request.options?.length
    ? '\nOptions:\n' +
      request.options
        .map(
          (o) =>
            `  [${o.id}] ${o.label}${o.consequence ? ` — ${o.consequence}` : ''}${o.recommended ? ' ★ recommended' : ''}`,
        )
        .join('\n')
    : '';

  return [
    `Question: ${request.question}`,
    request.context ? `\nContext:\n${request.context}` : '',
    optionsText,
  ].filter(Boolean).join('\n');
}

/** Append a decision-history digest to a Brain user message (shared shape). */
export function withDecisionDigest(user: string, digest: string | undefined): string {
  if (!digest?.trim()) return user;
  return `${user}\n\nOutcome history of similar past decisions (learn from it):\n${digest}`;
}

/**
 * One Brain LLM call against a single target. Throws on transport failure,
 * timeout, or abort — callers own the pool/fallback semantics.
 */
export async function completeBrainLlm(
  target: BrainLlmTarget,
  input: { system: string; user: string; timeoutMs: number; maxTokens?: number | undefined },
): Promise<string> {
  return (await completeBrainLlmDetailed(target, input)).text;
}

/** Text plus the observable call metadata a trace/quality gate needs. */
interface BrainLlmCallResult {
  text: string;
  usage?: Usage | undefined;
  /**
   * `'max_tokens'` means the response was CUT OFF. With the default 200-token
   * budget a rationale can be truncated mid-sentence, and the free-text path
   * would happily turn that fragment into a decision — so callers must be
   * able to see it.
   */
  stopReason?: string | undefined;
}

/**
 * One Brain LLM call, returning the metadata `completeBrainLlm` discards.
 *
 * Usage was previously thrown away at this boundary, which is why the council
 * adapter reported hardcoded zero tokens for every seat and why "what do
 * Brain decisions cost" had no answer.
 */
export async function completeBrainLlmDetailed(
  target: BrainLlmTarget,
  input: { system: string; user: string; timeoutMs: number; maxTokens?: number | undefined },
): Promise<BrainLlmCallResult> {
  const signal = AbortSignal.timeout(input.timeoutMs);
  const response = await target.provider.complete(
    {
      model: target.model,
      system: [{ type: 'text', text: input.system }],
      messages: [{ role: 'user', content: input.user || 'Decide.' }],
      maxTokens: input.maxTokens ?? DEFAULT_BRAIN_MAX_TOKENS,
    },
    { signal },
  );
  return {
    text: extractText(response).trim(),
    usage: extractUsage(response),
    stopReason: extractStopReason(response),
  };
}

/**
 * Output budget for a Brain decision call.
 *
 * Deliberately small — a Brain response is one decision plus a one-sentence
 * rationale, not prose. Raise it via `brain.llm.maxTokens` if truncation
 * shows up in the trace as `stopReason: 'max_tokens'`.
 */
export const DEFAULT_BRAIN_MAX_TOKENS = 200;

function extractUsage(result: unknown): Usage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const usage = (result as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input === 'number' ? u.input : undefined;
  const output = typeof u.output === 'number' ? u.output : undefined;
  if (input === undefined && output === undefined) return undefined;
  return { input: input ?? 0, output: output ?? 0 };
}

function extractStopReason(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const reason = (result as { stopReason?: unknown }).stopReason;
  return typeof reason === 'string' ? reason : undefined;
}

/**
 * Ask the LLM pool for a decision on complex questions. Targets are tried
 * in the given order; the first one that answers wins. Uses a carefully
 * crafted system prompt that establishes the brain's identity, purpose,
 * and decision-making framework.
 */
type BrainLlmDenyKind =
  /** No target in the pool produced a response (transport/timeout). */
  | 'unavailable'
  /** A response came back but carried no exact valid option id. */
  | 'unparseable'
  /** The model considered the question and refused. */
  | 'refused';

/**
 * Why a Brain LLM call ended in `deny`.
 *
 * `llmDecide` historically collapsed three very different situations into one
 * bare `{type:'deny'}`: a dead provider pool, an unparseable response, and a
 * model that genuinely refused. Callers could not tell them apart, so
 * `createTieredBrainArbiter` had to treat ALL of them as infrastructure noise
 * and fall through — which meant a real refusal could never be terminal.
 *
 * The kind is recorded out of band (keyed by the decision object's identity)
 * so the `BrainDecision` union — and every consumer that structurally
 * compares decisions — stays untouched.
 */
const denyKinds = new WeakMap<object, BrainLlmDenyKind>();

/** Tag a deny decision with the reason it was produced. */
function markDenyKind(decision: BrainDecision, kind: BrainLlmDenyKind): BrainDecision {
  denyKinds.set(decision, kind);
  return decision;
}

/**
 * Read the reason a Brain LLM tier denied, when known. Returns undefined for
 * decisions that did not come from `llmDecide` (policy denials, council
 * denials, ledger-guard denials), which callers should treat as decided.
 */
export function readLlmDenyKind(decision: BrainDecision): BrainLlmDenyKind | undefined {
  return denyKinds.get(decision);
}

async function llmDecide(
  request: BrainDecisionRequest,
  targets: BrainLlmTarget[],
  timeoutMs: number,
  digest?: string | undefined,
  trace?: { events: EventBus; content: boolean } | undefined,
  maxTokens?: number | undefined,
  quality?: { rejectUncertain: boolean; minConfidence: number } | undefined,
  circuit?: BrainCircuitBreaker | undefined,
): Promise<BrainDecision> {
  const systemPrompt = readBundledInstructionText('llm/autonomy-brain.md');
  const userMessage = withDecisionDigest(buildBrainUserMessage(request), digest);

  let text: string | null = null;
  for (const [attempt, target] of targets.entries()) {
    const startedAt = Date.now();
    try {
      const result = await completeBrainLlmDetailed(target, {
        system: systemPrompt,
        user: userMessage,
        timeoutMs,
        maxTokens,
      });
      text = result.text;
      circuit?.recordSuccess(target.label ?? target.model);
      trace?.events.emit('brain.llm_call', {
        sessionId: request.sessionId,
        requestId: request.id,
        tier: 'llm',
        providerId: target.provider.id,
        model: target.model,
        label: target.label,
        attempt,
        ok: true,
        durationMs: Date.now() - startedAt,
        // A truncated response is a quality problem, not a transport one —
        // surface it rather than letting a half-sentence become a decision.
        ...(result.stopReason === 'max_tokens'
          ? { error: 'response truncated at maxTokens' }
          : {}),
        ...(trace.content ? { responseText: text } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        at: Date.now(),
      });
      break;
    } catch (err) {
      // This target is unavailable/slow — fall through to the next one. The
      // failure used to vanish here, which is precisely why a silently
      // degraded pool was undetectable.
      circuit?.recordFailure(target.label ?? target.model);
      trace?.events.emit('brain.llm_call', {
        sessionId: request.sessionId,
        requestId: request.id,
        tier: 'llm',
        providerId: target.provider.id,
        model: target.model,
        label: target.label,
        attempt,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
    }
  }

  if (text === null) {
    // Entire pool unavailable. This is NOT a decision, whatever the caller's
    // fallback says.
    //
    // This branch used to synthesise `{type:'answer', text:'Continue …'}` for
    // `fallback: 'continue'` requests. The outcome was right but the framing
    // was not: the tiered ladder then accepted it as a genuine model answer,
    // so telemetry credited a model that was never reached, the trace
    // recorded an LLM answer for a call that never happened, and the
    // uncertainty gate was bypassed entirely.
    //
    // Reporting `unavailable` instead is both honest and outcome-preserving:
    // the ladder falls through to the policy tier, whose `fallback:'continue'`
    // handling produces exactly the same continue — attributed to `policy`,
    // which is what actually decided.
    return markDenyKind(
      { type: 'deny', reason: 'Autonomy Brain LLM unavailable for decision.' },
      'unavailable',
    );
  }

  // Option-bearing decisions are control-plane input, not prose. Accept the
  // canonical JSON envelope and the historical leading `[id]` form, but
  // never substring-match an id anywhere in free text: a response such as
  // "do not spawn; wait" must not select the earlier `spawn` option.
  const minConfidence = quality?.minConfidence ?? 0;
  const rejectUncertain = quality?.rejectUncertain ?? true;
  const confidence = extractConfidence(text);
  const belowConfidence = minConfidence > 0 && confidence !== undefined && confidence < minConfidence;

  if (request.options?.length) {
    const parsed = parseOptionDecision(text, request.options);
    if (parsed && !belowConfidence) {
      return parsed;
    }
    return markDenyKind(
      {
        type: 'deny',
        reason: belowConfidence
          ? `Autonomy Brain reported confidence ${confidence} below the ${minConfidence} floor.`
          : 'Autonomy Brain returned no exact valid option id.',
      },
      'unparseable',
    );
  }

  // Free-text answer. A response that declined to decide, or that is empty
  // because the provider returned an unrecognised shape, must NOT be dressed
  // up as a decision — the caller would act on it.
  const envelope = parseFreeTextDecision(text);
  if (rejectUncertain && (!envelope || belowConfidence)) {
    return markDenyKind(
      {
        type: 'deny',
        reason: belowConfidence
          ? `Autonomy Brain reported confidence ${confidence} below the ${minConfidence} floor.`
          : 'Autonomy Brain returned no usable decision (empty or declined).',
      },
      'unparseable',
    );
  }

  return {
    type: 'answer',
    text:
      envelope?.decision ||
      (request.fallback === 'continue' ? 'Continue execution.' : 'Denied by autonomy policy.'),
    rationale: envelope?.rationale ?? envelope?.decision ?? undefined,
  };
}

/** Read a self-reported confidence out of a raw response, if it carries one. */
export function extractConfidence(rawText: string): number | undefined {
  const text = rawText.trim();
  const wholeFence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text);
  const candidate = wholeFence ? (wholeFence[1] ?? '').trim() : text;
  const parsed = safeParse<{ confidence?: unknown }>(candidate, 16_384);
  if (!parsed.ok || !parsed.value) return undefined;
  const value = parsed.value.confidence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/**
 * Phrases that mean the model declined to decide.
 *
 * The optionless path used to wrap ANY returned prose in
 * `{type:'answer'}` — so "I don't have enough information to say" became a
 * decision the caller would act on, indistinguishable from a real judgement.
 * Word-boundary anchored to avoid matching inside longer words.
 */
const LLM_NON_ANSWER =
  /\b(?:insufficient evidence|not enough (?:information|context|evidence)|cannot determine|can't determine|unable to determine|i (?:don't|do not) know|unclear|please (?:clarify|specify)|need more (?:information|context|detail)|as an ai)\b/i;

/** Does this free-text response decline to decide? */
export function isNonAnswer(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || LLM_NON_ANSWER.test(trimmed);
}

/** Structured envelope a Brain LLM may return for an optionless question. */
interface BrainFreeTextEnvelope {
  decision: string;
  rationale?: string | undefined;
  confidence?: number | undefined;
}

/**
 * Parse the optionless response.
 *
 * Accepts the structured envelope the prompt now asks for, and falls back to
 * bare prose so older/simpler models keep working. Returns null when the
 * model declined to decide — the caller must then fall through rather than
 * present the refusal as an answer.
 */
export function parseFreeTextDecision(rawText: string): BrainFreeTextEnvelope | null {
  const text = rawText.trim();
  if (text.length === 0) return null;

  const wholeFence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text);
  const candidate = wholeFence ? (wholeFence[1] ?? '').trim() : text;
  const parsed = safeParse<{ decision?: unknown; rationale?: unknown; confidence?: unknown }>(
    candidate,
    16_384,
  );
  if (parsed.ok && parsed.value && typeof parsed.value.decision === 'string') {
    const decision = parsed.value.decision.trim();
    if (isNonAnswer(decision)) return null;
    return {
      decision,
      rationale:
        typeof parsed.value.rationale === 'string' && parsed.value.rationale.trim()
          ? parsed.value.rationale.trim()
          : undefined,
      confidence:
        typeof parsed.value.confidence === 'number' && Number.isFinite(parsed.value.confidence)
          ? Math.min(1, Math.max(0, parsed.value.confidence))
          : undefined,
    };
  }

  if (isNonAnswer(text)) return null;
  return { decision: text };
}

export function parseOptionDecision(
  rawText: string,
  options: NonNullable<BrainDecisionRequest['options']>,
): BrainDecision | null {
  const text = rawText.trim();
  const byId = new Map(options.map((option) => [option.id, option] as const));

  // A fenced response is accepted only when the fence is the entire payload.
  // Extracting an embedded JSON block from prose would reintroduce the same
  // ambiguity as substring matching (for example: "do not spawn" followed by
  // an illustrative `{ optionId: 'spawn' }` block).
  const wholeFence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(text);
  const jsonCandidate = wholeFence ? (wholeFence[1] ?? '').trim() : text;
  const parsed = safeParse<{ optionId?: unknown; rationale?: unknown }>(jsonCandidate, 16_384);
  if (parsed.ok && parsed.value && typeof parsed.value.optionId === 'string') {
    const option = byId.get(parsed.value.optionId);
    if (!option) return null;
    return {
      type: 'answer',
      optionId: option.id,
      text: option.label,
      rationale:
        typeof parsed.value.rationale === 'string' && parsed.value.rationale.trim()
          ? parsed.value.rationale.trim()
          : undefined,
    };
  }

  // Backward compatibility for the prompt's former `[id] — rationale` shape.
  // The id must be the first semantic token; mentions later in prose are not
  // decisions and deliberately fail closed.
  const legacy = /^\s*\[([^\]\r\n]+)\](?:\s*(?:—|-|:)\s*)?([\s\S]*)$/.exec(text);
  if (!legacy) return null;
  const option = byId.get((legacy[1] ?? '').trim());
  if (!option) return null;
  const rationale = (legacy[2] ?? '').trim();
  return {
    type: 'answer',
    optionId: option.id,
    text: option.label,
    rationale: rationale || undefined,
  };
}

function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    return (r.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  if (Array.isArray(r.choices)) {
    return (r.choices as Array<{ message?: { content?: string } }>)[0]?.message?.content ?? '';
  }
  return typeof r.text === 'string' ? r.text : '';
}
