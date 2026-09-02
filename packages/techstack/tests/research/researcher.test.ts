/**
 * TechStack — Research stage tests.
 *
 * The research stage is the only place an LLM touches the TechStack pipeline,
 * so these tests pin the guardrails that make that safe:
 *
 * - It cannot invent packages (SDD §31).
 * - It cannot fabricate version facts (SDD §472).
 * - It cannot present an interpretation as a fact (confidence < 1.0).
 * - It cannot fail the deterministic job that produced the inventory.
 *
 * @see packages/techstack/src/research/researcher.ts
 * @see docs/specs/techstack-sdd.md §31, §472
 */

import { describe, it, expect, vi } from 'vitest';
import { createResearcher } from '../../src/research/researcher.js';
import { triageCandidates } from '../../src/research/triage.js';
import type { ResearchLlm, ResearchSearch } from '../../src/research/types.js';
import type { DependencyObservation } from '../../src/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeDep(overrides: Partial<DependencyObservation> = {}): DependencyObservation {
  return {
    id: overrides.id ?? `dep-${overrides.name ?? 'pkg'}`,
    workspaceId: 'ws-1',
    ecosystem: 'npm',
    name: 'pkg',
    sourceType: 'registry',
    direct: true,
    scope: 'runtime',
    locked: '1.0.0',
    latestStable: '3.0.0',
    status: 'update_available_breaking',
    evidence: [],
    ...overrides,
  };
}

const FIXED_NOW = () => new Date('2026-07-17T00:00:00.000Z');

function fakeSearch(results: Awaited<ReturnType<ResearchSearch>> = []): ResearchSearch {
  return async () => results;
}

function fakeLlm(response: unknown): ResearchLlm {
  return async () => (typeof response === 'string' ? response : JSON.stringify(response));
}

const SOURCES = [
  { title: 'Migration guide', url: 'https://example.com/migrate', snippet: 'v3 drops node 16' },
];

// ── Anti-hallucination ────────────────────────────────────────────────────

describe('research — package invention', () => {
  it('drops findings for packages that were never triaged', () => {
    const candidates = triageCandidates([makeDep({ name: 'real' })]);
    const researcher = createResearcher({
      search: fakeSearch(),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [
          {
            package: 'real',
            severity: 'medium',
            action: 'upgrade_major',
            confidence: 0.8,
            rationale: 'ok',
          },
          {
            package: 'totally-made-up',
            severity: 'critical',
            action: 'remove',
            confidence: 0.9,
            rationale: 'invented',
          },
        ],
      }),
    });

    return researcher.research(candidates).then((findings) => {
      expect(findings).toHaveLength(1);
      expect(findings[0]?.dependencyId).toBe('dep-real');
    });
  });

  it('anchors every finding to a real dependency id', async () => {
    const candidates = triageCandidates([makeDep({ id: 'dep-42', name: 'real' })]);
    const researcher = createResearcher({
      search: fakeSearch(),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [
          { package: 'real', severity: 'low', action: 'none', confidence: 0.5, rationale: 'fine' },
        ],
      }),
    });

    const findings = await researcher.research(candidates);
    expect(findings[0]?.dependencyId).toBe('dep-42');
  });
});

// ── The version-fabrication invariant (SDD §472) ──────────────────────────

