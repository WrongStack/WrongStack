/**
 * BrainRules — the configurable deterministic tier.
 *
 * Every deterministic decision the Brain could make used to be a hardcoded
 * regex or `if` buried in `DefaultBrainArbiter` / `quickDecide`. That made the
 * cheapest tier the least controllable one: operators could change WHEN the
 * expensive tiers engage (risk ceilings, council floors) but never WHAT the
 * free tier is able to settle on its own. The practical consequence was that
 * high-frequency, low-information questions — above all the BrainMonitor's
 * steer/continue engagements — always fell through to a provider call.
 *
 * This module adds a rule table in front of the policy tier:
 *
 *     rules → policy → cache → council → LLM → escalation
 *
 * Rules are pure predicates over the request. They perform no I/O, cannot
 * call a provider, and evaluate first-match-wins. A rule that matches but
 * whose action is `defer` explicitly hands the request to the next tier,
 * which makes "everything EXCEPT X is deterministic" expressible.
 *
 * ## Trust
 * `config.brain` is on the in-project config deny list, so rules can only
 * come from the user's own active-profile config — never from a repo. Regex
 * sources are still length-capped and compiled defensively (a bad pattern
 * disables its own rule rather than taking the Brain down), and matching runs
 * against truncated inputs so a pathological pattern cannot stall a decision
 * indefinitely.
 *
 * @module brain-rules
 */

import type { EventBus } from '../kernel/events.js';
import {
  BRAIN_RISK_LEVELS,
  type BrainArbiter,
  type BrainDecision,
  type BrainDecisionRequest,
  type BrainDecisionSource,
  type BrainFallback,
  type BrainRisk,
} from './brain.js';
import { emitBrainTierTransition, markDecisionTier } from './brain-telemetry.js';

/** Longest regex source accepted from config. */
export const BRAIN_RULE_PATTERN_MAX = 1_000;

/**
 * Longest question/context prefix a rule pattern is matched against.
 *
 * Bounding the SUBJECT is the only backtracking mitigation available to a
 * JS regex engine without a timeout: a catastrophic pattern's blow-up is
 * driven by input length, so a hard cap keeps the worst case bounded. Brain
 * questions are short by construction and context is already truncated
 * upstream, so this never changes a legitimate match.
 */
export const BRAIN_RULE_SUBJECT_MAX = 8_000;

/** Predicate over a decision request. All present fields must match (AND). */
export interface BrainRuleMatch {
  /** Request source(s). Omitted = any. */
  source?: BrainDecisionSource | BrainDecisionSource[] | undefined;
  /** Exact request risk(s). Omitted = any. */
  risk?: BrainRisk | BrainRisk[] | undefined;
  /** Inclusive lower bound on request risk. */
  minRisk?: BrainRisk | undefined;
  /** Inclusive upper bound on request risk. */
  maxRisk?: BrainRisk | undefined;
  /** Caller-declared fallback(s). Omitted = any. */
  fallback?: BrainFallback | BrainFallback[] | undefined;
  /** true = request must carry options; false = must carry none. */
  hasOptions?: boolean | undefined;
  /** Request must offer an option with this exact id. */
  offersOption?: string | undefined;
  /** Case-insensitive regex the question must match. */
  question?: string | undefined;
  /** Case-insensitive regex the context must match (no context = no match). */
  context?: string | undefined;
  /** Case-insensitive regex the question must NOT match. */
  notQuestion?: string | undefined;
  /** Case-insensitive regex the context must NOT match (no context = passes). */
  notContext?: string | undefined;
}

/** What a matching rule does. */
export type BrainRuleAction =
  | {
      action: 'answer';
      /** Must name an option the request actually offers, else the rule defers. */
      optionId?: string | undefined;
      text?: string | undefined;
      rationale?: string | undefined;
    }
  | { action: 'deny'; reason?: string | undefined }
  | { action: 'escalate'; prompt?: string | undefined }
  /** Match, but hand the request to the next tier anyway. */
  | { action: 'defer' };

/** One deterministic rule from `config.brain.rules`. */
export interface BrainRule {
  /** Stable identifier, surfaced in rationales and telemetry. */
  id: string;
  /** Default true. */
  enabled?: boolean | undefined;
  /** Free-text note for humans; never interpreted. */
  description?: string | undefined;
  when: BrainRuleMatch;
  then: BrainRuleAction;
}

interface CompiledMatch {
  sources?: ReadonlySet<string> | undefined;
  risks?: ReadonlySet<string> | undefined;
  minRiskLevel?: number | undefined;
  maxRiskLevel?: number | undefined;
  fallbacks?: ReadonlySet<string> | undefined;
  hasOptions?: boolean | undefined;
  offersOption?: string | undefined;
  question?: RegExp | undefined;
  context?: RegExp | undefined;
  notQuestion?: RegExp | undefined;
  notContext?: RegExp | undefined;
}

