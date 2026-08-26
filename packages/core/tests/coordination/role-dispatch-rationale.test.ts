/**
 * The dispatcher-rationale contract.
 *
 * `AgentCapability.rationale` is documented as the "why this role wins" record
 * for the wave-1/2/3/4 specialist roles, and `differentiatesFrom` as the
 * contrast the dispatcher uses to separate siblings that share vocabulary.
 * Both claims were false for a long time: the wave files declared the `*_META`
 * blocks, spread only `.signals` into `keywords`, and collected the rest into
 * `WAVE*_ROLE_METAS` maps that nothing imported. Nothing set
 * `capability.rationale`, nothing read it, and no test referenced
 * `differentiatesFrom` — so `WAVE2_ROLE_METAS` was free to drift into carrying
 * six roles that belong to `WAVE4_AGENTS` without anyone noticing.
 *
 * These tests pin the wiring end to end so it cannot come apart again.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_CATALOG,
  ALL_AGENT_DEFINITIONS,
  ROLE_DISPATCH_RATIONALE,
  WAVE1_AGENTS,
  WAVE2_AGENTS,
  WAVE3_AGENTS,
  WAVE4_AGENTS,
} from '../../src/coordination/agents/index.js';
import { dispatchAgent } from '../../src/coordination/dispatcher.js';

const WAVE_AGENTS = [...WAVE1_AGENTS, ...WAVE2_AGENTS, ...WAVE3_AGENTS, ...WAVE4_AGENTS];

describe('role dispatch rationale', () => {
  it('every wave role attaches its rationale to the capability', () => {
    const missing = WAVE_AGENTS.filter((d) => !d.capability.rationale).map((d) => d.config.role);
    expect(missing).toEqual([]);
  });

  it('the derived registry matches exactly the roles that declare a rationale', () => {
    const declared = ALL_AGENT_DEFINITIONS.filter((d) => d.capability.rationale)
      .map((d) => d.config.role as string)
      .sort();
    expect(Object.keys(ROLE_DISPATCH_RATIONALE).sort()).toEqual(declared);
    // Every wave role is in there — that is the set the maps used to list.
    for (const def of WAVE_AGENTS) {
      expect(ROLE_DISPATCH_RATIONALE[def.config.role as string]).toBe(def.capability.rationale);
    }
  });

  it('rationale text is substantive and each role is in the catalog once', () => {
    for (const def of WAVE_AGENTS) {
      const role = def.config.role as string;
      const r = def.capability.rationale;
      expect(r, role).toBeDefined();
      expect(r?.rationale.length, `${role}: rationale`).toBeGreaterThan(20);
      expect(r?.differentiatesFrom.length, `${role}: differentiatesFrom`).toBeGreaterThan(20);
      expect(r?.signals.length, `${role}: signals`).toBeGreaterThan(0);
      // The catalog throws on duplicate roles at module load, but assert
      // membership too: a stale meta entry for a role owned by another wave is
      // exactly the drift that went unnoticed while the maps were dead.
      // `assignSkillsToAgents` returns skill-enriched copies, so compare the
      // rationale the catalog exposes rather than object identity.
      expect(AGENT_CATALOG[role], `${role}: catalog`).toBeDefined();
      expect(AGENT_CATALOG[role]?.capability.rationale, `${role}: catalog rationale`).toBe(r);
    }
  });

  it("a role's signals are reachable through its dispatch keywords", () => {
    for (const def of WAVE_AGENTS) {
      const keywords = new Set(def.capability.keywords);
      for (const signal of def.capability.rationale?.signals ?? []) {
        expect(keywords.has(signal), `${def.config.role}: signal "${signal}"`).toBe(true);
      }
    }
  });

  it('hands differentiatesFrom to the LLM classifier for roles that declare one', async () => {
    let seen: { role: string; differentiatesFrom?: string | undefined }[] = [];
    const target = WAVE2_AGENTS[0]!;
    const role = target.config.role as string;
    await dispatchAgent('an entirely unclassifiable request with no signal words', {
      // Force the classifier path: no keyword can match this task text.
      classifier: async (_task, candidates) => {
        seen = candidates;
        return { role };
      },
    });
    const offered = seen.find((c) => c.role === role);
    expect(offered, `${role} was not offered to the classifier`).toBeDefined();
    expect(offered?.differentiatesFrom).toBe(target.capability.rationale?.differentiatesFrom);
  });
});
