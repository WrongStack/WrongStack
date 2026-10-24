import type { SkillEntry, SkillLoader, SkillManifest } from '@wrongstack/contracts/types/skill';
import { describe, expect, it, vi } from 'vitest';
import { createSkillSuggester } from '../../src/skills/suggest/skill-suggester.js';
import type {
  SystemOneRequest,
  SystemOneResult,
  TypeSafeClient,
} from '../../src/typesafe/client.js';

interface FakeSkill {
  name: string;
  trigger: string;
  description?: string;
  audience?: string;
  requiredTools?: string[];
  body?: string;
}

function loaderOf(skills: FakeSkill[]): SkillLoader {
  const manifests: SkillManifest[] = skills.map((s) => ({
    name: s.name,
    description: s.description ?? s.trigger,
    trigger: s.trigger,
    audience: s.audience,
    requiredTools: s.requiredTools,
    path: `/${s.name}/SKILL.md`,
    source: 'bundled',
  }));
  const entries: SkillEntry[] = skills.map((s) => ({
    name: s.name,
    trigger: s.trigger,
    scope: [],
    audience: s.audience,
    source: 'bundled',
    path: `/${s.name}/SKILL.md`,
  }));
  return {
    list: async () => manifests,
    listEntries: async () => entries,
    find: async (name) => manifests.find((m) => m.name === name),
    manifestText: async () => '',
    readBody: async (name) => skills.find((s) => s.name === name)?.body ?? `# ${name}`,
    readSaveBody: async (name) => `# ${name}`,
    invalidateCache: () => {},
  };
}

const ROSTER: FakeSkill[] = [
  { name: 'design-craft', trigger: 'building or reshaping UI', body: 'Visual design guidance.' },
  {
    name: 'design-critique',
    trigger: 'reviewing an existing UI',
    body: 'Critique an existing UI.',
  },
  { name: 'git-flow', trigger: 'branching and release flow', body: 'Branch naming, releases.' },
];

/** Answers keyed by the order in which passes are made: [pass1, pass2, ...]. */
function clientOf(...results: SystemOneResult[]): TypeSafeClient & { calls: SystemOneRequest[] } {
  const calls: SystemOneRequest[] = [];
  return {
    calls,
    async systemOne(req) {
      calls.push(req);
      const result = results[calls.length - 1];
      if (!result) throw new Error(`unexpected pass ${calls.length}`);
      return result;
    },
  };
}

function gate(value: number): SystemOneResult['answers'] {
  // `prose_suffices` is inverted, so a low value there pushes the mean UP.
  return {
    'gate::acts_on_user_system': { type: 'noul', noul: value },
    'gate::would_follow_documented_procedure': { type: 'noul', noul: value },
    'gate::prose_suffices': { type: 'noul', noul: 1 - value },
  };
}

