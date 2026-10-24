/**
 * Brain decision explainer and dry-run simulation.
 *
 * Autonomy workloads and operators need to inspect why a decision was made
 * at a specific tier (or why it will be routed to a specific tier) without
 * triggering side effects, firing events, or mutating cache and ledger states.
 *
 * @module brain-explain
 */

import type {
  BrainDecision,
  BrainDecisionRequest,
  BrainEscalationMode,
  BrainRisk,
  BrainTerminalPolicy,
} from './brain.js';
import { DefaultBrainArbiter, terminalPolicyDecision } from './brain.js';
import type { BrainDecisionCache } from './brain-cache.js';
import type { BrainHeuristicsConfig } from './brain-heuristics.js';
import { evaluateQuickBrainDecision } from './brain-quick-decision.js';
import { type BrainAutoRisk, brainTierEligibility } from './brain-risk.js';
import type { CompiledBrainRule } from './brain-rules.js';
import { applyRule, ruleMatches } from './brain-rules.js';

export interface BrainExplainLedgerHost {
  isEnabled(): boolean;
  failureStreakFor?:
    | ((request: Pick<BrainDecisionRequest, 'source' | 'question' | 'id'>) => number)
    | undefined;
}

export interface BrainExplainContext {
  ledger?: BrainExplainLedgerHost | undefined;
  ledgerAutoDenyAfterFailures?: number | undefined;
  cache?: Pick<BrainDecisionCache, 'isEnabled' | 'peek'> | undefined;
  rules?: readonly CompiledBrainRule[] | undefined;
  peekRule?:
    | ((request: BrainDecisionRequest) => { decision: BrainDecision; ruleId: string } | null)
    | undefined;
  systemOneEnabled?: boolean | undefined;
  llmCircuitOpen?: boolean | undefined;
  llmDenyIsTerminal?: 'never' | 'when-decided' | 'always' | undefined;
  heuristics?: BrainHeuristicsConfig | undefined;
  maxAutoRisk?: BrainAutoRisk | BrainRisk | undefined;
  council?:
    | {
        enabled?: boolean | undefined;
        minRisk?: 'medium' | 'high' | 'critical' | undefined;
      }
    | undefined;
  mode?: BrainEscalationMode | undefined;
  terminalPolicy?: BrainTerminalPolicy | undefined;
}

export type BrainDecisionTierName =
  | 'ledger_guard'
  | 'cache'
  | 'rule'
  | 'heuristic'
  | 'policy'
  | 'system-one'
  | 'llm'
  | 'risk_gate'
  | 'terminal';

export interface BrainDecisionStepExplanation {
  tier: BrainDecisionTierName;
  status: 'settled' | 'passed' | 'skipped' | 'disabled';
  reason: string;
  decision?: BrainDecision | undefined;
}

export interface BrainDecisionExplanation {
  request: BrainDecisionRequest;
  steps: BrainDecisionStepExplanation[];
  verdict: {
    settledDeterministically: boolean;
    resolvingTier?: BrainDecisionTierName | undefined;
    decision?: BrainDecision | undefined;
    nextTierIfNotSettled?: 'council' | 'autonomous_llm' | 'system-one' | 'ask_human' | undefined;
    reason: string;
  };
}

/**
 * Perform a pure, side-effect-free dry run of the deterministic decision pipeline.
 */
