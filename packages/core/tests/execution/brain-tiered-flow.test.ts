import { describe, expect, it, vi } from 'vitest';
import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from '../../src/brain/brain.js';
import { DefaultBrainArbiter } from '../../src/brain/brain.js';
import {
  type BrainAutoRisk,
  createTieredBrainArbiter,
} from '../../src/execution/autonomy-brain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 't1',
  source: 'system',
  question: 'Should we continue?',
  risk: 'medium',
  fallback: 'ask_human',
  ...over,
});

/** A stub arbiter that returns a fixed decision. */
function stubArbiter(decision: BrainDecision): BrainArbiter {
  return { decide: vi.fn(async () => decision) };
}

/** A stub arbiter that throws on decide(). */
function throwingArbiter(): BrainArbiter {
  return {
    decide: vi.fn(async () => {
      throw new Error('layer down');
    }),
  };
}

const answer = (text: string, optionId?: string): BrainDecision => ({
  type: 'answer',
  text,
  ...(optionId ? { optionId } : {}),
});

const deny = (reason: string): BrainDecision => ({ type: 'deny', reason });
const askHuman = (question: string): BrainDecision => ({ type: 'ask_human', question });

// ---------------------------------------------------------------------------
// Tier 1: Policy layer pass-through
// ---------------------------------------------------------------------------

describe('tiered brain — policy layer', () => {
  it('policy deny passes through directly', async () => {
    const policy = stubArbiter(deny('Too dangerous'));
    const tiered = createTieredBrainArbiter({ policy });
    const d = await tiered.decide(req());
    expect(d).toEqual(deny('Too dangerous'));
  });

  it('policy answer with optionId passes through directly', async () => {
    const policy = stubArbiter(answer('Continue.', 'continue'));
    const tiered = createTieredBrainArbiter({ policy });
    const d = await tiered.decide(req());
    expect(d).toEqual(answer('Continue.', 'continue'));
  });

  it('policy ask_human with ceiling off returns the policy decision (escalation)', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const tiered = createTieredBrainArbiter({
      policy,
      getMaxAutoRisk: () => 'off' as BrainAutoRisk,
    });
    const d = await tiered.decide(req());
    expect(d).toEqual(askHuman('Need human input'));
  });

  it('policy ask_human with risk above ceiling returns the policy decision', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const tiered = createTieredBrainArbiter({
      policy,
      autonomous: stubArbiter(answer('LLM says go')),
      getMaxAutoRisk: () => 'low' as BrainAutoRisk,
    });
    // risk 'high' > ceiling 'low' → escalation
    const d = await tiered.decide(req({ risk: 'high' }));
    expect(d).toEqual(askHuman('Need human input'));
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Council layer
// ---------------------------------------------------------------------------

describe('tiered brain — council layer', () => {
  it('council decides high-risk requests at or above the council floor', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const council = stubArbiter(answer('Council approves.', 'council-yes'));
    const tiered = createTieredBrainArbiter({
      policy,
      council,
      getCouncilMinRisk: () => 'high',
      autonomous: stubArbiter(answer('LLM says go')),
      getMaxAutoRisk: () => 'all' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'high' }));
    expect(d).toEqual(answer('Council approves.', 'council-yes'));
    expect(council.decide).toHaveBeenCalledTimes(1);
  });

  it('council is NOT consulted for requests below the council floor', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const council = stubArbiter(answer('Council approves.'));
    const llm = stubArbiter(answer('LLM says go'));
    const tiered = createTieredBrainArbiter({
      policy,
      council,
      getCouncilMinRisk: () => 'high',
      autonomous: llm,
      getMaxAutoRisk: () => 'all' as BrainAutoRisk,
    });
    // risk 'medium' < council floor 'high' → skip council, go to LLM
    const d = await tiered.decide(req({ risk: 'medium' }));
    expect(d).toEqual(answer('LLM says go'));
    expect(council.decide).not.toHaveBeenCalled();
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });

  it('council deny is terminal — does NOT fall through to LLM', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const council = stubArbiter(deny('Council vetoes'));
    const llm = stubArbiter(answer('LLM says go'));
    const tiered = createTieredBrainArbiter({
      policy,
      council,
      getCouncilMinRisk: () => 'high',
      autonomous: llm,
      getMaxAutoRisk: () => 'all' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'critical' }));
    expect(d).toEqual(deny('Council vetoes'));
    expect(llm.decide).not.toHaveBeenCalled();
  });

  it('council ask_human falls through to the LLM tier', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const council = stubArbiter(askHuman('Council cannot decide'));
    const llm = stubArbiter(answer('LLM says go'));
    const tiered = createTieredBrainArbiter({
      policy,
      council,
      getCouncilMinRisk: () => 'high',
      autonomous: llm,
      getMaxAutoRisk: () => 'all' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'high' }));
    expect(d).toEqual(answer('LLM says go'));
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });

  it('council failure degrades to the LLM tier', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const council = throwingArbiter();
    const llm = stubArbiter(answer('LLM says go'));
    const tiered = createTieredBrainArbiter({
      policy,
      council,
      getCouncilMinRisk: () => 'high',
      autonomous: llm,
      getMaxAutoRisk: () => 'all' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'high' }));
    expect(d).toEqual(answer('LLM says go'));
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 3: LLM layer
// ---------------------------------------------------------------------------

