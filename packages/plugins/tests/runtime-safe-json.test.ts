/**
 * @wrongstack/plugins — safeJsonStringify tests.
 *
 * Several plugins stringify values they did not construct (event-bus
 * payloads, handoff results, mailbox bodies). `JSON.stringify` throws on a
 * circular reference and on `BigInt`; in `notify-hub` that throw happened
 * inside a detached delivery, so an odd payload became an unhandled
 * rejection rather than a skipped notification.
 */
import { describe, expect, it } from 'vitest';
import { UNSERIALIZABLE, safeJsonStringify } from '../src/runtime/index.js';

describe('safeJsonStringify', () => {
  it('matches JSON.stringify for ordinary values', () => {
    for (const v of [null, 1, 'x', true, [1, 2], { a: 1, b: [2, { c: 3 }] }]) {
      expect(safeJsonStringify(v)).toBe(JSON.stringify(v));
    }
  });

  it('honours the indent argument', () => {
    expect(safeJsonStringify({ a: 1 }, 2)).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('does not throw on a self-referencing object', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    const out = safeJsonStringify(cyclic);
    expect(out).toContain('"name":"root"');
    expect(out).toContain('[circular]');
  });

  it('does not throw on a cycle nested deep in the graph', () => {
    const inner: Record<string, unknown> = {};
    const outer = { a: { b: { c: inner } } };
    inner['back'] = outer;
    expect(() => safeJsonStringify(outer)).not.toThrow();
    expect(safeJsonStringify(outer)).toContain('[circular]');
  });

  it('keeps a repeated but acyclic reference intact', () => {
    // A naive "seen once" guard would wrongly collapse the second
    // occurrence into a cycle marker.
    const shared = { v: 1 };
    const out = safeJsonStringify({ a: shared, b: shared });
    expect(out).toBe('{"a":{"v":1},"b":{"v":1}}');
    expect(out).not.toContain('[circular]');
  });

  it('renders BigInt instead of throwing on it', () => {
    expect(safeJsonStringify({ n: 10n })).toBe('{"n":"10n"}');
  });

  it('returns a string for undefined rather than undefined', () => {
    expect(typeof safeJsonStringify(undefined)).toBe('string');
  });

  it('falls back to a marker when a getter throws', () => {
    const hostile = {
      get boom(): never {
        throw new Error('nope');
      },
    };
    expect(safeJsonStringify(hostile)).toBe(UNSERIALIZABLE);
  });

  it('falls back to a marker when toJSON throws', () => {
    const hostile = {
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(safeJsonStringify(hostile)).toBe(UNSERIALIZABLE);
  });
});
