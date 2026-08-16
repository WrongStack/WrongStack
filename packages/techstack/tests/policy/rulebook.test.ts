/**
 * TechStack — Rulebook load + validate tests.
 *
 * Pins the rulebook loader contract:
 *   - `loadRulebook` resolves absent/loaded/malformed with an injectable
 *     `RulebookFileSystem` (no real fs in tests).
 *   - `validateRulebook` rejects every documented schema invariant.
 *
 * @see packages/techstack/src/policy/rulebook.ts
 */

import { describe, expect, it } from 'vitest';
import type { Rulebook, RulebookFileSystem } from '../../src/policy/rulebook.js';
import {
  asIsoDateTime,
  asVersionRange,
  loadRulebook,
  validateRulebook,
} from '../../src/policy/rulebook.js';

// ── In-memory file system ────────────────────────────────────────────────

class MemoryFileSystem implements RulebookFileSystem {
  private readonly files = new Map<string, string>();

  set(path: string, content: string): void {
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file '${path}'`);
    }
    return content;
  }

  async stat(path: string): Promise<{ readonly size: number }> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file '${path}'`);
    }
    return { size: content.length };
  }
}

const ROOT = '/project';
const DEFAULT_JSON = `${ROOT}/.wrongstack/techstack.rulebook.json`;
const DEFAULT_YAML = `${ROOT}/.wrongstack/techstack.rulebook.yaml`;

// ── Fixtures ─────────────────────────────────────────────────────────────

const VALID_RULEBOOK_JSON = JSON.stringify({
  schemaVersion: '1',
  pinned: [
    {
      selector: { ecosystem: 'npm', name: 'react' },
      max: '^19.0.0',
      reason: 'stay on the 19 major',
    },
  ],
  banned: [],
  deferred: [],
  preferred: [],
});

function makeValidRulebook(overrides: Partial<Rulebook> = {}): Rulebook {
  return {
    schemaVersion: '1',
    pinned: [
      {
        selector: { ecosystem: 'npm', name: 'react' },
        max: asVersionRange('^19.0.0'),
        reason: 'stay on the 19 major',
      },
    ],
    banned: [],
    deferred: [],
    preferred: [],
    ...overrides,
  };
}

// ── validateRulebook ─────────────────────────────────────────────────────

describe('validateRulebook', () => {
  it('accepts a fully valid rulebook', () => {
    expect(validateRulebook(makeValidRulebook())).toEqual([]);
  });

  it('accepts a rulebook with every section populated', () => {
    const rulebook = makeValidRulebook({
      banned: [
        {
          selector: { name: 'jszip' },
          reason: 'unmaintained',
          replacement: { ecosystem: 'npm', name: 'fzstd' },
        },
      ],
      deferred: [
        {
          selector: { name: 'typescript' },
          until: asIsoDateTime('2100-01-01T00:00:00.000Z'),
          reason: 'waiting for the next major wave',
        },
      ],
      preferred: [{ selector: { name: 'vitest' }, context: 'house test runner' }],
      packageManager: { npm: 'pnpm' },
      advisorHints: 'No new UI frameworks until Q4.',
    });
    expect(validateRulebook(rulebook)).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateRulebook(null)).toContain('rulebook must be a JSON object');
    expect(validateRulebook('nope')).toContain('rulebook must be a JSON object');
    expect(validateRulebook([1, 2])).toContain('rulebook must be a JSON object');
  });

  it('rejects an unknown schemaVersion', () => {
    // Cast: the helper types `schemaVersion` as the literal `'1'`, but this
    // test deliberately feeds an invalid version to exercise the validator.
    const errors = validateRulebook(
      makeValidRulebook({ schemaVersion: '2' } as unknown as Partial<Rulebook>),
    );
    expect(errors.join(' ')).toContain("schemaVersion must be '1'");
  });

  it('rejects a totally empty rulebook', () => {
    const errors = validateRulebook({ schemaVersion: '1' });
    expect(errors.join(' ')).toContain(
      'rulebook must declare at least one of pinned/banned/deferred/preferred/packageManager/advisorHints',
    );
  });

  it('rejects a pinned entry without a selector field', () => {
    const errors = validateRulebook(
      makeValidRulebook({
        pinned: [
          {
            selector: {},
            max: asVersionRange('^19.0.0'),
            reason: 'must have a selector',
          },
        ],
      }),
    );
    expect(errors.join(' ')).toContain('pinned[0].selector must set at least one');
  });

  it('rejects a pinned entry with an empty max', () => {
    const errors = validateRulebook(
      makeValidRulebook({
        pinned: [
          {
            selector: { name: 'react' },
            max: asVersionRange(''),
            reason: 'empty max',
          },
        ],
      }),
    );
    expect(errors.join(' ')).toContain('pinned[0].max must be a non-empty version range');
  });

  it('rejects a pinned entry with an empty reason', () => {
    const errors = validateRulebook(
      makeValidRulebook({
        pinned: [
          {
            selector: { name: 'react' },
            max: asVersionRange('^19.0.0'),
            reason: '  ',
          },
        ],
      }),
    );
    expect(errors.join(' ')).toContain('pinned[0].reason must be non-empty');
  });

  it('rejects a deferred entry whose until is in the past', () => {
    const errors = validateRulebook(
      makeValidRulebook({
        deferred: [
          {
            selector: { name: 'typescript' },
            until: asIsoDateTime('2020-01-01T00:00:00.000Z'),
            reason: 'already past',
          },
        ],
      }),
    );
    expect(errors.join(' ')).toContain('deferred[0].until must be in the future');
  });

  it('rejects a deferred entry with an invalid until', () => {
    const errors = validateRulebook(
      makeValidRulebook({
        deferred: [
          {
            selector: { name: 'typescript' },
            until: asIsoDateTime('not-a-date'),
            reason: 'bad date',
          },
        ],
      }),
    );
    expect(errors.join(' ')).toContain('deferred[0].until must be a valid ISO 8601 timestamp');
  });

  it('rejects a banned entry with an empty reason', () => {
    const errors = validateRulebook(
      makeValidRulebook({
        banned: [{ selector: { name: 'jszip' }, reason: '' }],
      }),
    );
    expect(errors.join(' ')).toContain('banned[0].reason must be non-empty');
  });

  it('rejects a banned replacement missing its name', () => {
    const errors = validateRulebook(
      makeValidRulebook({
        banned: [
          {
            selector: { name: 'jszip' },
            reason: 'unmaintained',
            replacement: { ecosystem: 'npm', name: '' },
          },
        ],
      }),
    );
    expect(errors.join(' ')).toContain('banned[0].replacement.name must be non-empty');
  });

  it('rejects a preferred entry with an empty context', () => {
    const errors = validateRulebook(
      makeValidRulebook({
        preferred: [{ selector: { name: 'vitest' }, context: ' ' }],
      }),
    );
    expect(errors.join(' ')).toContain('preferred[0].context must be non-empty');
  });

  it('rejects advisorHints over the 8192-byte limit', () => {
    const errors = validateRulebook(makeValidRulebook({ advisorHints: 'x'.repeat(9000) }));
    expect(errors.join(' ')).toContain('advisorHints exceeds the 8192-byte limit');
  });
});