describe('research — version facts', () => {
  it('cannot carry version fields even when the model emits them', async () => {
    const candidates = triageCandidates([
      makeDep({ name: 'react', locked: '17.0.2', latestStable: '18.2.0' }),
    ]);
    const researcher = createResearcher({
      search: fakeSearch(),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [
          {
            package: 'react',
            severity: 'medium',
            action: 'upgrade_major',
            confidence: 0.8,
            rationale: 'concurrent rendering',
            // The model tries to assert version facts. `Finding` has nowhere
            // to put them, so they are structurally unrepresentable.
            latestStable: '99.0.0',
            locked: '0.0.1',
          },
        ],
      }),
    });

    const findings = await researcher.research(candidates);
    expect(findings).toHaveLength(1);
    expect(findings[0]).not.toHaveProperty('latestStable');
    expect(findings[0]).not.toHaveProperty('locked');
    expect(findings[0]).not.toHaveProperty('requested');
  });

  it('leaves the triaged dependency object untouched', async () => {
    const dep = makeDep({ name: 'react', locked: '17.0.2', latestStable: '18.2.0' });
    const snapshot = structuredClone(dep);
    const researcher = createResearcher({
      search: fakeSearch(),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [
          {
            package: 'react',
            severity: 'high',
            action: 'upgrade_major',
            confidence: 0.9,
            rationale: 'x',
            latestStable: '99.0.0',
          },
        ],
      }),
    });

    await researcher.research(triageCandidates([dep]));
    expect(dep).toEqual(snapshot);
  });
});

// ── Confidence ────────────────────────────────────────────────────────────

describe('research — confidence', () => {
  it('never lets an interpretation claim deterministic certainty', async () => {
    const candidates = triageCandidates([makeDep({ name: 'pkg' })]);
    const researcher = createResearcher({
      search: fakeSearch(),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [
          {
            package: 'pkg',
            severity: 'high',
            action: 'upgrade_major',
            confidence: 1.0,
            rationale: 'certain',
          },
        ],
      }),
    });

    const findings = await researcher.research(candidates);
    expect(findings[0]?.confidence).toBeLessThan(1);
  });

  it('falls back to a middling confidence when the model omits or mangles it', async () => {
    const candidates = triageCandidates([makeDep({ name: 'pkg' })]);
    const researcher = createResearcher({
      search: fakeSearch(),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [
          {
            package: 'pkg',
            severity: 'low',
            action: 'none',
            confidence: 'very sure',
            rationale: 'x',
          },
        ],
      }),
    });

    const findings = await researcher.research(candidates);
    expect(findings[0]?.confidence).toBe(0.5);
  });
});

// ── Evidence ──────────────────────────────────────────────────────────────

describe('research — evidence', () => {
  it('records cited sources as agent evidence', async () => {
    const candidates = triageCandidates([makeDep({ name: 'pkg' })]);
    const researcher = createResearcher({
      search: fakeSearch(SOURCES),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [
          {
            package: 'pkg',
            severity: 'medium',
            action: 'upgrade_major',
            confidence: 0.7,
            rationale: 'x',
            sources: ['https://example.com/migrate'],
          },
        ],
      }),
    });

    const findings = await researcher.research(candidates);
    expect(findings[0]?.evidence).toEqual([
      {
        kind: 'agent',
        source: 'https://example.com/migrate',
        retrievedAt: '2026-07-17T00:00:00.000Z',
        detail: 'Migration guide',
      },
    ]);
  });

  it('discards citations that were not among the fetched sources', async () => {
    const candidates = triageCandidates([makeDep({ name: 'pkg' })]);
    const researcher = createResearcher({
      search: fakeSearch(SOURCES),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [
          {
            package: 'pkg',
            severity: 'medium',
            action: 'upgrade_major',
            confidence: 0.7,
            rationale: 'x',
            sources: ['https://evil.example/invented-citation'],
          },
        ],
      }),
    });

    const findings = await researcher.research(candidates);
    expect(findings[0]?.evidence.map((e) => e.source)).toEqual(['https://example.com/migrate']);
  });
});

// ── Degradation ───────────────────────────────────────────────────────────

