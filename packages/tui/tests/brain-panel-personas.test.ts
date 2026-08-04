// The panel's Council lens list is published by the HOST, not hard-coded here.
// Before that, `PERSONA_CYCLE` was a local ['executor','skeptic','auditor'],
// so the registry's `security`, `maintainer` and `user-advocate` lenses were
// unreachable from the TUI even though the Brain accepted them.

import { describe, expect, it } from 'vitest';
import {
  BRAIN_READONLY_ROW_KINDS,
  brainPanelRows,
  COUNCIL_CONCURRENCY_PRESETS,
  COUNCIL_DISTINCTNESS_PRESETS,
  COUNCIL_FRACTION_PRESETS,
  COUNCIL_JUDGE_MAX_TOKENS_PRESETS,
  COUNCIL_TIMEOUT_PRESETS,
  cyclePreset,
  PERSONA_CYCLE,
  personaCycle,
  personaLabel,
  type BrainPanelSettings,
} from '../src/brain-panel-model.js';

function settings(over: Partial<BrainPanelSettings> = {}): BrainPanelSettings {
  return {
    mode: 'headless',
    riskLevel: 'high',
    strategy: 'fallback',
    pool: [],
    poolResolved: [],
    usingSessionModel: true,
    councilEnabled: true,
    councilMinRisk: 'high',
    councilDistinctness: 'none',
    voters: [],
    councilSeats: [],
    ledgerEnabled: false,
    terminalPolicy: 'conservative',
    heuristics: {
      lowRiskAutoAnswer: true,
      blockedResolved: true,
      deadlockSkip: true,
      retryExhausted: true,
      continuePing: true,
    },
    llmMaxTokens: 800,
    llmRejectUncertain: false,
    llmMinConfidence: 0,
    llmDenyIsTerminal: 'when-decided',
    cacheEnabled: false,
    cacheTtlMs: 300_000,
    cacheMaxEntries: 200,
    cacheHits: 0,
    cacheMisses: 0,
    cacheSize: 0,
    traceEnabled: false,
    traceContent: 'redacted',
    ruleCount: 0,
    ruleErrors: [],
    ...over,
  };
}

describe('personaCycle', () => {
  it('uses the host catalog when one is published', () => {
    const catalog = [
      { id: 'executor', name: 'Executor', description: 'a' },
      { id: 'security', name: 'Security Reviewer', description: 'b', defaultVeto: true },
      { id: 'user-advocate', name: 'User Advocate', description: 'c' },
    ];

    expect(personaCycle(settings({ personaCatalog: catalog }))).toEqual([
      'executor',
      'security',
      'user-advocate',
    ]);
  });

  it('falls back to the legacy three on a host that publishes no catalog', () => {
    expect(personaCycle(settings())).toEqual([...PERSONA_CYCLE]);
    expect(personaCycle(settings({ personaCatalog: [] }))).toEqual([...PERSONA_CYCLE]);
  });
});

describe('personaLabel', () => {
  const withCatalog = settings({
    personaCatalog: [{ id: 'user-advocate', name: 'User Advocate', description: 'c' }],
  });

  it('renders the catalog name rather than the raw id', () => {
    expect(personaLabel(withCatalog, 'user-advocate')).toBe('User Advocate');
  });

  it('falls back to the id for an ad-hoc lens the catalog does not describe', () => {
    expect(personaLabel(withCatalog, 'weigh latency above all else')).toBe(
      'weigh latency above all else',
    );
  });

  it('reads "voter" when a seat has no lens at all', () => {
    expect(personaLabel(withCatalog, undefined)).toBe('voter');
  });
});

describe('brainPanelRows — council resolution + budget knobs', () => {
  it('offers no council rows while the council is off and unseated', () => {
    const kinds = brainPanelRows(settings({ councilEnabled: false })).map((row) => row.kind);
    expect(kinds).not.toContain('councilQuorum');
    expect(kinds).not.toContain('councilDistinctness');
  });

  it('exposes quorum, approval, distinctness and the budget knobs once convened', () => {
    // These were WebUI-only: the panel could seat a council but not say how it
    // resolves, how diverse it must be, or what it may spend.
    const kinds = brainPanelRows(settings({ councilEnabled: true })).map((row) => row.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'councilQuorum',
        'councilApproval',
        'councilDistinctness',
        'councilTimeout',
        'councilConcurrency',
        'councilJudgeMaxTokens',
      ]),
    );
  });

  it('keeps every new council row adjustable rather than read-only', () => {
    for (const kind of [
      'councilQuorum',
      'councilApproval',
      'councilDistinctness',
      'councilTimeout',
      'councilConcurrency',
      'councilJudgeMaxTokens',
    ] as const) {
      expect(BRAIN_READONLY_ROW_KINDS.has(kind)).toBe(false);
    }
  });
});

describe('council preset ladders', () => {
  it('cycles the integer ladders through an explicit "default" rung', () => {
    // BrainCouncilPatch accepts null for these three, unlike the LLM/cache
    // knobs — so "back to default" is reachable and must stay in the ladder.
    for (const presets of [
      COUNCIL_TIMEOUT_PRESETS,
      COUNCIL_CONCURRENCY_PRESETS,
      COUNCIL_JUDGE_MAX_TOKENS_PRESETS,
    ]) {
      expect(presets).toContain(undefined);
      expect(cyclePreset(presets, undefined, 1)).not.toBeUndefined();
      expect(cyclePreset(presets, presets[presets.length - 1], 1)).toBeUndefined();
    }
  });

  it('wraps the distinctness ladder in both directions', () => {
    expect(COUNCIL_DISTINCTNESS_PRESETS).toEqual(['none', 'model', 'provider']);
    expect(cyclePreset(COUNCIL_DISTINCTNESS_PRESETS, 'provider', 1)).toBe('none');
    expect(cyclePreset(COUNCIL_DISTINCTNESS_PRESETS, 'none', -1)).toBe('provider');
  });

  it('keeps every fraction rung inside the (0, 1] range the runtime enforces', () => {
    for (const fraction of COUNCIL_FRACTION_PRESETS) {
      expect(fraction).toBeGreaterThan(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });
});