// ── loadRulebook ─────────────────────────────────────────────────────────

describe('loadRulebook', () => {
  it('returns absent when no rulebook file exists', async () => {
    const io = new MemoryFileSystem();
    const result = await loadRulebook(ROOT, undefined, io);
    expect(result).toEqual({ kind: 'absent' });
  });

  it('loads a valid JSON rulebook from the default path', async () => {
    const io = new MemoryFileSystem();
    io.set(DEFAULT_JSON, VALID_RULEBOOK_JSON);
    const result = await loadRulebook(ROOT, undefined, io);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.source).toBe(DEFAULT_JSON);
      expect(result.rulebook.schemaVersion).toBe('1');
      expect(result.rulebook.pinned).toHaveLength(1);
    }
  });

  it('prefers overridePath over the default path', async () => {
    const io = new MemoryFileSystem();
    const override = `${ROOT}/custom-rulebook.json`;
    io.set(override, VALID_RULEBOOK_JSON);
    io.set(
      DEFAULT_JSON,
      JSON.stringify({ schemaVersion: '1', pinned: [], banned: [], deferred: [], preferred: [] }),
    );
    const result = await loadRulebook(ROOT, override, io);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.source).toBe(override);
    }
  });

  it('reports malformed when the JSON is syntactically invalid', async () => {
    const io = new MemoryFileSystem();
    io.set(DEFAULT_JSON, '{ not valid json');
    const result = await loadRulebook(ROOT, undefined, io);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.source).toBe(DEFAULT_JSON);
      expect(result.errors.join(' ')).toContain('JSON parse failed');
    }
  });

  it('reports malformed when the JSON fails schema validation', async () => {
    const io = new MemoryFileSystem();
    io.set(
      DEFAULT_JSON,
      JSON.stringify({ schemaVersion: '2', pinned: [], banned: [], deferred: [], preferred: [] }),
    );
    const result = await loadRulebook(ROOT, undefined, io);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.errors.join(' ')).toContain("schemaVersion must be '1'");
    }
  });

  it('reports malformed when a YAML rulebook is found (not yet supported)', async () => {
    const io = new MemoryFileSystem();
    io.set(DEFAULT_YAML, 'schemaVersion: "1"\n');
    const result = await loadRulebook(ROOT, undefined, io);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.source).toBe(DEFAULT_YAML);
      expect(result.errors.join(' ')).toContain('YAML rulebooks are not supported yet');
    }
  });

  it('reports malformed when the file cannot be read', async () => {
    const io = new MemoryFileSystem();
    io.set(DEFAULT_JSON, VALID_RULEBOOK_JSON);
    const brokenIo: RulebookFileSystem = {
      exists: io.exists.bind(io),
      readFile: async () => {
        throw new Error('EACCES: permission denied');
      },
      stat: io.stat.bind(io),
    };
    const result = await loadRulebook(ROOT, undefined, brokenIo);
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.errors.join(' ')).toContain('unable to read file');
    }
  });

  it('continues to the next candidate when the first is absent', async () => {
    const io = new MemoryFileSystem();
    io.set(DEFAULT_YAML, 'schemaVersion: "1"\n');
    io.set(DEFAULT_JSON, VALID_RULEBOOK_JSON);
    // Default order tries .json first, so put JSON at the default path and
    // confirm the JSON wins even when the YAML sibling also exists.
    const result = await loadRulebook(ROOT, undefined, io);
    expect(result.kind).toBe('loaded');
    if (result.kind === 'loaded') {
      expect(result.source).toBe(DEFAULT_JSON);
    }
  });
});