describe('tiered brain — LLM layer', () => {
  it('LLM answer short-circuits (does not escalate)', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const llm = stubArbiter(answer('LLM says continue'));
    const tiered = createTieredBrainArbiter({
      policy,
      autonomous: llm,
      getMaxAutoRisk: () => 'medium' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'medium' }));
    expect(d).toEqual(answer('LLM says continue'));
  });

  it('LLM deny falls through to escalation (returns policy decision)', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const llm = stubArbiter(deny('LLM denies'));
    const tiered = createTieredBrainArbiter({
      policy,
      autonomous: llm,
      getMaxAutoRisk: () => 'medium' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'medium' }));
    // LLM deny is NOT an answer → falls through to policy decision
    expect(d).toEqual(askHuman('Need human input'));
  });

  it('LLM failure falls through to escalation (returns policy decision)', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const llm = throwingArbiter();
    const tiered = createTieredBrainArbiter({
      policy,
      autonomous: llm,
      getMaxAutoRisk: () => 'medium' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'medium' }));
    expect(d).toEqual(askHuman('Need human input'));
  });

  it('no autonomous layer → policy decision returned as escalation', async () => {
    const policy = stubArbiter(askHuman('Need human input'));
    const tiered = createTieredBrainArbiter({
      policy,
      getMaxAutoRisk: () => 'medium' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'medium' }));
    expect(d).toEqual(askHuman('Need human input'));
  });
});

// ---------------------------------------------------------------------------
// Provisional continue (policy echoes fallback, no optionId)
// ---------------------------------------------------------------------------

describe('tiered brain — provisional continue', () => {
  it('provisional continue (fallback=continue, no optionId) is forwarded to the LLM tier', async () => {
    // DefaultBrainArbiter with fallback='continue' and no options produces
    // a provisional continue: { type: 'answer', text: 'Continue with the
    // caller default.' } with NO optionId.
    const policy = new DefaultBrainArbiter();
    const llm = stubArbiter(answer('LLM says keep going'));
    const tiered = createTieredBrainArbiter({
      policy,
      autonomous: llm,
      getMaxAutoRisk: () => 'medium' as BrainAutoRisk,
    });
    const d = await tiered.decide(
      req({ question: 'Should we proceed?', fallback: 'continue', risk: 'medium' }),
    );
    // The provisional continue is NOT terminal — the LLM tier is consulted.
    expect(d).toEqual(answer('LLM says keep going'));
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });

  it('provisional continue with ceiling off returns the provisional answer', async () => {
    const policy = new DefaultBrainArbiter();
    const tiered = createTieredBrainArbiter({
      policy,
      autonomous: stubArbiter(answer('LLM says go')),
      getMaxAutoRisk: () => 'off' as BrainAutoRisk,
    });
    const d = await tiered.decide(
      req({ question: 'Should we proceed?', fallback: 'continue', risk: 'medium' }),
    );
    // Ceiling off → the provisional continue is returned as-is.
    expect(d).toMatchObject({ type: 'answer', text: 'Continue with the caller default.' });
  });
});

