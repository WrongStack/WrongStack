import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_CATALOG,
  ALL_AGENT_DEFINITIONS,
  DEFAULT_DISPATCH_ROLE,
  dispatchAgent,
  makeLLMClassifier,
  scoreAgents,
} from '../src/index.js';

describe('catalog', () => {
  it('has 79 catalog agents, all with role/prompt/keywords', () => {
    const roles = Object.keys(AGENT_CATALOG);
    expect(roles.length).toBe(79);
    for (const def of Object.values(AGENT_CATALOG)) {
      expect(def.config.role).toBeTruthy();
      expect((def.config.prompt ?? '').length).toBeGreaterThan(50);
      expect(def.capability.keywords.length).toBeGreaterThan(0);
      expect(def.budget.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe('general-purpose roles', () => {
  // The Scout identity delegates non-coding work; these requests must land on
  // the general specialists rather than their technical neighbours (research,
  // document, i18n, devops).
  it.each([
    ['fact-check these claims and look up the current regulations', 'investigator'],
    ['proofread my cover letter and rewrite this intro', 'writer'],
    ['translate this document into German', 'translator'],
    ['the disk is full: check disk space and the windows service that fails', 'sysadmin'],
  ])('routes "%s" to %s', (task, role) => {
    expect(scoreAgents(task)[0]?.role).toBe(role);
  });
});

describe('catalog routing health', () => {
  it('every agent is reachable: it tops the scoreboard for a task built from its own keywords', () => {
    const unreachable: Array<{
      role: string;
      winner: string;
      targetScore: number;
      topScore: number;
    }> = [];
    for (const def of ALL_AGENT_DEFINITIONS) {
      const role = def.config.role as string;
      // A task that contains exactly this agent's signal words. The agent
      // matches all of them, so no sibling should be able to strictly outscore
      // it on its own vocabulary — if one does, the agent is shadowed and can
      // never win even on a perfectly on-topic request.
      const task = def.capability.keywords.join(', ');
      const ranked = scoreAgents(task);
      const top = ranked[0];
      const mine = ranked.find((c) => c.role === role);
      if (!top || !mine || mine.score !== top.score) {
        unreachable.push({
          role,
          winner: top?.role ?? '(none)',
          targetScore: mine?.score ?? 0,
          topScore: top?.score ?? 0,
        });
      }
    }
    expect(unreachable, JSON.stringify(unreachable, null, 2)).toEqual([]);
  });

  it('no two agents share an identical keyword set (which would make routing order-dependent)', () => {
    const bySet = new Map<string, string[]>();
    for (const def of ALL_AGENT_DEFINITIONS) {
      const key = [...def.capability.keywords]
        .map((k) => k.trim())
        .sort()
        .join('|');
      const arr = bySet.get(key) ?? [];
      arr.push(def.config.role as string);
      bySet.set(key, arr);
    }
    const collisions = [...bySet.values()].filter((roles) => roles.length > 1);
    expect(collisions, JSON.stringify(collisions)).toEqual([]);
  });

  it('the fallback role exists in the catalog so dispatch can never resolve to an unknown agent', () => {
    expect(AGENT_CATALOG[DEFAULT_DISPATCH_ROLE]).toBeDefined();
  });
});

describe('scoreAgents', () => {
  it('ranks the obvious agent first for a clear task', () => {
    const ranked = scoreAgents('there is a bug, the app crashes on login, please debug it');
    expect(ranked[0]?.role).toBe('debugger');
  });

  it('matches multi-word phrases stronger than single words', () => {
    const ranked = scoreAgents('write end to end tests for the checkout journey');
    expect(ranked[0]?.role).toBe('e2e');
  });

  it('counts a repeated or spelling-variant keyword once', () => {
    const def = (role: string, keywords: string[]) => ({
      config: { role, name: role },
      budget: {},
      capability: { phase: 'build' as const, summary: role, keywords },
    });
    const ranked = scoreAgents('explore how the mailbox ipc works', {
      desktop: def('desktop', ['ipc', 'ipc', 'IPC']),
      explore: def('explore', ['explore']),
    });
    expect(ranked.map((c) => [c.role, c.score])).toEqual([
      ['desktop', 1],
      ['explore', 1],
    ]);
    // On the real catalog the duplicated `ipc` no longer outvotes `explore`.
    expect(scoreAgents('explore how the mailbox ipc works')[0]?.role).toBe('explore');
  });

  it('does not count a keyword already covered by a longer matched phrase', () => {
    const ranked = scoreAgents('write tests for the parser');
    const test = ranked.find((c) => c.role === 'test');
    expect(test?.matched).toContain('write tests');
    expect(test?.matched).not.toContain('test');
  });

  it('lets a matched phrase outscore the same number of loose words', () => {
    // security-reviewer matches the phrase "sql injection"; security-scanner
    // matches "scan", "injection" and "vulnerability" one by one.
    const ranked = scoreAgents('scan this code for sql injection vulnerabilities');
    expect(ranked[0]?.role).toBe('security-reviewer');
    expect(ranked[0]?.matched).toContain('sql injection');
  });

  it('matches inflected task words against keyword stems', () => {
    expect(scoreAgents('add translations for the onboarding screen')[0]?.role).toBe('i18n');
    expect(scoreAgents('write unit tests for the journal')[0]?.role).toBe('test');
  });

  it('returns empty for a task with no signal', () => {
    expect(scoreAgents('zzzzz qqqqq wwwww')).toEqual([]);
  });

  it('routes an iOS / SwiftUI / SwiftData task to the iOS assistant', () => {
    const ranked = scoreAgents(
      'add a SwiftUI screen with a SwiftData model and wire it up for ios',
    );
    expect(ranked[0]?.role).toBe('ios');
    expect(ranked[0]?.score ?? 0).toBeGreaterThan(0);
    // No other agent should be able to strictly outscore us on a task whose
    // every signal word is iOS-specific (swiftui, swiftdata, ios).
    for (const candidate of ranked.slice(1)) {
      expect(candidate.score).toBeLessThanOrEqual(ranked[0]!.score);
    }
  });
});

describe('dispatchAgent (heuristic)', () => {
  it('routes a security task to the security reviewer', async () => {
    const r = await dispatchAgent('review this code for sql injection vulnerabilities');
    expect(r.role).toBe('security-reviewer');
    expect(r.method).toBe('heuristic');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('falls back to executor when there is no signal and no classifier', async () => {
    const r = await dispatchAgent('zzzzz qqqqq wwwww');
    expect(r.role).toBe('executor');
    expect(r.method).toBe('fallback');
    expect(r.confidence).toBe(0);
  });
});

describe('dispatchAgent (LLM fallback)', () => {
  it('invokes the classifier on an ambiguous task and honors its choice', async () => {
    const classifier = vi.fn(async () => ({ role: 'architect', reason: 'design work' }));
    // A vague task that produces a weak/ambiguous heuristic signal.
    const r = await dispatchAgent('think about how to shape this thing', {
      classifier,
      confidenceThreshold: 0.99, // force the LLM path
    });
    expect(classifier).toHaveBeenCalledOnce();
    expect(r.role).toBe('architect');
    expect(r.method).toBe('llm');
  });

  it('ignores a classifier choice that is not in the catalog', async () => {
    const classifier = vi.fn(async () => ({ role: 'not-a-real-agent' }));
    const r = await dispatchAgent('zzzzz qqqqq wwwww', { classifier });
    // Invalid choice → fall through to fallback generalist.
    expect(r.role).toBe('executor');
    expect(r.method).toBe('fallback');
  });

  it('survives a throwing classifier', async () => {
    const classifier = vi.fn(async () => {
      throw new Error('provider down');
    });
    const r = await dispatchAgent('zzzzz qqqqq wwwww', { classifier });
    expect(r.role).toBe('executor');
  });
});

describe('makeLLMClassifier', () => {
  it('renders the file-backed router prompt with task and candidates', async () => {
    const complete = vi.fn(async () => '{"role":"debugger","reason":"bug"}');
    const classify = makeLLMClassifier(complete);
    await classify('fix the login crash', [
      { role: 'debugger', name: 'Debugger', summary: 'Finds and fixes defects' },
    ]);
    const prompt = complete.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('You are an agent router');
    expect(prompt).toContain('fix the login crash');
    expect(prompt).toContain('1. debugger');
    expect(prompt).not.toContain('{{task}}');
    expect(prompt).not.toContain('{{agents}}');
  });

  it('parses a clean JSON choice', async () => {
    const classify = makeLLMClassifier(async () => '{"role":"debugger","reason":"bug"}');
    const out = await classify('x', [{ role: 'debugger', name: 'Debugger', summary: 's' }]);
    expect(out).toEqual({ role: 'debugger', reason: 'bug' });
  });

  it('extracts JSON even with surrounding prose / fences', async () => {
    const classify = makeLLMClassifier(
      async () => 'Sure!\n```json\n{"role":"test"}\n```\nHope that helps.',
    );
    const out = await classify('x', [{ role: 'test', name: 'Test', summary: 's' }]);
    expect(out?.role).toBe('test');
  });

  it('returns null for an out-of-list role', async () => {
    const classify = makeLLMClassifier(async () => '{"role":"ghost"}');
    const out = await classify('x', [{ role: 'test', name: 'Test', summary: 's' }]);
    expect(out).toBeNull();
  });

  it('returns null for unparseable output', async () => {
    const classify = makeLLMClassifier(async () => 'no json here');
    const out = await classify('x', [{ role: 'test', name: 'Test', summary: 's' }]);
    expect(out).toBeNull();
  });

  it('dispatchAgent ignores Object.prototype role names returned by classifier (F306)', async () => {
    const res = await dispatchAgent('hello', {
      catalog: {},
      classifier: async () => ({ role: 'constructor', confidence: 0.9, reason: 'test' }),
    });
    expect(res.role).not.toBe('constructor');
    expect(typeof res.definition).not.toBe('function');
  });
});
