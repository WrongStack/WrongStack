import { describe, expect, it } from 'vitest';
import {
  memoryFormatCoverage as formatCoverage,
  formatMemoryHintsDetailed,
} from '../src/retrieval/format.js';
import { memoryQueryRelevance, memoryStructuralRelevance } from '../src/retrieval/relevance.js';
import type { Sage } from '../src/types.js';

function sage(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'memory',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: 'alpha beta gamma delta',
    importance: 0.8,
    confidence: 0.8,
    freshness: 1,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026',
    updatedAt: '2026',
    ...overrides,
  };
}

describe('memory hint formatting completion coverage', () => {
  it('formats permanent memories, tags, agent anchors, and every relation type', () => {
    const memories = [
      sage({
        id: 'agent',
        persistence: 'permanent',
        anchors: [{ type: 'agent', role: 'reviewer' }],
        tags: ['one', 'two', 'three', 'ignored'],
      }),
      sage({ id: 'test', anchors: [{ type: 'test', path: 'tests/a.ts' }] }),
      sage({ id: 'git', anchors: [{ type: 'git', path: 'src/a.ts' }] }),
      sage({ id: 'directory', anchors: [{ type: 'directory', path: 'src' }] }),
      sage({ id: 'package', anchors: [{ type: 'package', path: 'packages/sage' }] }),
      sage({ id: 'command', anchors: [{ type: 'command', command: 'pnpm test' }] }),
    ];
    const result = formatMemoryHintsDetailed(memories, { maxChars: 10_000 });
    expect(result.text).toContain('[permanent]');
    expect(result.text).toContain('(agent:reviewer)');
    expect(result.text).toContain('tags=one,two,three');
    for (const relation of [
      'about_agent',
      'about_file',
      'about_directory',
      'about_package',
      'about_command',
    ]) {
      expect(result.text).toContain(`relation=${relation}`);
    }
  });

  it('escapes every line separator and safely truncates whitespace', () => {
    const result = formatMemoryHintsDetailed(
      [
        sage({
          text: `line\r\nsecond\u2028third\u2029${' '.repeat(20)}`,
        }),
      ],
      { maxChars: 90 },
    );
    expect(result.text).toContain('\\r\\n');
    expect(result.text).toContain('\\u2028');
    expect(result.text).toContain('\\u2029');
    expect(result.text).toContain('…</memory>');
    expect(formatCoverage.formatPrimaryRelation(sage())).toBe('related_to');
  });
});

describe('query relevance completion coverage', () => {
  it('handles empty, exact anchor, and missing queries', () => {
    expect(memoryQueryRelevance(sage(), 'the file and code')).toEqual({
      strength: 0,
      evidence: [],
    });
    expect(
      memoryQueryRelevance(
        sage({ anchors: [{ type: 'symbol', path: 'src/a.ts', symbol: 'SpecificSymbol' }] }),
        'please inspect SpecificSymbol',
      ),
    ).toEqual({ strength: 0.98, evidence: ['query:exact-symbol'] });
    expect(
      memoryQueryRelevance(
        sage({ anchors: [{ type: 'file', path: 'src\\specific-file.ts' }] }),
        'inspect ./src/specific-file.ts',
      ),
    ).toEqual({ strength: 0.96, evidence: ['query:exact-file'] });
    expect(memoryQueryRelevance(sage(), 'totally unrelated terms')).toEqual({
      strength: 0,
      evidence: [],
    });
  });

  it('scores anchor, tag, and textual term match tiers', () => {
    const anchored = memoryQueryRelevance(
      sage({ anchors: [{ type: 'file', path: 'src/authentication/token-validator.ts' }] }),
      'authentication token-validator',
    );
    expect(anchored.strength).toBeGreaterThanOrEqual(0.83);
    expect(anchored.evidence[0]).toContain('anchor-terms');

    const tagged = memoryQueryRelevance(
      sage({ text: 'unrelated', tags: ['authentication', 'authorization', 'security'] }),
      'authentication authorization security',
    );
    expect(tagged.strength).toBeGreaterThanOrEqual(0.84);
    expect(tagged.evidence).toEqual(expect.arrayContaining([expect.stringContaining('tag-terms')]));

    expect(memoryQueryRelevance(sage(), 'alpha beta gamma delta').strength).toBe(0.86);
    expect(memoryQueryRelevance(sage(), 'alpha beta').strength).toBe(0.7);
    expect(memoryQueryRelevance(sage(), 'alpha').strength).toBe(0.66);
    expect(memoryQueryRelevance(sage(), 'alpha unmatched broad query').strength).toBe(0);
  });

  it('ignores unusable exact anchors and corroborates graph relationships', () => {
    const unusable = sage({
      anchors: [{ type: 'file', path: '.' }, { type: 'symbol', symbol: 'ab' }, { type: 'command' }],
    });
    expect(memoryQueryRelevance(unusable, 'unrelated something')).toEqual({
      strength: 0,
      evidence: [],
    });

    const target = sage({
      anchors: [{ type: 'file', path: 'src/shared.ts' }],
      tags: ['security', 'tokens'],
    });
    expect(
      memoryStructuralRelevance(target, [
        sage({ id: 'seed', anchors: [{ type: 'file', path: 'src/shared.ts' }] }),
      ]),
    ).toEqual({
      strength: 0.86,
      evidence: ['graph:shared-anchor:file:src/shared.ts'],
    });
    expect(
      memoryStructuralRelevance(target, [
        sage({ id: 'seed', tags: ['security', 'tokens', 'other'] }),
      ]),
    ).toEqual({
      strength: 0.72,
      evidence: ['graph:shared-tags:security,tokens'],
    });
    expect(memoryStructuralRelevance(target, [sage({ id: 'seed' })])).toEqual({
      strength: 0,
      evidence: [],
    });
    expect(memoryStructuralRelevance(unusable, [unusable])).toEqual({
      strength: 0,
      evidence: [],
    });
  });
});
