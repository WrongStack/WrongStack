import { describe, expect, it } from 'vitest';
import { createCouncilPersonaRegistry } from '../../src/execution/council-personas.js';
import {
  BUILTIN_COUNCIL_PROFILES,
  CouncilProfileRegistry,
  createCouncilProfileRegistry,
  DEFAULT_COUNCIL_PROFILE_REGISTRY,
  normalizeCouncilProfile,
  resolveCouncilProfile,
} from '../../src/execution/council-profiles.js';

describe('Council profiles', () => {
  it('ships model-agnostic built-in profiles', () => {
    expect(BUILTIN_COUNCIL_PROFILES.map((profile) => profile.id)).toEqual([
      'balanced',
      'fast',
      'risk-review',
    ]);
    const balanced = DEFAULT_COUNCIL_PROFILE_REGISTRY.require('balanced');

    expect(balanced.seats.map((seat) => seat.persona)).toEqual(['executor', 'skeptic', 'auditor']);
    expect(balanced.seats[1]).toMatchObject({ id: 'skeptic', weight: 1, veto: true });
    expect(balanced.judge).toEqual({ role: 'reviewer' });
    expect(JSON.stringify(BUILTIN_COUNCIL_PROFILES)).not.toMatch(/openai|anthropic|deepseek/i);
    expect(Object.isFrozen(balanced)).toBe(true);
    expect(Object.isFrozen(balanced.seats)).toBe(true);
    expect(Object.isFrozen(balanced.seats[0]?.target)).toBe(true);
  });

  it('normalizes defaults and generates unique ids for repeated personas', () => {
    const profile = normalizeCouncilProfile({
      id: 'double-check',
      seats: [{ persona: 'skeptic' }, { persona: 'skeptic', veto: false }],
    });

    expect(profile).toMatchObject({
      id: 'double-check',
      name: 'double-check',
      description: '',
      judge: false,
      quorumFraction: 0.5,
      approvalFraction: 0.5,
      distinctness: 'model',
      voterMaxTokens: 300,
      judgeMaxTokens: 500,
      perCallTimeoutMs: 30_000,
      deliberationRounds: 2,
      // The overall budget covers EVERY round, so the default scales with the
      // round count — a 90s budget would abort a 2-round panel mid-debate.
      overallTimeoutMs: 180_000,
    });
    expect(profile.seats).toMatchObject([
      { id: 'skeptic', veto: true, weight: 1 },
      { id: 'skeptic-2', veto: false, weight: 1 },
    ]);
  });

  it('normalizes and freezes routing targets', () => {
    const profile = normalizeCouncilProfile({
      id: 'routed',
      seats: [
        {
          id: 'expert',
          label: ' Expert ',
          persona: 'maintainer',
          target: {
            providerId: ' provider ',
            model: ' model ',
            fallbackModels: [' fallback ', 'fallback', ''],
          },
          weight: 2,
        },
      ],
      judge: { role: ' reviewer ' },
    });

    expect(profile.seats[0]).toMatchObject({
      id: 'expert',
      label: 'Expert',
      weight: 2,
      target: {
        providerId: 'provider',
        model: 'model',
        fallbackModels: ['fallback'],
      },
    });
    expect(profile.judge).toEqual({ role: 'reviewer' });
    expect(Object.isFrozen(profile.seats[0]?.target)).toBe(true);
    expect(Object.isFrozen(profile.judge)).toBe(true);
  });

  it('resolves ids, defaults, and ad-hoc profiles', () => {
    expect(resolveCouncilProfile(undefined).id).toBe('balanced');
    expect(resolveCouncilProfile(undefined, { defaultProfile: 'fast' }).id).toBe('fast');
    expect(resolveCouncilProfile('risk-review').id).toBe('risk-review');
    expect(resolveCouncilProfile({ id: 'adhoc', seats: [{ persona: 'executor' }] }).id).toBe(
      'adhoc',
    );
  });

  it('extends registries without mutating built-ins', () => {
    const registry = createCouncilProfileRegistry([
      { id: 'custom', seats: [{ persona: 'user-advocate' }] },
    ]);

    expect(registry.has('balanced')).toBe(true);
    expect(registry.has('custom')).toBe(true);
    expect(DEFAULT_COUNCIL_PROFILE_REGISTRY.has('custom')).toBe(false);
    const replaced = registry.with(
      { id: 'custom', seats: [{ persona: 'maintainer' }] },
      { replace: true },
    );
    expect(replaced.require('custom').seats[0]?.persona).toBe('maintainer');
    expect(registry.require('custom').seats[0]?.persona).toBe('user-advocate');
  });

  it('retains a custom persona registry across copy-on-write extension', () => {
    const personas = createCouncilPersonaRegistry([
      {
        id: 'domain-expert',
        name: 'Domain Expert',
        description: 'Checks domain evidence.',
        instruction: 'Check domain evidence.',
      },
    ]);
    const registry = new CouncilProfileRegistry(
      [{ id: 'domain', seats: [{ persona: 'domain-expert' }] }],
      personas,
    );
    const extended = registry.with({
      id: 'domain-two',
      seats: [{ persona: 'domain-expert' }],
    });

    expect(extended.require('domain-two').seats[0]?.persona).toBe('domain-expert');
  });

  it.each([
    [{ id: 'Bad Id', seats: [{ persona: 'executor' }] }, /invalid profile id/],
    [{ id: 'empty', seats: [] }, /at least one seat/],
    [{ id: 'unknown', seats: [{ persona: 'missing' }] }, /unknown persona/],
    [
      {
        id: 'duplicate-seat',
        seats: [
          { id: 'same', persona: 'executor' },
          { id: 'same', persona: 'auditor' },
        ],
      },
      /duplicate seat id/,
    ],
    [{ id: 'weight', seats: [{ persona: 'executor', weight: 0 }] }, /invalid weight/],
    [{ id: 'quorum', seats: [{ persona: 'executor' }], quorumFraction: 0 }, /quorumFraction/],
    [
      { id: 'approval', seats: [{ persona: 'executor' }], approvalFraction: 1.1 },
      /approvalFraction/,
    ],
    [{ id: 'empty-target', seats: [{ persona: 'executor', target: {} }] }, /target is empty/],
    [
      {
        id: 'timeout',
        seats: [{ persona: 'executor' }],
        perCallTimeoutMs: 100,
        overallTimeoutMs: 50,
      },
      /overallTimeoutMs/,
    ],
  ] as const)('rejects malformed profile definitions', (profile, expected) => {
    expect(() => normalizeCouncilProfile(profile)).toThrow(expected);
  });

  it('rejects duplicate profile ids and unknown lookup', () => {
    const profile = { id: 'same', seats: [{ persona: 'executor' }] } as const;
    expect(() => new CouncilProfileRegistry([profile, profile])).toThrow(/duplicate profile id/);
    expect(() => DEFAULT_COUNCIL_PROFILE_REGISTRY.require('missing')).toThrow(/unknown profile/);
    expect(DEFAULT_COUNCIL_PROFILE_REGISTRY.get('missing')).toBeUndefined();
    expect(DEFAULT_COUNCIL_PROFILE_REGISTRY.get('balanced')?.id).toBe('balanced');
  });

  it('treats an explicit judge:false the same as omitting the judge', () => {
    const explicit = normalizeCouncilProfile({
      id: 'no-judge',
      seats: [{ persona: 'executor' }],
      judge: false,
    });
    const omitted = normalizeCouncilProfile({
      id: 'no-judge',
      seats: [{ persona: 'executor' }],
    });

    expect(explicit.judge).toBe(false);
    expect(omitted.judge).toBe(false);
  });

  it('rejects invalid budget values', () => {
    const invalid: Array<
      [Partial<import('../../src/types/council.js').CouncilProfileConfig>, RegExp]
    > = [
      [{ seats: [{ persona: 'executor' }], voterMaxTokens: 0 }, /voterMaxTokens/],
      [{ seats: [{ persona: 'executor' }], voterMaxTokens: 1.5 }, /voterMaxTokens/],
      [{ seats: [{ persona: 'executor' }], judgeMaxTokens: -1 }, /judgeMaxTokens/],
      [{ seats: [{ persona: 'executor' }], perCallTimeoutMs: 0 }, /perCallTimeoutMs/],
      [{ seats: [{ persona: 'executor' }], overallTimeoutMs: 0 }, /overallTimeoutMs/],
    ];
    for (const [overrides, expected] of invalid) {
      expect(() =>
        normalizeCouncilProfile({ id: 'budget', seats: [{ persona: 'executor' }], ...overrides }),
      ).toThrow(expected);
    }
  });

  it('rejects unsupported distinctness values', () => {
    expect(() =>
      normalizeCouncilProfile({
        id: 'unknown-distinctness',
        seats: [{ persona: 'executor' }],
        // @ts-expect-error – exercise runtime validation for an invalid distinctness label.
        distinctness: 'cluster',
      }),
    ).toThrow(/distinctness/);
  });
});

