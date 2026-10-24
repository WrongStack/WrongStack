import type { Provider } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import type { BrainDecisionRequest } from '../../src/brain/brain.js';
import { BrainDecisionCache } from '../../src/brain/brain-cache.js';
import { type BrainExplainContext, explainBrainDecision } from '../../src/brain/brain-explain.js';
import { compileBrainRules } from '../../src/brain/brain-rules.js';
import { createBrainRuntime } from '../../src/execution/brain-runtime.js';

function makeRequest(partial: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest {
  return {
    id: 'req-1',
    source: 'tool',
    question: 'Should the subagent proceed with database cleanup?',
    risk: 'medium',
    fallback: 'ask_human',
    ...partial,
  };
}

describe('explainBrainDecision', () => {
  it('explains ledger guard veto when failure streak meets or exceeds threshold', () => {
    const req = makeRequest();
    const ctx: BrainExplainContext = {
      ledger: {
        isEnabled: () => true,
        failureStreakFor: () => 3,
      },
      ledgerAutoDenyAfterFailures: 3,
    };

    const explanation = explainBrainDecision(req, ctx);

    expect(explanation.verdict.settledDeterministically).toBe(true);
    expect(explanation.verdict.resolvingTier).toBe('ledger_guard');
    expect(explanation.verdict.decision?.type).toBe('deny');
    expect(explanation.steps[0]).toMatchObject({
      tier: 'ledger_guard',
      status: 'settled',
    });
  });

  it('explains ledger guard pass when failure streak is below threshold', () => {
    const req = makeRequest();
    const ctx: BrainExplainContext = {
      ledger: {
        isEnabled: () => true,
        failureStreakFor: () => 1,
      },
      ledgerAutoDenyAfterFailures: 3,
    };

    const explanation = explainBrainDecision(req, ctx);

    expect(explanation.steps[0]).toMatchObject({
      tier: 'ledger_guard',
      status: 'passed',
    });
    expect(explanation.verdict.settledDeterministically).toBe(false);
  });

  it('explains cache hit without mutating cache state or stats', () => {
    const req = makeRequest();
    const cache = new BrainDecisionCache({ enabled: true });
    cache.set(req, { type: 'answer', text: 'Clean up confirmed' }, 'llm');

    const ctx: BrainExplainContext = { cache };
    const explanation = explainBrainDecision(req, ctx);

    expect(explanation.verdict.settledDeterministically).toBe(true);
    expect(explanation.verdict.resolvingTier).toBe('cache');
    expect(explanation.verdict.decision).toMatchObject({
      type: 'answer',
      text: 'Clean up confirmed',
    });

    // Verify stats were NOT incremented (pure inspection)
    expect(cache.snapshot().hits).toBe(0);
  });

  it('explains rule match and settling', () => {
    const req = makeRequest({ question: 'Run git reset --hard' });
    const { rules } = compileBrainRules([
      {
        id: 'deny-hard-reset',
        when: { question: 'git reset --hard' },
        // biome-ignore lint/suspicious/noThenProperty: BrainRule's domain contract names this action field `then`.
        then: { action: 'deny', reason: 'Hard reset is not permitted automatically.' },
      },
    ]);

    const ctx: BrainExplainContext = { rules };
    const explanation = explainBrainDecision(req, ctx);

    expect(explanation.verdict.settledDeterministically).toBe(true);
    expect(explanation.verdict.resolvingTier).toBe('rule');
    expect(explanation.verdict.decision?.type).toBe('deny');
  });

  it('explains low-risk recommended option heuristic', () => {
    const req = makeRequest({
      risk: 'low',
      options: [
        { id: 'opt1', label: 'Proceed with default', recommended: true },
        { id: 'opt2', label: 'Cancel' },
      ],
    });

    const explanation = explainBrainDecision(req, {
      heuristics: { lowRiskAutoAnswer: true },
    });

    expect(explanation.verdict.settledDeterministically).toBe(true);
    expect(explanation.verdict.resolvingTier).toBe('heuristic');
    expect(explanation.verdict.decision).toMatchObject({
      type: 'answer',
      optionId: 'opt1',
      text: 'Proceed with default',
    });
  });

  it('explains blocked dependency resolved heuristic', () => {
    const req = makeRequest({
      question: 'dependency blocked',
      context: 'blocked dependency is now resolved and ready',
      fallback: 'continue',
      options: [],
    });

    const explanation = explainBrainDecision(req, {
      heuristics: { blockedResolved: true },
    });

    expect(explanation.verdict.settledDeterministically).toBe(true);
    expect(explanation.verdict.resolvingTier).toBe('heuristic');
    expect(explanation.verdict.decision).toMatchObject({
      type: 'answer',
      text: expect.stringContaining('Blocker resolved'),
    });
  });

  it('explains routing to council for high-risk requests when council is enabled', () => {
    const req = makeRequest({ risk: 'high' });
    const ctx: BrainExplainContext = {
      council: { enabled: true, minRisk: 'high' },
      maxAutoRisk: 'high',
    };

    const explanation = explainBrainDecision(req, ctx);

    expect(explanation.verdict.settledDeterministically).toBe(false);
    expect(explanation.verdict.nextTierIfNotSettled).toBe('council');
  });

  it('explains routing to autonomous LLM pool when within maxAutoRisk and council is disabled', () => {
    const req = makeRequest({ risk: 'medium' });
    const ctx: BrainExplainContext = {
      council: { enabled: false },
      maxAutoRisk: 'medium',
    };

    const explanation = explainBrainDecision(req, ctx);

    expect(explanation.verdict.settledDeterministically).toBe(false);
    expect(explanation.verdict.nextTierIfNotSettled).toBe('autonomous_llm');
  });

  it('explains deterministic terminal policy resolution when in headless mode', () => {
    const req = makeRequest({
      risk: 'critical',
      fallback: 'ask_human',
    });
    const ctx: BrainExplainContext = {
      mode: 'headless',
      terminalPolicy: 'conservative',
      maxAutoRisk: 'medium',
      council: { enabled: false },
    };

    const explanation = explainBrainDecision(req, ctx);

    expect(explanation.verdict.settledDeterministically).toBe(true);
    expect(explanation.verdict.resolvingTier).toBe('terminal');
    expect(explanation.verdict.decision?.type).toBe('deny');
  });
});

describe('BrainRuntime.explain', () => {
  const dummyProvider: Provider = {
    id: 'mock',
    chat: async () => ({ content: 'ok' }) as any,
  } as unknown as Provider;

  it('provides explain simulation via the live runtime', () => {
    const runtime = createBrainRuntime({
      initialConfig: {
        mode: 'interactive',
        maxAutoRisk: 'medium',
        rules: [
          {
            id: 'auto-ping',
            when: { question: 'ping heartbeat' },
            // biome-ignore lint/suspicious/noThenProperty: BrainRule's domain contract names this action field `then`.
            then: { action: 'answer', text: 'pong' },
          },
        ],
      },
      defaultProviderId: 'mock',
      sessionProvider: () => dummyProvider,
      sessionModel: () => 'mock-model',
      resolveProvider: () => dummyProvider,
    });

    const explanation = runtime.explain(makeRequest({ question: 'ping heartbeat' }));

    expect(explanation.verdict.settledDeterministically).toBe(true);
    expect(explanation.verdict.resolvingTier).toBe('rule');
    expect(explanation.verdict.decision).toMatchObject({
      type: 'answer',
      text: 'pong',
    });
  });
});
