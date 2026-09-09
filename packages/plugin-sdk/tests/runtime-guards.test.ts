import { describe, expect, it } from 'vitest';
import {
  cloneCredentialPatterns,
  CREDENTIAL_PATTERNS,
} from '../src/runtime/credential-patterns.js';
import { guardedMatcher, withReDoSGuard } from '../src/runtime/redos-guard.js';
import { safeJsonStringify, UNSERIALIZABLE } from '../src/runtime/safe-json.js';

/**
 * The published SDK offers plugin authors three defensive helpers and shipped
 * with no test for any of them. Each one below is a promise a plugin relies on
 * without being able to verify it.
 */

describe('safeJsonStringify', () => {
  it('serializes ordinary values like JSON.stringify', () => {
    expect(safeJsonStringify({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(safeJsonStringify([1, 2], 2)).toBe('[\n  1,\n  2\n]');
  });

  it('survives a cycle instead of throwing', () => {
    // The contract is "never throws": a plugin logging its own state must not
    // take the host down because the state points at itself.
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    const out = safeJsonStringify(node);
    expect(out).toContain('"name":"root"');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('keeps a repeated-but-acyclic reference rather than calling it a cycle', () => {
    // A naive seen-everything set turns shared structure into false cycles and
    // silently drops real data.
    const shared = { id: 7 };
    const out = safeJsonStringify({ a: shared, b: shared });
    expect(out).toBe('{"a":{"id":7},"b":{"id":7}}');
  });

  it('represents a bigint instead of throwing on it', () => {
    // JSON.stringify throws outright on bigint.
    expect(safeJsonStringify({ n: 10n })).toContain('10n');
  });

  it('falls back to a marker when a value resists serialization entirely', () => {
    const hostile = {
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(safeJsonStringify(hostile)).toBe(UNSERIALIZABLE);
  });
});

describe('credential patterns', () => {
  const find = (text: string): string[] =>
    cloneCredentialPatterns()
      .filter((p) => p.regex.test(text))
      .map((p) => p.type);

  it('detects the provider and forge tokens it names', () => {
    expect(find(`sk-ant-api03-${'a'.repeat(40)}`)).toContain('anthropic_key');
    expect(find(`sk-proj-${'b'.repeat(40)}`)).toContain('openai_key');
    expect(find(`ghp_${'c'.repeat(36)}`)).toContain('github_pat');
    // gho_/ghu_/ghs_/ghr_ grant the same or broader access than ghp_.
    for (const prefix of ['gho', 'ghu', 'ghs', 'ghr']) {
      expect(find(`${prefix}_${'d'.repeat(36)}`), prefix).toContain('github_oauth_token');
    }
  });

  it('does not fire on ordinary prose containing the prefixes', () => {
    expect(find('the sk-ant prefix identifies Anthropic keys')).toEqual([]);
    expect(find('see ghp_ tokens in the docs')).toEqual([]);
  });

  it('hands out independently-stateful copies', () => {
    // A global regex carries `lastIndex`; sharing one across scans makes the
    // second scan start mid-string and miss the secret at position 0.
    const first = cloneCredentialPatterns();
    const second = cloneCredentialPatterns();
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.regex).not.toBe(CREDENTIAL_PATTERNS[0]?.regex);

    const secret = `sk-ant-api03-${'a'.repeat(40)}`;
    const a = first.find((p) => p.type === 'anthropic_key');
    const b = second.find((p) => p.type === 'anthropic_key');
    expect(a?.regex.test(secret)).toBe(true);
    // `a` now carries a non-zero lastIndex. A caller that reused ONE instance
    // across scans would resume from there and miss a secret at position 0 —
    // which is exactly what a fresh copy prevents.
    expect(a?.regex.lastIndex).toBeGreaterThan(0);
    expect(b?.regex.lastIndex).toBe(0);
    expect(b?.regex.test(secret)).toBe(true);
  });

  it('gives every pattern a stable id and the global flag', () => {
    const ids = CREDENTIAL_PATTERNS.map((p) => p.type);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pattern of CREDENTIAL_PATTERNS) {
      expect(pattern.regex.flags, pattern.type).toContain('g');
    }
  });
});

describe('withReDoSGuard', () => {
  it('returns the match for a well-behaved regex', async () => {
    const result = await withReDoSGuard(/(\d+)-(\d+)/, 'order 12-34');
    expect(result.timedOut).toBe(false);
    expect(result.match?.[1]).toBe('12');
    expect(result.match?.[2]).toBe('34');
  });

  it('reports no match without timing out', async () => {
    const result = await withReDoSGuard(/zzz/, 'abc');
    expect(result).toEqual({ timedOut: false, match: null });
  });

  it('terminates a catastrophically backtracking regex within the budget', async () => {
    // (a+)+$ against a long non-matching run is the textbook ReDoS shape; the
    // point of the guard is that the host survives it.
    const started = Date.now();
    const result = await withReDoSGuard(/^(a+)+$/, `${'a'.repeat(40)}b`, 100);
    expect(result.timedOut).toBe(true);
    expect(result.match).toBeNull();
    // Generous ceiling: the assertion is "bounded", not "exact".
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('invokes onTimeout once with the offending regex', async () => {
    const seen: Array<{ budgetMs: number }> = [];
    await withReDoSGuard(/^(a+)+$/, `${'a'.repeat(40)}b`, 100, {
      onTimeout: (info) => seen.push(info),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.budgetMs).toBe(100);
  }, 20_000);

  it('guardedMatcher binds a regex and budget for repeated use', async () => {
    const match = guardedMatcher(/(\w+)@(\w+)/, 100);
    await expect(match('mail a@b here')).resolves.toMatchObject({ timedOut: false });
    await expect(match('nothing here')).resolves.toEqual({ timedOut: false, match: null });
  }, 20_000);
});