describe('research — degradation', () => {
  it('returns nothing when there is nothing to research', async () => {
    const researcher = createResearcher({ llm: fakeLlm({}), search: fakeSearch(), now: FIXED_NOW });
    expect(await researcher.research([])).toEqual([]);
  });

  it('survives a provider outage', async () => {
    const candidates = triageCandidates([makeDep({ name: 'pkg' })]);
    const researcher = createResearcher({
      search: fakeSearch(SOURCES),
      now: FIXED_NOW,
      llm: async () => {
        throw new Error('provider exploded');
      },
    });

    await expect(researcher.research(candidates)).resolves.toEqual([]);
  });

  it('survives an unparseable response', async () => {
    const candidates = triageCandidates([makeDep({ name: 'pkg' })]);
    const researcher = createResearcher({
      search: fakeSearch(),
      now: FIXED_NOW,
      llm: fakeLlm('I am terribly sorry, but as an AI language model'),
    });

    await expect(researcher.research(candidates)).resolves.toEqual([]);
  });

  it('still interprets when web search comes back dry', async () => {
    const candidates = triageCandidates([makeDep({ name: 'pkg' })]);
    const researcher = createResearcher({
      search: fakeSearch([]),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [
          {
            package: 'pkg',
            severity: 'low',
            action: 'investigate',
            confidence: 0.3,
            rationale: 'no sources found',
          },
        ],
      }),
    });

    const findings = await researcher.research(candidates);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toEqual([]);
  });

  it('lets one failing cluster not sink the others', async () => {
    const candidates = triageCandidates([
      makeDep({ id: 'v', name: 'vuln-pkg', status: 'vulnerable' }),
      makeDep({ id: 'd', name: 'dead-pkg', status: 'deprecated' }),
    ]);
    const llm = vi.fn<ResearchLlm>(async (req) => {
      if (req.schemaName.includes('vulnerability')) throw new Error('cluster failed');
      return JSON.stringify({
        findings: [
          {
            package: 'dead-pkg',
            severity: 'medium',
            action: 'replace',
            confidence: 0.6,
            rationale: 'x',
          },
        ],
      });
    });
    const researcher = createResearcher({ llm, search: fakeSearch(), now: FIXED_NOW });

    const findings = await researcher.research(candidates);
    expect(llm).toHaveBeenCalledTimes(2);
    expect(findings.map((f) => f.dependencyId)).toEqual(['d']);
  });

  it('drops entries with no rationale rather than emit an empty verdict', async () => {
    const candidates = triageCandidates([makeDep({ name: 'pkg' })]);
    const researcher = createResearcher({
      search: fakeSearch(),
      now: FIXED_NOW,
      llm: fakeLlm({
        findings: [{ package: 'pkg', severity: 'high', action: 'remove', confidence: 0.9 }],
      }),
    });

    expect(await researcher.research(candidates)).toEqual([]);
  });
});

// ── Cluster batching ──────────────────────────────────────────────────────

describe('research — batching', () => {
  it('makes one LLM call per cluster, not one per package', async () => {
    const candidates = triageCandidates(
      Array.from({ length: 12 }, (_, i) =>
        makeDep({ id: `d${i}`, name: `pkg-${i}`, status: 'deprecated' }),
      ),
    );
    const llm = vi.fn<ResearchLlm>(async () => JSON.stringify({ findings: [] }));
    const researcher = createResearcher({ llm, search: fakeSearch(), now: FIXED_NOW });

    await researcher.research(candidates);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('stops before the LLM call once aborted', async () => {
    const candidates = triageCandidates([makeDep({ name: 'pkg' })]);
    const llm = vi.fn<ResearchLlm>(async () => JSON.stringify({ findings: [] }));
    const controller = new AbortController();
    controller.abort();
    const researcher = createResearcher({ llm, search: fakeSearch(), now: FIXED_NOW });

    expect(await researcher.research(candidates, { signal: controller.signal })).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('reports progress per cluster', async () => {
    const candidates = triageCandidates([
      makeDep({ id: 'v', name: 'vuln-pkg', status: 'vulnerable' }),
      makeDep({ id: 'd', name: 'dead-pkg', status: 'deprecated' }),
    ]);
    const onProgress = vi.fn();
    const researcher = createResearcher({
      llm: fakeLlm({ findings: [] }),
      search: fakeSearch(),
      now: FIXED_NOW,
    });

    await researcher.research(candidates, { onProgress });
    expect(onProgress.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });
});
