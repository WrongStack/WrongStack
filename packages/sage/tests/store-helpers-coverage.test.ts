import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  normalizeAnchors,
  normalizeAudience,
  normalizeSources,
  scoreMemoryRelationship,
  validateRememberInput,
} from '../src/store-helpers.js';
import type { MemoryAnchor, RememberSageInput, Sage } from '../src/types.js';

function sage(overrides: Partial<Sage> = {}): Sage {
  return {
    id: 'candidate',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: 'memory',
    importance: 0.5,
    confidence: 0.5,
    freshness: 0.5,
    tags: [],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('store helper completion coverage', () => {
  it('normalizes audiences and rejects every invalid audience shape', () => {
    expect(normalizeAudience(undefined)).toBeUndefined();
    expect(normalizeAudience({})).toBeUndefined();
    expect(normalizeAudience({ roles: [' Reviewer ', 'reviewer', ''] })).toEqual({
      roles: ['reviewer'],
    });
    expect(normalizeAudience({ roles: [], taskTypes: [' Test '], modes: [' CODE '] })).toEqual({
      taskTypes: ['test'],
      modes: ['code'],
    });
    for (const invalid of [null, [], 'role']) {
      expect(() => normalizeAudience(invalid as never)).toThrow('must be an object');
    }
    expect(() => normalizeAudience({ roles: 'reviewer' as never })).toThrow(
      'must be an array of strings',
    );
    expect(() => normalizeAudience({ roles: [1 as never] })).toThrow('must be an array of strings');
    expect(() => normalizeAudience({ roles: Array.from({ length: 129 }, () => 'role') })).toThrow(
      'exceeds 128',
    );
    expect(() => normalizeAudience({ roles: ['x'.repeat(257)] })).toThrow('no longer than 256');
  });

  it('normalizes and deduplicates anchors and sources', () => {
    // Use a cwd-derived root so path.relative works identically on every
    // platform (a literal 'C:\\project' root only resolves on Windows).
    const projectRoot = path.join(process.cwd(), 'project');
    const anchors = normalizeAnchors(projectRoot, [
      {
        type: 'file',
        path: path.join(projectRoot, 'src', 'a.ts'),
        symbol: '  ',
        command: '  ',
        role: '  ',
      },
      {
        type: 'file',
        path: path.join(projectRoot, 'src', 'a.ts'),
        symbol: '  ',
        command: '  ',
        role: '  ',
      },
      { type: 'command', command: ' pnpm   test ' },
      { type: 'agent', role: ' Reviewer ' },
    ]);
    expect(anchors).toEqual([
      {
        type: 'file',
        path: 'src/a.ts',
        symbol: undefined,
        command: undefined,
        role: undefined,
      },
      {
        type: 'command',
        path: undefined,
        command: 'pnpm test',
        role: undefined,
        symbol: undefined,
      },
      {
        type: 'agent',
        path: undefined,
        command: undefined,
        role: 'reviewer',
        symbol: undefined,
      },
    ]);

    expect(
      normalizeSources([
        { type: 'file', path: ' src\\a.ts ', command: ' pnpm   test ' },
        { type: 'file', path: ' src\\a.ts ', command: ' pnpm   test ' },
        { type: 'user' },
      ]),
    ).toEqual([
      { type: 'file', path: 'src/a.ts', command: 'pnpm test' },
      { type: 'user', path: undefined, command: undefined },
    ]);
  });

  it('scores every structural relationship and persistence/kind bonus', () => {
    const seed = sage({
      id: 'seed',
      tags: ['shared', 'second', 'third'],
      anchors: [
        { type: 'symbol', path: 'src/a.ts', symbol: 'Run' },
        { type: 'command', command: 'pnpm test unit' },
        { type: 'agent', role: 'reviewer' },
        { type: 'file', path: 'src/a.ts' },
        { type: 'package', path: 'packages/sage' },
      ],
    });
    expect(scoreMemoryRelationship(seed, [seed])).toBe(0);
    expect(scoreMemoryRelationship(sage(), [seed])).toBe(0);
    expect(scoreMemoryRelationship(sage(), [], new Set(['candidate']))).toBeGreaterThan(8);

    const related = sage({
      persistence: 'permanent',
      tags: ['shared', 'second', 'third'],
      anchors: [
        { type: 'symbol', path: 'src/a.ts', symbol: 'run' },
        { type: 'symbol', path: 'src/b.ts', symbol: 'RUN' },
        { type: 'command', command: ' PNPM   TEST unit ' },
        { type: 'command', command: 'pnpm test integration' },
        { type: 'agent', role: 'REVIEWER' },
        { type: 'file', path: 'src/a.ts' },
        { type: 'file', path: 'src/a.ts/child' },
        { type: 'package', path: 'packages/sage/subpackage' },
      ],
    });
    expect(scoreMemoryRelationship(related, [seed])).toBeGreaterThan(50);
    expect(
      scoreMemoryRelationship(
        sage({
          kind: 'preference',
          persistence: 'short_lived',
          anchors: [{ type: 'file', path: 'src/a.ts/child' }],
        }),
        [sage({ id: 'seed-2', anchors: [{ type: 'file', path: 'src/a.ts' }] })],
      ),
    ).toBeGreaterThan(0);
    expect(
      scoreMemoryRelationship(sage({ anchors: [{ type: 'package', path: 'packages/sage' }] }), [
        sage({ id: 'seed-3', anchors: [{ type: 'file', path: 'packages/sage' }] }),
      ]),
    ).toBeGreaterThan(0);
    expect(
      scoreMemoryRelationship(sage({ anchors: [{ type: 'command', command: 'pnpm lint' }] }), [
        sage({ id: 'seed-4', anchors: [{ type: 'command', command: 'npm test' }] }),
      ]),
    ).toBe(0);
  });

  it('rejects oversized metadata, malformed anchors, and invalid sources', () => {
    const minimal: RememberSageInput = { text: 'valid' };
    for (const key of ['tags', 'anchors', 'sources', 'supersedes', 'contradicts'] as const) {
      expect(() =>
        validateRememberInput({
          ...minimal,
          [key]: Array.from({ length: 129 }, () =>
            key === 'anchors'
              ? ({ type: 'file', path: 'src/a.ts' } as MemoryAnchor)
              : key === 'sources'
                ? { type: 'user' }
                : 'value',
          ),
        } as RememberSageInput),
      ).toThrow(`SAGE ${key} exceeds 128 items`);
    }
    expect(() => validateRememberInput({ ...minimal, tags: [1 as never] })).toThrow(
      'tags must be strings',
    );
    expect(() => validateRememberInput({ ...minimal, tags: ['x'.repeat(257)] })).toThrow(
      'tags must be strings',
    );

    for (const anchor of [null, { type: 'invalid' }] as unknown as MemoryAnchor[]) {
      expect(() => validateRememberInput({ ...minimal, anchors: [anchor] })).toThrow(
        'Invalid SAGE anchor type',
      );
    }
    expect(() =>
      validateRememberInput({ ...minimal, anchors: [{ type: 'command', command: ' ' }] }),
    ).toThrow('require a command');
    expect(() =>
      validateRememberInput({ ...minimal, anchors: [{ type: 'agent', role: ' ' }] }),
    ).toThrow('require a role');
    expect(() =>
      validateRememberInput({ ...minimal, anchors: [{ type: 'agent', role: '!invalid' }] }),
    ).toThrow('role is invalid');
    expect(() =>
      validateRememberInput({ ...minimal, anchors: [{ type: 'file', path: ' ' }] }),
    ).toThrow('require a path');
    expect(() =>
      validateRememberInput({
        ...minimal,
        anchors: [{ type: 'symbol', path: 'src/a.ts', symbol: ' ' }],
      }),
    ).toThrow('require a symbol');

    for (const anchor of [
      { type: 'file', path: 'x'.repeat(4_097) },
      { type: 'symbol', path: 'src/a.ts', symbol: 'x'.repeat(1_025) },
      { type: 'command', command: 'x'.repeat(8_193) },
    ] as MemoryAnchor[]) {
      expect(() => validateRememberInput({ ...minimal, anchors: [anchor] })).toThrow(
        'anchor strings are too long',
      );
    }

    for (const source of [null, { type: 'invalid' }]) {
      expect(() => validateRememberInput({ ...minimal, sources: [source as never] })).toThrow(
        'Invalid SAGE source type',
      );
    }
    expect(() =>
      validateRememberInput({
        ...minimal,
        sources: [
          { type: 'user' },
          { type: 'session' },
          { type: 'tool_result' },
          { type: 'project_instruction' },
          { type: 'file' },
          { type: 'test' },
          { type: 'command' },
          { type: 'legacy_memory' },
        ],
      }),
    ).not.toThrow();
  });
});
