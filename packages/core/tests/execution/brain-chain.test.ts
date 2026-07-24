import { describe, expect, it, vi } from 'vitest';
import type { BrainDecisionRequest } from '../../src/coordination/brain.js';
import { assembleBrainTiers } from '../../src/execution/brain-chain.js';
import type { BrainConfig } from '../../src/types/config.js';
import type { Provider } from '../../src/types/provider.js';

const req = (over: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest => ({
  id: 'a1',
  source: 'system',
  question: 'Is the goal complete?',
  risk: 'medium',
  fallback: 'ask_human',
  ...over,
});

function fakeProvider(text: string): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => ({ content: [{ type: 'text', text }] })),
  } as never as Provider;
}

const baseOpts = (brainConfig: BrainConfig | undefined, sessionProvider: Provider) => ({
  brainConfig,
  defaultProviderId: 'session-prov',
  sessionProvider: () => sessionProvider,
  sessionModel: () => 'session-model',
});

describe('assembleBrainTiers', () => {
  it('without config: session-model single tier, no council, no pool labels', async () => {
    const session = fakeProvider('Continue execution.');
    const tiers = assembleBrainTiers({
      ...baseOpts(undefined, session),
      resolveProvider: vi.fn(() => null),
    });
    expect(tiers.poolLabels).toEqual([]);
    expect(tiers.councilLabels).toEqual([]);
    expect(tiers.council).toBeUndefined();
    expect(tiers.getCouncilMinRisk()).toBe('high');
    const d = await tiers.autonomous.decide(req());
    expect(session.complete).toHaveBeenCalled();
    expect(d).toMatchObject({ type: 'answer' });
  });

  it('resolves "provider/model" pool refs and derives council seats from the pool', () => {
    const session = fakeProvider('x');
    const resolveProvider = vi.fn(() => fakeProvider('y'));
    const tiers = assembleBrainTiers({
      ...baseOpts(
        {
          models: ['prov-a/model-a', 'prov-b/model-b', 'model-c'],
        },
        session,
      ),
      resolveProvider,
    });
    expect(tiers.poolLabels).toEqual([
      'prov-a/model-a',
      'prov-b/model-b',
      'session-prov/model-c',
    ]);
    // Council auto-derives from a ≥2-model pool with default personas.
    expect(tiers.council).toBeDefined();
    expect(tiers.councilLabels).toEqual([
      'prov-a/model-a (executor)',
      'prov-b/model-b (skeptic, veto)',
      'session-prov/model-c (auditor)',
    ]);
    // The bare "model-c" entry uses the session provider, not resolveProvider.
    expect(resolveProvider).toHaveBeenCalledTimes(2);
  });

  it('skips unresolvable pool entries instead of failing', () => {
    const tiers = assembleBrainTiers({
      ...baseOpts({ models: ['bad/x', 'good/y'] }, fakeProvider('s')),
      resolveProvider: (id) => (id === 'bad' ? null : fakeProvider('ok')),
    });
    expect(tiers.poolLabels).toEqual(['good/y']);
    // A single surviving model is not enough for a council.
    expect(tiers.council).toBeUndefined();
  });

  it('honors council.enabled=false even with a big pool', () => {
    const tiers = assembleBrainTiers({
      ...baseOpts(
        { models: ['a/x', 'b/y', 'c/z'], council: { enabled: false } },
        fakeProvider('s'),
      ),
      resolveProvider: () => fakeProvider('ok'),
    });
    expect(tiers.council).toBeUndefined();
    expect(tiers.councilLabels).toEqual([]);
  });

  it('explicit voters override pool-derived seats and keep their persona/veto', () => {
    const tiers = assembleBrainTiers({
      ...baseOpts(
        {
          council: {
            voters: [
              'a/x',
              { provider: 'b', model: 'y', persona: 'security', veto: true },
            ],
            minRisk: 'critical',
          },
        },
        fakeProvider('s'),
      ),
      resolveProvider: () => fakeProvider('ok'),
    });
    expect(tiers.council).toBeDefined();
    expect(tiers.councilLabels).toEqual(['a/x (executor)', 'b/y (security, veto)']);
    expect(tiers.getCouncilMinRisk()).toBe('critical');
  });

  describe('judge independence', () => {
    // The judge only runs to break a tie or synthesize a split panel. If it is
    // one of the seats that produced the tie, it re-states its own vote with
    // the deciding weight — an expensive way to let voter #1 win.
    it('derives the judge from a pool target that is NOT seated', () => {
      const tiers = assembleBrainTiers({
        ...baseOpts({ models: ['a/x', 'b/y', 'c/z', 'd/w'] }, fakeProvider('s')),
        resolveProvider: () => fakeProvider('ok'),
      });
      // Seats take the first three pool entries; the judge must not be one.
      expect(tiers.councilLabels).toEqual([
        'a/x (executor)',
        'b/y (skeptic, veto)',
        'c/z (auditor)',
      ]);
      expect(tiers.judgeLabel).toBe('d/w');
    });

    it('honours an explicitly configured judge even when it is also a voter', () => {
      const tiers = assembleBrainTiers({
        ...baseOpts(
          { models: ['a/x', 'b/y', 'c/z', 'd/w'], council: { judge: 'a/x' } },
          fakeProvider('s'),
        ),
        resolveProvider: () => fakeProvider('ok'),
      });
      expect(tiers.judgeLabel).toBe('a/x');
    });

    it('falls back to the first pool target when every target is seated', () => {
      // Pool size == seat count leaves nothing independent to promote. The
      // panel is still correlated, but that is now reported through the
      // council distinctness warnings rather than silently accepted here.
      const tiers = assembleBrainTiers({
        ...baseOpts({ models: ['a/x', 'b/y', 'c/z'] }, fakeProvider('s')),
        resolveProvider: () => fakeProvider('ok'),
      });
      expect(tiers.judgeLabel).toBe('a/x');
    });

    it('reports no judge when no council is wired', () => {
      const tiers = assembleBrainTiers({
        ...baseOpts({ models: ['a/x'] }, fakeProvider('s')),
        resolveProvider: () => fakeProvider('ok'),
      });
      expect(tiers.council).toBeUndefined();
      expect(tiers.judgeLabel).toBeUndefined();
    });
  });
});
