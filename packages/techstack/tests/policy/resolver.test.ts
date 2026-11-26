/**
 * TechStack — Rulebook Resolver tests.
 *
 * Pins the resolver contract:
 *   - matchesSelector wildcard semantics (`*` / `**`, case-insensitivity)
 *   - parseRange / satisfiesRange (reusing policy/status.ts compareVersions)
 *   - resolveDependency decision order: banned → pinned → deferred → preferred → unconstrained
 *   - resolveDependencies: non-registry sources are always unconstrained
 *
 * @see packages/techstack/src/policy/resolver.ts
 */

import { describe, expect, it } from 'vitest';
import {
  findRuleMatches,
  matchesSelector,
  parseRange,
  RangeParseError,
  resolveDependencies,
  resolveDependency,
  satisfiesRange,
} from '../../src/policy/resolver.js';
import type { Rulebook } from '../../src/policy/rulebook.js';
import { asIsoDateTime, asVersionRange } from '../../src/policy/rulebook.js';
import type { DependencyObservation } from '../../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeDep(overrides: Partial<DependencyObservation> = {}): DependencyObservation {
  return {
    id: 'dep-1',
    workspaceId: 'ws-1',
    ecosystem: 'npm',
    name: 'react',
    sourceType: 'registry',
    direct: true,
    scope: 'runtime',
    status: 'current',
    locked: '19.2.7',
    latestStable: '19.2.7',
    evidence: [],
    ...overrides,
  };
}

function makeRulebook(overrides: Partial<Rulebook> = {}): Rulebook {
  return {
    schemaVersion: '1',
    pinned: [],
    banned: [],
    deferred: [],
    preferred: [],
    ...overrides,
  };
}

/** Fixed reference time so `deferred.until` comparisons are deterministic. */
const NOW = new Date('2026-08-16T00:00:00.000Z');

// ── matchesSelector ──────────────────────────────────────────────────────