export function explainBrainDecision(
  request: BrainDecisionRequest,
  ctx: BrainExplainContext = {},
): BrainDecisionExplanation {
  const steps: BrainDecisionStepExplanation[] = [];

  // 1. Ledger Guard Stage
  if (ctx.ledger?.isEnabled() && ctx.ledger.failureStreakFor) {
    const streak = ctx.ledger.failureStreakFor(request);
    const threshold = ctx.ledgerAutoDenyAfterFailures ?? 3;
    if (threshold > 0 && streak >= threshold) {
      const decision: BrainDecision = {
        type: 'deny',
        reason:
          `Ledger guard auto-denied: ${streak} consecutive failures recorded for similar decisions ` +
          `(source: ${request.source}, question: "${request.question}").`,
      };
      steps.push({
        tier: 'ledger_guard',
        status: 'settled',
        reason: `Ledger guard auto-deny triggered: ${streak} consecutive failures recorded (threshold: ${threshold}).`,
        decision,
      });
      return {
        request,
        steps,
        verdict: {
          settledDeterministically: true,
          resolvingTier: 'ledger_guard',
          decision,
          reason: `Vetoed by ledger guard failure streak (${streak} >= ${threshold}).`,
        },
      };
    }
    steps.push({
      tier: 'ledger_guard',
      status: 'passed',
      reason: `Failure streak (${streak}) is below auto-deny threshold (${threshold}).`,
    });
  } else {
    steps.push({
      tier: 'ledger_guard',
      status: 'disabled',
      reason: 'Ledger guard is disabled or unconfigured.',
    });
  }

  // 2. Decision Cache Stage
  if (ctx.cache?.isEnabled()) {
    const cachedDecision = ctx.cache.peek(request);
    if (cachedDecision) {
      steps.push({
        tier: 'cache',
        status: 'settled',
        reason: 'Cached verdict available for normalized request.',
        decision: cachedDecision,
      });
      return {
        request,
        steps,
        verdict: {
          settledDeterministically: true,
          resolvingTier: 'cache',
          decision: cachedDecision,
          reason: 'Replayed cached verdict.',
        },
      };
    }
    steps.push({
      tier: 'cache',
      status: 'passed',
      reason: 'Cache miss (no unexpired entry found for request).',
    });
  } else {
    steps.push({
      tier: 'cache',
      status: 'disabled',
      reason: 'Decision cache is disabled or unconfigured.',
    });
  }

  // 3. Rule Tier Stage
  if (ctx.rules && ctx.rules.length > 0) {
    let matchedRule: CompiledBrainRule | undefined;
    for (const rule of ctx.rules) {
      if (ruleMatches(rule, request)) {
        matchedRule = rule;
        break;
      }
    }
    if (matchedRule) {
      const decision = ctx.peekRule
        ? ctx.peekRule(request)?.decision
        : applyRule(matchedRule, request);
      if (decision) {
        steps.push({
          tier: 'rule',
          status: 'settled',
          reason: `Rule "${matchedRule.id}" matched and produced a decision.`,
          decision,
        });
        return {
          request,
          steps,
          verdict: {
            settledDeterministically: true,
            resolvingTier: 'rule',
            decision,
            reason: `Configured rule "${matchedRule.id}" resolved the request.`,
          },
        };
      }
      steps.push({
        tier: 'rule',
        status: 'passed',
        reason: `Rule "${matchedRule.id}" matched but deferred or produced no immediate action.`,
      });
    } else {
      steps.push({
        tier: 'rule',
        status: 'passed',
        reason: 'No configured rules matched this request.',
      });
    }
  } else {
    steps.push({
      tier: 'rule',
      status: 'disabled',
      reason: 'No rules configured.',
    });
  }

  // The same policy evaluation and eligibility functions drive the real ladder.
  const policy = new DefaultBrainArbiter({ heuristics: ctx.heuristics }).evaluate(request);
  const provisional =
    policy.decision.type === 'answer' &&
    policy.decision.optionId === undefined &&
    request.fallback === 'continue';
  const settle = (
    tier: BrainDecisionTierName,
    decision: BrainDecision,
    reason: string,
  ): BrainDecisionExplanation => {
    steps.push({ tier, status: 'settled', reason, decision });
    return {
      request,
      steps,
      verdict: { settledDeterministically: true, resolvingTier: tier, decision, reason },
    };
  };
  if (policy.decision.type !== 'ask_human' && !provisional) {
    return settle(policy.tier, policy.decision, 'The default policy resolved this request.');
  }
  steps.push({
    tier: 'policy',
    status: 'passed',
    reason: provisional
      ? 'Caller continuation is provisional; subsequent tiers may decide.'
      : 'Policy requires escalation.',
  });
  const eligible = brainTierEligibility(
    request,
    ctx.maxAutoRisk,
    ctx.council?.enabled ?? false,
    ctx.council?.minRisk ?? 'high',
  );
  let nextTier: 'council' | 'autonomous_llm' | 'system-one' | 'ask_human';
  let nextReason: string;
  if (!eligible.autonomous) {
    if (policy.decision.type !== 'ask_human')
      return settle(
        policy.tier,
        policy.decision,
        'Autonomy is outside the ceiling; the caller policy resolves this request.',
      );
    nextTier = 'ask_human';
    nextReason = `Request risk "${request.risk}" exceeds maxAutoRisk "${ctx.maxAutoRisk ?? 'medium'}".`;
  } else if (eligible.systemOne && ctx.systemOneEnabled) {
    nextTier = 'system-one';
    nextReason =
      'Jev may settle this option request; insufficient evidence defers to the remaining ladder.';
  } else if (eligible.council) {
    nextTier = 'council';
    nextReason = 'Request is within the autonomy ceiling and meets the council risk floor.';
  } else {
    const heuristic = evaluateQuickBrainDecision(request, ctx.heuristics);
    if (heuristic)
      return settle('heuristic', heuristic, 'The autonomous heuristic resolved this request.');
    if (ctx.llmCircuitOpen) {
      if (ctx.llmDenyIsTerminal === 'always')
        return settle(
          'llm',
          {
            type: 'deny',
            reason: 'Autonomy Brain LLM tier is circuit-broken after repeated failures.',
          },
          'The configured denial policy makes the circuit-broken result terminal.',
        );
      if (policy.decision.type !== 'ask_human')
        return settle(
          policy.tier,
          policy.decision,
          'The LLM pool is circuit-broken; the caller policy resolves this request.',
        );
      nextTier = 'ask_human';
      nextReason = 'The LLM pool is circuit-broken and cannot be consulted.';
    } else {
      nextTier = 'autonomous_llm';
      nextReason = 'Request is eligible for the autonomous LLM pool.';
    }
  }
  steps.push({ tier: 'risk_gate', status: 'passed', reason: nextReason });

  // 6. Terminal Escalation Stage (Headless Mode Simulation)
  if (
    nextTier === 'ask_human' &&
    (ctx.mode === 'headless' || request.allowHumanEscalation === false)
  ) {
    const termPolicy = ctx.terminalPolicy ?? 'conservative';
    const termDecision = terminalPolicyDecision(request, termPolicy);
    steps.push({
      tier: 'terminal',
      status: 'settled',
      reason: `Headless mode or human escalation disallowed: resolved deterministically by terminal policy "${termPolicy}".`,
      decision: termDecision,
    });
    return {
      request,
      steps,
      verdict: {
        settledDeterministically: true,
        resolvingTier: 'terminal',
        decision: termDecision,
        reason: `Terminal policy "${termPolicy}" resolved the escalation without human prompt.`,
      },
    };
  }

  // Fallthrough to non-deterministic tier
  return {
    request,
    steps,
    verdict: {
      settledDeterministically: false,
      nextTierIfNotSettled: nextTier,
      reason: nextReason,
    },
  };
}