// ---------------------------------------------------------------------------
// Full flow: policy → council → LLM → escalation
// ---------------------------------------------------------------------------

describe('tiered brain — full flow integration', () => {
  it('low-risk with recommended option → policy answers directly (no council, no LLM)', async () => {
    const policy = new DefaultBrainArbiter();
    const council = stubArbiter(answer('Council approves.'));
    const llm = stubArbiter(answer('LLM says go'));
    const tiered = createTieredBrainArbiter({
      policy,
      council,
      autonomous: llm,
      getCouncilMinRisk: () => 'high',
      getMaxAutoRisk: () => 'all' as BrainAutoRisk,
    });
    const d = await tiered.decide(
      req({
        risk: 'low',
        options: [
          { id: 'continue', label: 'Continue', recommended: true, risk: 'low' },
          { id: 'stop', label: 'Stop', risk: 'low' },
        ],
      }),
    );
    expect(d).toMatchObject({ type: 'answer', optionId: 'continue' });
    expect(council.decide).not.toHaveBeenCalled();
    expect(llm.decide).not.toHaveBeenCalled();
  });

  it('high-risk ask_human → council decides (LLM not consulted)', async () => {
    const policy = new DefaultBrainArbiter();
    const council = stubArbiter(answer('Council approves the risky action.', 'council-yes'));
    const llm = stubArbiter(answer('LLM says go'));
    const tiered = createTieredBrainArbiter({
      policy,
      council,
      autonomous: llm,
      getCouncilMinRisk: () => 'high',
      getMaxAutoRisk: () => 'all' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'high' }));
    expect(d).toEqual(answer('Council approves the risky action.', 'council-yes'));
    expect(llm.decide).not.toHaveBeenCalled();
  });

  it('medium-risk ask_human → council skipped (below floor), LLM decides', async () => {
    const policy = new DefaultBrainArbiter();
    const council = stubArbiter(answer('Council approves.'));
    const llm = stubArbiter(answer('LLM says continue'));
    const tiered = createTieredBrainArbiter({
      policy,
      council,
      autonomous: llm,
      getCouncilMinRisk: () => 'high',
      getMaxAutoRisk: () => 'all' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'medium' }));
    expect(d).toEqual(answer('LLM says continue'));
    expect(council.decide).not.toHaveBeenCalled();
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });

  it('critical-risk ask_human + council failure + LLM failure → escalation', async () => {
    const policy = new DefaultBrainArbiter();
    const council = throwingArbiter();
    const llm = throwingArbiter();
    const tiered = createTieredBrainArbiter({
      policy,
      council,
      autonomous: llm,
      getCouncilMinRisk: () => 'high',
      getMaxAutoRisk: () => 'all' as BrainAutoRisk,
    });
    const d = await tiered.decide(req({ risk: 'critical' }));
    // Both council and LLM fail → falls through to policy decision (ask_human).
    expect(d).toMatchObject({ type: 'ask_human' });
  });

  it('blocked-resolved heuristic in policy → provisional continue → LLM consulted', async () => {
    const policy = new DefaultBrainArbiter();
    const llm = stubArbiter(answer('LLM confirms: proceed with the unblocked work'));
    const tiered = createTieredBrainArbiter({
      policy,
      autonomous: llm,
      getMaxAutoRisk: () => 'medium' as BrainAutoRisk,
    });
    // The blocked-resolved heuristic fires in the policy layer, producing a
    // provisional continue (fallback='continue', no optionId). The tiered
    // brain forwards this to the LLM tier.
    const d = await tiered.decide(
      req({
        question: 'The build is blocked by a missing dependency',
        context: 'The dependency has been resolved and merged',
        fallback: 'continue',
        risk: 'medium',
      }),
    );
    expect(d).toEqual(answer('LLM confirms: proceed with the unblocked work'));
    expect(llm.decide).toHaveBeenCalledTimes(1);
  });
});