export interface CompiledBrainRule {
  id: string;
  match: CompiledMatch;
  then: BrainRuleAction;
}

export interface BrainRuleCompileResult {
  rules: CompiledBrainRule[];
  /** One entry per rejected rule: `<id>: <why>`. Hosts surface these; nothing throws. */
  errors: string[];
}

const asSet = (value: string | string[] | undefined): ReadonlySet<string> | undefined => {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : [value];
  return items.length > 0 ? new Set(items) : undefined;
};

function compilePattern(
  source: string | undefined,
  label: string,
  ruleId: string,
): RegExp | undefined {
  if (source === undefined) return undefined;
  if (source.length > BRAIN_RULE_PATTERN_MAX) {
    throw new Error(
      `${ruleId}: ${label} pattern is ${source.length} chars (max ${BRAIN_RULE_PATTERN_MAX})`,
    );
  }
  try {
    return new RegExp(source, 'i');
  } catch (err) {
    throw new Error(
      `${ruleId}: invalid ${label} pattern — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function riskLevel(risk: BrainRisk | undefined, label: string, ruleId: string): number | undefined {
  if (risk === undefined) return undefined;
  const level = BRAIN_RISK_LEVELS[risk];
  if (level === undefined) throw new Error(`${ruleId}: unknown ${label} "${risk}"`);
  return level;
}

/**
 * Compile a rule table. Invalid rules are DROPPED with an explanatory error
 * rather than throwing: one bad pattern in a long-lived config must not take
 * the whole Brain offline, and the surviving rules are still useful.
 */
export function compileBrainRules(rules: readonly BrainRule[] | undefined): BrainRuleCompileResult {
  const compiled: CompiledBrainRule[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const [index, rule] of (rules ?? []).entries()) {
    const id = typeof rule?.id === 'string' && rule.id.trim() ? rule.id.trim() : `rule[${index}]`;
    try {
      if (rule.enabled === false) continue;
      if (seen.has(id)) throw new Error(`${id}: duplicate rule id`);
      if (!rule.when || typeof rule.when !== 'object') throw new Error(`${id}: missing "when"`);
      if (!rule.then || typeof rule.then !== 'object') throw new Error(`${id}: missing "then"`);

      const w = rule.when;
      const match: CompiledMatch = {
        sources: asSet(w.source),
        risks: asSet(w.risk),
        minRiskLevel: riskLevel(w.minRisk, 'minRisk', id),
        maxRiskLevel: riskLevel(w.maxRisk, 'maxRisk', id),
        fallbacks: asSet(w.fallback),
        hasOptions: w.hasOptions,
        offersOption: w.offersOption,
        question: compilePattern(w.question, 'question', id),
        context: compilePattern(w.context, 'context', id),
        notQuestion: compilePattern(w.notQuestion, 'notQuestion', id),
        notContext: compilePattern(w.notContext, 'notContext', id),
      };

      const action = rule.then.action;
      if (action !== 'answer' && action !== 'deny' && action !== 'escalate' && action !== 'defer') {
        throw new Error(`${id}: unknown action "${String(action)}"`);
      }
      if (action === 'answer' && !rule.then.optionId && !rule.then.text?.trim()) {
        throw new Error(`${id}: an "answer" rule needs an optionId or text`);
      }

      seen.add(id);
      // `when`/`then` is the rule DSL's public config vocabulary (documented
      // in configuration.md, mirrored in the WebUI wire types), so renaming it
      // would break user configs. The thenable hazard does not apply here:
      // `then` is always a BrainRuleAction OBJECT, and `await` only treats a
      // value as a promise when `.then` is CALLABLE — awaiting a compiled rule
      // would simply resolve to the rule itself.
      // biome-ignore lint/suspicious/noThenProperty: public rule-DSL field; the value is never callable
      compiled.push({ id, match, then: rule.then });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { rules: compiled, errors };
}

const subject = (value: string | undefined): string =>
  (value ?? '').slice(0, BRAIN_RULE_SUBJECT_MAX);

/** Does this compiled rule apply to the request? */
export function ruleMatches(rule: CompiledBrainRule, request: BrainDecisionRequest): boolean {
  const m = rule.match;
  if (m.sources && !m.sources.has(request.source)) return false;
  if (m.risks && !m.risks.has(request.risk)) return false;
  if (m.fallbacks && !m.fallbacks.has(request.fallback)) return false;

  if (m.minRiskLevel !== undefined || m.maxRiskLevel !== undefined) {
    const level = BRAIN_RISK_LEVELS[request.risk];
    if (level === undefined) return false;
    if (m.minRiskLevel !== undefined && level < m.minRiskLevel) return false;
    if (m.maxRiskLevel !== undefined && level > m.maxRiskLevel) return false;
  }

  const optionCount = request.options?.length ?? 0;
  if (m.hasOptions !== undefined && m.hasOptions !== optionCount > 0) return false;
  if (m.offersOption !== undefined && !request.options?.some((o) => o.id === m.offersOption)) {
    return false;
  }

  if (m.question && !m.question.test(subject(request.question))) return false;
  if (m.notQuestion?.test(subject(request.question))) return false;

  // A context pattern cannot be satisfied by an absent context: rules that
  // demand evidence must not fire when there is none to inspect.
  if (m.context) {
    if (!request.context) return false;
    if (!m.context.test(subject(request.context))) return false;
  }
  if (m.notContext && request.context && m.notContext.test(subject(request.context))) return false;

  return true;
}

/**
 * Turn a matching rule into a decision. Returns null when the rule defers, or
 * when its action cannot be honoured (an `answer` naming an option the
 * request does not offer) — failing open to the next tier rather than
 * fabricating an option id the caller would not recognise.
 */
export function applyRule(
  rule: CompiledBrainRule,
  request: BrainDecisionRequest,
): BrainDecision | null {
  const then = rule.then;
  const attribution = `Deterministic Brain rule "${rule.id}".`;

  switch (then.action) {
    case 'defer':
      return null;

    case 'deny':
      return {
        type: 'deny',
        reason: then.reason?.trim()
          ? `${then.reason.trim()} (${attribution})`
          : `${attribution} Denied without consulting a model.`,
      };

    case 'escalate':
      // The escalation ROUTER decides what `ask_human` ultimately becomes
      // (a real prompt in interactive mode, the terminal policy in headless),
      // so a rule only needs to declare that it wants out of the fast path.
      return {
        type: 'ask_human',
        prompt: then.prompt?.trim() || request.question,
        options: request.options,
        rationale: attribution,
      };

    case 'answer': {
      if (then.optionId !== undefined) {
        const option = request.options?.find((o) => o.id === then.optionId);
        if (!option) return null;
        return {
          type: 'answer',
          optionId: option.id,
          text: then.text?.trim() || option.label,
          rationale: then.rationale?.trim() || attribution,
        };
      }
      const text = then.text?.trim();
      if (!text) return null;
      return { type: 'answer', text, rationale: then.rationale?.trim() || attribution };
    }
  }
}

/** Evaluate a compiled table; first rule that yields a decision wins. */
export function evaluateBrainRules(
  rules: readonly CompiledBrainRule[],
  request: BrainDecisionRequest,
): { decision: BrainDecision; ruleId: string } | null {
  for (const rule of rules) {
    if (!ruleMatches(rule, request)) continue;
    const decision = applyRule(rule, request);
    // A matching rule that produced nothing (defer, or an unusable action)
    // hands over to the NEXT TIER, not to the next rule — otherwise `defer`
    // could not express "stop rule evaluation here".
    if (decision) return { decision, ruleId: rule.id };
    return null;
  }
  return null;
}

export interface RuleBrainArbiterOptions {
  /** Consulted when no rule decides. */
  inner: BrainArbiter;
  /** Live rule table — read per decision so config edits apply immediately. */
  getRules: () => readonly CompiledBrainRule[];
  /** Observability hook fired only when a rule actually decided. */
  onRuleDecision?:
    | ((ruleId: string, request: BrainDecisionRequest, decision: BrainDecision) => void)
    | undefined;
  /**
   * Bus for the `brain.tier_transition` step this tier records when a rule
   * actually decides. Without it a rule-settled decision reaches the trace
   * with no steps at all — indistinguishable from a decision that never
   * entered the ladder.
   */
  events?: EventBus | undefined;
}

/**
 * Deterministic rule tier. Sits in front of the policy tier so a configured
 * rule can settle a question before any of the tiers that cost tokens.
 */
export function createRuleBrainArbiter(opts: RuleBrainArbiterOptions): BrainArbiter {
  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const startedAt = Date.now();
      const hit = evaluateBrainRules(opts.getRules(), request);
      if (hit) {
        markDecisionTier(request, 'rule');
        emitBrainTierTransition(
          opts.events,
          request,
          'rule',
          hit.decision.type,
          true,
          startedAt,
          `rule "${hit.ruleId}" matched`,
        );
        opts.onRuleDecision?.(hit.ruleId, request, hit.decision);
        return hit.decision;
      }
      return opts.inner.decide(request);
    },
  };
}