function wide(gateValue: number, probabilities: Record<string, number>): SystemOneResult {
  return {
    answers: {
      which: {
        type: 'choice',
        choice: Object.keys(probabilities)[0] ?? '',
        probabilities,
        confidence: 0.8,
      },
      ...gate(gateValue),
    },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function rerank(winner: string, fits: Record<string, number>): SystemOneResult {
  const answers: SystemOneResult['answers'] = {
    which: {
      type: 'choice',
      choice: winner,
      probabilities: Object.fromEntries(
        Object.keys(fits).map((n) => [n, 1 / Object.keys(fits).length]),
      ),
      confidence: 0.7,
    },
  };
  for (const [name, value] of Object.entries(fits)) {
    answers[`fits::${name}`] = { type: 'noul', noul: value };
  }
  return { answers, usage: { inputTokens: 0, outputTokens: 0 } };
}

describe('createSkillSuggester', () => {
  it('excludes unavailable runtime candidates and keeps full description in the first pass', async () => {
    const client = clientOf(wide(0.1, { 'design-craft': 0.6, 'git-flow': 0.4 }));
    const roster = [
      ...ROSTER,
      { name: 'browser', trigger: 'Inspect a browser', requiredTools: ['browser_navigate'] },
    ];
    roster[0] = {
      ...ROSTER[0]!,
      description: 'Build an accessible interface. Do not use for critique.',
    };
    await createSkillSuggester({ client, loader: loaderOf(roster) }).explain(
      'Build an interface',
      undefined,
      { availableToolNames: [] },
    );
    const criteria = (client.calls[0]!.questions.which as { criteria: Record<string, string> })
      .criteria;
    expect(criteria).not.toHaveProperty('browser');
    expect(criteria['design-craft']).toContain('Do not use for critique.');
    expect(criteria['design-craft']).toContain('building or reshaping UI');
  });

  it('does not pass a partial gate as if all three judgments had answered', async () => {
    const partial = wide(0.9, { 'design-craft': 0.6, 'design-critique': 0.4 });
    delete partial.answers['gate::prose_suffices'];
    const client = clientOf(partial, rerank('design-craft', { 'design-craft': 0.9 }));
    const trace = await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).explain(
      'Build this UI',
    );
    expect(trace.stop).toBe('wide-failed');
    expect(client.calls).toHaveLength(1);
  });

  it('does not borrow another skill fit when the winner fit is missing', async () => {
    const client = clientOf(
      wide(0.9, { 'design-craft': 0.6, 'design-critique': 0.4 }),
      rerank('design-craft', { 'design-critique': 0.9 }),
    );
    const trace = await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).explain(
      'Build this UI',
    );
    expect(trace.stop).toBe('rerank-failed');
    expect(trace.suggestion).toBeUndefined();
  });
  it('suggests the pass-2 winner, which may differ from the pass-1 leader', async () => {
    // The whole point of the second pass: with only a 60-char trigger the wide
    // ranking puts the critique skill first, and reading the real bodies flips
    // it to the authoring one.
    const client = clientOf(
      wide(0.8, { 'design-critique': 0.6, 'design-craft': 0.35, 'git-flow': 0.05 }),
      rerank('design-craft', { 'design-critique': 0.4, 'design-craft': 0.72, 'git-flow': 0.02 }),
    );
    const suggester = createSkillSuggester({ client, loader: loaderOf(ROSTER) });

    const result = await suggester.suggest('Build me a new settings page');

    expect(result?.name).toBe('design-craft');
    expect(client.calls).toHaveLength(2);
  });

  it('batches the ranking Choice and all three gate Nouls into one request', async () => {
    const client = clientOf(
      wide(0.8, { 'git-flow': 0.9, 'design-craft': 0.1 }),
      rerank('git-flow', { 'git-flow': 0.8, 'design-craft': 0.1 }),
    );
    await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).suggest('cut a release');

    const pass1 = client.calls[0]!;
    expect(Object.keys(pass1.questions).sort()).toEqual([
      'gate::acts_on_user_system',
      'gate::prose_suffices',
      'gate::would_follow_documented_procedure',
      'which',
    ]);
    // Every roster entry is an option; the trigger line is its rubric.
    expect(Object.keys((pass1.questions['which'] as { criteria: object }).criteria).sort()).toEqual(
      ['design-craft', 'design-critique', 'git-flow'],
    );
  });

  it('suggests nothing when the gate says the turn does not need a skill', async () => {
    const client = clientOf(wide(0.1, { 'git-flow': 0.9 }));
    const result = await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).suggest(
      'explain what a monad is',
    );
    expect(result).toBeUndefined();
    // The shortlist pass is never paid for on a turn the gate rejected.
    expect(client.calls).toHaveLength(1);
  });

  it('drops the whole shortlist when no candidate fits well enough', async () => {
    const client = clientOf(
      wide(0.9, { 'git-flow': 0.5, 'design-craft': 0.5 }),
      rerank('git-flow', { 'git-flow': 0.12, 'design-craft': 0.05 }),
    );
    const result = await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).suggest(
      'post this announcement to Mastodon',
    );
    expect(result).toBeUndefined();
  });

  it('rejects a winner that is not in the roster', async () => {
    // The distribution is echoed back from criteria we sent, but it arrives
    // over the network and the name would be printed into the system prompt.
    const client = clientOf(
      wide(0.9, { 'git-flow': 0.9 }),
      rerank('totally-made-up', { 'git-flow': 0.9 }),
    );
    const result = await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).suggest(
      'cut a release branch',
    );
    expect(result).toBeUndefined();
  });

  it('ignores ranked names the roster does not contain', async () => {
    const client = clientOf(
      wide(0.9, { 'not-a-skill': 0.95, 'git-flow': 0.05 }),
      rerank('git-flow', { 'git-flow': 0.8 }),
    );
    const result = await createSkillSuggester({
      client,
      loader: loaderOf(ROSTER),
      shortlistSize: 1,
    }).suggest('cut a release branch');

    expect(result?.name).toBe('git-flow');
    expect(
      Object.keys((client.calls[1]!.questions['which'] as { criteria: object }).criteria),
    ).toEqual(['git-flow']);
  });

  it('excludes roster/external audiences, which the agent never sees in its manifest', async () => {
    const client = clientOf(
      wide(0.9, { 'git-flow': 0.9 }),
      rerank('git-flow', { 'git-flow': 0.9 }),
    );
    await createSkillSuggester({
      client,
      loader: loaderOf([
        ...ROSTER,
        { name: 'crew-only', trigger: 'roster work', audience: 'roster' },
        { name: 'other-agent', trigger: 'external work', audience: 'external' },
      ]),
    }).suggest('cut a release branch');

    const options = Object.keys(
      (client.calls[0]!.questions['which'] as { criteria: object }).criteria,
    );
    expect(options).not.toContain('crew-only');
    expect(options).not.toContain('other-agent');
  });

  it('suggests nothing when the roster has fewer than two skills', async () => {
    const client = clientOf();
    const result = await createSkillSuggester({
      client,
      loader: loaderOf([ROSTER[0]!]),
    }).suggest('build a settings page');
    expect(result).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  it('suggests nothing when every gate answer was malformed', async () => {
    // Fail closed: the gate is the only thing standing between a "nothing
    // fits" turn and a suggestion.
    const client = clientOf({
      answers: {
        which: {
          type: 'choice',
          choice: 'git-flow',
          probabilities: { 'git-flow': 1 },
          confidence: 1,
        },
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const result = await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).suggest(
      'cut a release branch',
    );
    expect(result).toBeUndefined();
  });

  it('explain() shows where a gate-rejected turn stopped, and at what number', async () => {
    // suggest() keeps only the verdict, which is right for a live turn and
    // useless for choosing a threshold: "nothing" does not say whether it
    // stopped at 0.29 or at 0.02.
    const client = clientOf(wide(0.1, { 'git-flow': 0.9, 'design-craft': 0.1 }));
    const trace = await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).explain(
      'explain what a monad is',
    );

    expect(trace.stop).toBe('gate');
    expect(trace.gate).toBeCloseTo(0.1);
    expect(trace.gateValues['acts_on_user_system']).toBeCloseTo(0.1);
    // Raw, un-oriented: prose_suffices is stored as answered, not as counted.
    expect(trace.gateValues['prose_suffices']).toBeCloseTo(0.9);
    expect(trace.ranked[0]).toEqual({ name: 'git-flow', probability: 0.9 });
    expect(trace.requests).toBe(1);
    expect(trace.suggestion).toBeUndefined();
  });

  it('alwaysRerank collects pass 2 below the gate but keeps the live verdict', async () => {
    // A sweep needs to know what pass 2 WOULD have said at a lower gate. It
    // must not change what this run decided.
    const client = clientOf(
      wide(0.1, { 'git-flow': 0.9, 'design-craft': 0.1 }),
      rerank('git-flow', { 'git-flow': 0.9, 'design-craft': 0.1 }),
    );
    const trace = await createSkillSuggester({
      client,
      loader: loaderOf(ROSTER),
      shortlistSize: 2,
    }).explain('explain what a monad is', undefined, { alwaysRerank: true });

    expect(client.calls).toHaveLength(2);
    expect(trace.fits['git-flow']).toBeCloseTo(0.9);
    expect(trace.winner).toBe('git-flow');
    // The gate still rejected this turn, so the verdict is still nothing.
    expect(trace.stop).toBe('gate');
    expect(trace.suggestion).toBeUndefined();
  });

  it('explain() reports a transport failure instead of swallowing it', async () => {
    const client: TypeSafeClient = {
      systemOne: vi.fn(async () => {
        throw new Error('network down');
      }),
    };
    const trace = await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).explain(
      'build a settings page',
    );
    expect(trace.stop).toBe('error');
    expect(trace.suggestion).toBeUndefined();
  });

  it('returns undefined rather than throwing when the transport fails', async () => {
    const client: TypeSafeClient = {
      systemOne: vi.fn(async () => {
        throw new Error('network down');
      }),
    };
    const result = await createSkillSuggester({ client, loader: loaderOf(ROSTER) }).suggest(
      'build a settings page',
    );
    expect(result).toBeUndefined();
  });

  it('carries body excerpts into the shortlist criteria and survives an unreadable body', async () => {
    const loader = loaderOf(ROSTER);
    loader.readBody = async (name) => {
      if (name === 'design-craft') throw new Error('EACCES');
      return '---\nname: x\n---\nCritique an existing UI in detail.';
    };
    const client = clientOf(
      wide(0.9, { 'design-critique': 0.6, 'design-craft': 0.4 }),
      rerank('design-critique', { 'design-critique': 0.8, 'design-craft': 0.2 }),
    );
    const result = await createSkillSuggester({ client, loader, shortlistSize: 2 }).suggest(
      'review this settings page',
    );

    expect(result?.name).toBe('design-critique');
    const criteria = (client.calls[1]!.questions['which'] as { criteria: Record<string, string> })
      .criteria;
    // Frontmatter is stripped from the excerpt; the unreadable skill falls back
    // to its description alone rather than dropping out of the shortlist.
    expect(criteria['design-critique']).toContain('Critique an existing UI in detail.');
    expect(criteria['design-critique']).not.toContain('---');
    expect(criteria['design-craft']).toBe('building or reshaping UI');
  });
});