describe('Council profiles — deliberation rounds', () => {
  it('lets a profile opt out of deliberation', () => {
    const profile = normalizeCouncilProfile({
      id: 'single',
      seats: [{ persona: 'executor' }],
      deliberationRounds: 1,
    });
    expect(profile.deliberationRounds).toBe(1);
    // With one round the default budget is the pre-deliberation 90s.
    expect(profile.overallTimeoutMs).toBe(90_000);
  });

  it('keeps an explicitly configured overall budget', () => {
    const profile = normalizeCouncilProfile({
      id: 'explicit',
      seats: [{ persona: 'executor' }],
      deliberationRounds: 3,
      overallTimeoutMs: 45_000,
    });
    expect(profile.overallTimeoutMs).toBe(45_000);
  });

  it('rejects a round count above the ceiling', () => {
    expect(() =>
      normalizeCouncilProfile({
        id: 'runaway',
        seats: [{ persona: 'executor' }],
        deliberationRounds: 99,
      }),
    ).toThrow(/deliberationRounds must not exceed/);
  });

  it('rejects a non-positive round count', () => {
    expect(() =>
      normalizeCouncilProfile({
        id: 'zero',
        seats: [{ persona: 'executor' }],
        deliberationRounds: 0,
      }),
    ).toThrow(/deliberationRounds/);
  });
});