describe('matchesSelector', () => {
  it('matches exact name case-insensitively', () => {
    expect(matchesSelector({ name: 'react' }, 'npm', 'react')).toBe(true);
    expect(matchesSelector({ name: 'React' }, 'npm', 'react')).toBe(true);
    expect(matchesSelector({ name: 'react' }, 'npm', 'react-dom')).toBe(false);
  });

  it('matches ecosystem-only selectors', () => {
    expect(matchesSelector({ ecosystem: 'npm' }, 'npm', 'anything')).toBe(true);
    expect(matchesSelector({ ecosystem: 'python' }, 'npm', 'anything')).toBe(false);
  });

  it('ecosystem mismatch blocks even when name matches', () => {
    expect(matchesSelector({ ecosystem: 'python', name: 'react' }, 'npm', 'react')).toBe(false);
  });

  it('empty selector matches nothing', () => {
    expect(matchesSelector({}, 'npm', 'react')).toBe(false);
  });

  it('single star does not cross path separators', () => {
    expect(matchesSelector({ namePattern: '@types/*' }, 'npm', '@types/node')).toBe(true);
    expect(matchesSelector({ namePattern: '@types/*' }, 'npm', '@types/node/fs')).toBe(false);
  });

  it('double star crosses path separators', () => {
    expect(matchesSelector({ namePattern: '@types/**' }, 'npm', '@types/node/fs')).toBe(true);
    expect(matchesSelector({ namePattern: '@types/**' }, 'npm', '@other/node')).toBe(false);
  });

  it('matches namePattern case-insensitively and treats regex characters literally', () => {
    expect(matchesSelector({ namePattern: 'React-*' }, 'npm', 'react-dom')).toBe(true);
    expect(matchesSelector({ namePattern: 'a.b+c' }, 'npm', 'a.b+c')).toBe(true);
    expect(matchesSelector({ namePattern: 'a.b' }, 'npm', 'axb')).toBe(false);
    expect(matchesSelector({ namePattern: '@a/***' }, 'npm', '@a/b/c')).toBe(true);
  });

  it('answers a repo-committed wildcard pattern in linear time on a non-matching name', () => {
    // As a backtracking regex these took ~2.4 s, ~0.9 s and ~41 s; a few
    // wildcards more and a single package name wedged the process. The linear
    // matcher answers all of them in well under a millisecond.
    const cases = [
      ['*a'.repeat(5) + 'b', 'a'.repeat(200)],
      ['**a'.repeat(6) + 'b', 'a'.repeat(100)],
      ['*a'.repeat(7) + 'b', 'a'.repeat(120)],
    ] as const;
    const started = performance.now();
    for (const [namePattern, name] of cases) {
      expect(matchesSelector({ namePattern }, 'npm', name)).toBe(false);
      expect(matchesSelector({ namePattern }, 'npm', `${name}b`)).toBe(true);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

// ── parseRange ───────────────────────────────────────────────────────────

describe('parseRange', () => {
  it('parses exact, caret, tilde and comparator forms', () => {
    expect(parseRange('1.2.3')).toEqual({ kind: 'exact', version: '1.2.3' });
    expect(parseRange('^1.2.3')).toEqual({ kind: 'caret', version: '1.2.3' });
    expect(parseRange('~1.2.3')).toEqual({ kind: 'tilde', version: '1.2.3' });
    expect(parseRange('>=1.2.3')).toEqual({ kind: 'comparator', op: '>=', version: '1.2.3' });
    expect(parseRange('<=1.2.3')).toEqual({ kind: 'comparator', op: '<=', version: '1.2.3' });
  });

  it('parses AND (whitespace) and OR (||) compositions', () => {
    const and = parseRange('>=1.2.3 <2.0.0');
    expect(and.kind).toBe('and');
    if (and.kind === 'and') {
      expect(and.ranges).toHaveLength(2);
    }

    const or = parseRange('^1.2.3 || ^2.0.0');
    expect(or.kind).toBe('or');
    if (or.kind === 'or') {
      expect(or.ranges).toHaveLength(2);
    }
  });

  it('rejects malformed ranges with RangeParseError', () => {
    expect(() => parseRange('')).toThrow(RangeParseError);
    expect(() => parseRange('abc')).toThrow(RangeParseError);
    expect(() => parseRange('^')).toThrow(RangeParseError);
    expect(() => parseRange('>=')).toThrow(RangeParseError);
    expect(() => parseRange('1.2.x')).toThrow(RangeParseError);
  });
});

// ── satisfiesRange ───────────────────────────────────────────────────────

describe('satisfiesRange', () => {
  it('exact range requires equality', () => {
    expect(satisfiesRange('1.2.3', parseRange('1.2.3'))).toBe(true);
    expect(satisfiesRange('1.2.4', parseRange('1.2.3'))).toBe(false);
  });

  it('caret range locks the first non-zero segment', () => {
    expect(satisfiesRange('1.2.3', parseRange('^1.2.3'))).toBe(true);
    expect(satisfiesRange('1.9.9', parseRange('^1.2.3'))).toBe(true);
    expect(satisfiesRange('2.0.0', parseRange('^1.2.3'))).toBe(false);
    expect(satisfiesRange('1.2.2', parseRange('^1.2.3'))).toBe(false);

    expect(satisfiesRange('0.2.9', parseRange('^0.2.3'))).toBe(true);
    expect(satisfiesRange('0.3.0', parseRange('^0.2.3'))).toBe(false);

    expect(satisfiesRange('0.0.3', parseRange('^0.0.3'))).toBe(true);
    expect(satisfiesRange('0.0.4', parseRange('^0.0.3'))).toBe(false);
  });

  it('tilde range locks the minor segment', () => {
    expect(satisfiesRange('1.2.9', parseRange('~1.2.3'))).toBe(true);
    expect(satisfiesRange('1.3.0', parseRange('~1.2.3'))).toBe(false);
    expect(satisfiesRange('1.2.2', parseRange('~1.2.3'))).toBe(false);

    expect(satisfiesRange('1.2.9', parseRange('~1.2'))).toBe(true);
    expect(satisfiesRange('1.3.0', parseRange('~1.2'))).toBe(false);
    expect(satisfiesRange('1.9.9', parseRange('~1'))).toBe(true);
    expect(satisfiesRange('2.0.0', parseRange('~1'))).toBe(false);
  });

  it('comparator range applies the operator', () => {
    expect(satisfiesRange('1.2.3', parseRange('>=1.2.3'))).toBe(true);
    expect(satisfiesRange('1.2.2', parseRange('>=1.2.3'))).toBe(false);
    expect(satisfiesRange('1.9.9', parseRange('<2.0.0'))).toBe(true);
    expect(satisfiesRange('2.0.0', parseRange('<2.0.0'))).toBe(false);
  });

  it('AND requires every sub-range', () => {
    const range = parseRange('>=1.2.3 <2.0.0');
    expect(satisfiesRange('1.5.0', range)).toBe(true);
    expect(satisfiesRange('2.0.0', range)).toBe(false);
    expect(satisfiesRange('1.1.0', range)).toBe(false);
  });

  it('OR requires any sub-range', () => {
    const range = parseRange('^1.2.3 || ^2.0.0');
    expect(satisfiesRange('1.5.0', range)).toBe(true);
    expect(satisfiesRange('2.5.0', range)).toBe(true);
    expect(satisfiesRange('3.0.0', range)).toBe(false);
  });

  // A partial version is an X-range (semver 7.7.4), not a zero-padded one:
  // a pin `max: "18"` / `"<=18"` used to reject 18.2.0.
  it.each([
    ['18', '18.2.0', true],
    ['18', '19.0.0', false],
    ['=1.2', '1.2.9', true],
    ['<=18', '18.9.9', true],
    ['<=1.2', '1.3.0', false],
    ['>1.2', '1.2.9', false],
    ['>1.2', '1.3.0', true],
    ['^0', '0.14.0', true],
    ['^0', '1.0.0', false],
    ['^0.0', '0.0.7', true],
    ['^0.0', '0.1.0', false],
  ])('partial %s against %s is %s', (range, version, expected) => {
    expect(satisfiesRange(version, parseRange(range))).toBe(expected);
  });
});

// ── findRuleMatches ──────────────────────────────────────────────────────

describe('findRuleMatches', () => {
  it('collects only matching entries per rule category', () => {
    const rulebook = makeRulebook({
      pinned: [
        { selector: { name: 'react' }, max: asVersionRange('^19.0.0'), reason: 'stay on 19' },
        { selector: { name: 'vue' }, max: asVersionRange('^3.0.0'), reason: 'stay on 3' },
      ],
      banned: [{ selector: { name: 'lodash' }, reason: 'native replace' }],
      deferred: [
        {
          selector: { name: 'typescript' },
          until: asIsoDateTime('2030-01-01T00:00:00.000Z'),
          reason: 'wait',
        },
      ],
      preferred: [{ selector: { name: 'vitest' }, context: 'house runner' }],
    });

    const matches = findRuleMatches(rulebook, 'npm', 'react');
    expect(matches.pinned).toHaveLength(1);
    expect(matches.banned).toHaveLength(0);
    expect(matches.deferred).toHaveLength(0);
    expect(matches.preferred).toHaveLength(0);
  });
});

// ── resolveDependency — decision order ───────────────────────────────────

describe('resolveDependency', () => {
  it('short-circuits to registry_unavailable when latestStable is missing', () => {
    const result = resolveDependency(makeDep({ latestStable: undefined }), makeRulebook(), NOW);
    expect(result.reason).toBe('registry_unavailable');
    expect(result.satisfies).toBe(false);
    expect(result.targetVersion).toBeUndefined();
  });

  it('banned with replacement → banned_violated with target version', () => {
    const rulebook = makeRulebook({
      banned: [
        {
          selector: { name: 'react' },
          reason: 'migrate',
          replacement: { ecosystem: 'npm', name: 'preact', minVersion: asVersionRange('^10.0.0') },
        },
      ],
    });
    const result = resolveDependency(makeDep(), rulebook, NOW);
    expect(result.reason).toBe('banned_violated');
    expect(result.satisfies).toBe(false);
    expect(result.targetVersion).toBe('^10.0.0');
    expect(result.ruleEvidence).toEqual([{ rule: 'banned', detail: 'migrate' }]);
  });

  it('banned without replacement → banned_unresolved_replacement', () => {
    const rulebook = makeRulebook({
      banned: [{ selector: { name: 'react' }, reason: 'no successor' }],
    });
    const result = resolveDependency(makeDep(), rulebook, NOW);
    expect(result.reason).toBe('banned_unresolved_replacement');
    expect(result.targetVersion).toBeUndefined();
  });

  it('banned wins over pinned (decision order)', () => {
    const rulebook = makeRulebook({
      banned: [{ selector: { name: 'react' }, reason: 'migrate' }],
      pinned: [{ selector: { name: 'react' }, max: asVersionRange('^19.0.0'), reason: 'stay' }],
    });
    const result = resolveDependency(makeDep(), rulebook, NOW);
    expect(result.reason).toBe('banned_unresolved_replacement');
    expect(result.selectorHits.pinned).toHaveLength(1);
    expect(result.selectorHits.banned).toHaveLength(1);
  });

  it('pinned within max → pinned_within_max, targetVersion = max', () => {
    const rulebook = makeRulebook({
      pinned: [
        { selector: { name: 'react' }, max: asVersionRange('^19.0.0'), reason: 'stay on 19' },
      ],
    });
    const result = resolveDependency(makeDep({ locked: '19.2.7' }), rulebook, NOW);
    expect(result.reason).toBe('pinned_within_max');
    expect(result.satisfies).toBe(true);
    expect(result.targetVersion).toBe('^19.0.0');
  });

  it('pinned above max → pinned_above_max', () => {
    const rulebook = makeRulebook({
      pinned: [
        { selector: { name: 'react' }, max: asVersionRange('^18.0.0'), reason: 'stay on 18' },
      ],
    });
    const result = resolveDependency(makeDep({ locked: '19.2.7' }), rulebook, NOW);
    expect(result.reason).toBe('pinned_above_max');
    expect(result.satisfies).toBe(false);
  });

  it('pinned with unparseable max → pinned_above_max (not satisfied)', () => {
    const rulebook = makeRulebook({
      pinned: [
        { selector: { name: 'react' }, max: asVersionRange('nonsense'), reason: 'broken entry' },
      ],
    });
    const result = resolveDependency(makeDep(), rulebook, NOW);
    expect(result.reason).toBe('pinned_above_max');
    expect(result.satisfies).toBe(false);
  });

  it('deferred until future → deferred_until_future, satisfies', () => {
    const rulebook = makeRulebook({
      deferred: [
        {
          selector: { name: 'react' },
          until: asIsoDateTime('2030-01-01T00:00:00.000Z'),
          reason: 'RC pending',
        },
      ],
    });
    const result = resolveDependency(makeDep(), rulebook, NOW);
    expect(result.reason).toBe('deferred_until_future');
    expect(result.satisfies).toBe(true);
  });

  it('deferred overdue → deferred_overdue, not satisfied', () => {
    const rulebook = makeRulebook({
      deferred: [
        {
          selector: { name: 'react' },
          until: asIsoDateTime('2020-01-01T00:00:00.000Z'),
          reason: 'missed window',
        },
      ],
    });
    const result = resolveDependency(makeDep(), rulebook, NOW);
    expect(result.reason).toBe('deferred_overdue');
    expect(result.satisfies).toBe(false);
  });

  it('deferred with invalid until is treated as overdue', () => {
    const rulebook = makeRulebook({
      deferred: [
        { selector: { name: 'react' }, until: asIsoDateTime('not-a-date'), reason: 'bad entry' },
      ],
    });
    const result = resolveDependency(makeDep(), rulebook, NOW);
    expect(result.reason).toBe('deferred_overdue');
    expect(result.satisfies).toBe(false);
  });

  it('preferred → preferred_no_status_change, satisfies', () => {
    const rulebook = makeRulebook({
      preferred: [{ selector: { name: 'react' }, context: 'house UI framework' }],
    });
    const result = resolveDependency(makeDep(), rulebook, NOW);
    expect(result.reason).toBe('preferred_no_status_change');
    expect(result.satisfies).toBe(true);
    expect(result.targetVersion).toBeUndefined();
  });

  it('no matching rule → unconstrained', () => {
    const result = resolveDependency(makeDep(), makeRulebook(), NOW);
    expect(result.reason).toBe('unconstrained');
    expect(result.satisfies).toBe(true);
    expect(result.ruleEvidence).toEqual([]);
  });

  it('undefined rulebook → unconstrained', () => {
    const result = resolveDependency(makeDep(), undefined, NOW);
    expect(result.reason).toBe('unconstrained');
  });
});

// ── resolveDependencies ──────────────────────────────────────────────────

describe('resolveDependencies', () => {
  it('non-registry sources are always unconstrained and pinned falls back to installed when locked is undefined', () => {
    const pathDep = makeDep({ id: 'dep-path', sourceType: 'path', latestStable: undefined });
    const gitDep = makeDep({ id: 'dep-git', sourceType: 'git', latestStable: undefined });
    const sysDep = makeDep({ id: 'dep-sys', sourceType: 'system', latestStable: undefined });
    const result = resolveDependencies(
      [pathDep, gitDep, sysDep],
      makeRulebook({
        banned: [{ selector: { name: 'react' }, reason: 'migrate' }],
      }),
      NOW,
    );
    expect(result).toHaveLength(3);
    expect(result.every((r) => r.reason === 'unconstrained' && r.satisfies)).toBe(true);

    const pinnedInstalled = resolveDependency(
      makeDep({ locked: undefined, installed: '19.2.7' }),
      makeRulebook({
        pinned: [
          { selector: { name: 'react' }, max: asVersionRange('^19.0.0'), reason: 'stay on 19' },
        ],
      }),
      NOW,
    );
    expect(pinnedInstalled.reason).toBe('pinned_within_max');
    expect(pinnedInstalled.satisfies).toBe(true);
  });

  it('registry dependencies resolve normally', () => {
    const rulebook = makeRulebook({
      banned: [{ selector: { name: 'react' }, reason: 'migrate' }],
    });
    const result = resolveDependencies([makeDep()], rulebook, NOW);
    expect(result[0]?.reason).toBe('banned_unresolved_replacement');
  });

  it('rejects prereleases of the boundary version for partial < comparators such as <18 and <1.2 (F775)', () => {
    expect(satisfiesRange('18.0.0-alpha.1', parseRange(asVersionRange('<18')))).toBe(false);
    expect(satisfiesRange('18.0.0-0', parseRange(asVersionRange('<18')))).toBe(false);
    expect(satisfiesRange('1.2.0-beta.1', parseRange(asVersionRange('<1.2')))).toBe(false);
    expect(satisfiesRange('17.9.9', parseRange(asVersionRange('<18')))).toBe(true);
    expect(satisfiesRange('1.1.9', parseRange(asVersionRange('<1.2')))).toBe(true);
  });
});
