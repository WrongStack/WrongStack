/**
 * WS-054 — the JSON-path config helpers had no prototype-pollution guard.
 *
 * `deepMerge` has guarded `FORBIDDEN_PROTO_KEYS` since it was written. These
 * helpers are the *write* path for the same config files and did not.
 *
 * The reachable entry point is not hypothetical: `setJsonPath(full,
 * ['mcpServers', name], …)` is called from four places with `name` taken from
 * user- or agent-supplied MCP server configuration.
 *
 * Two severities, kept straight here because conflating them overstates the
 * finding:
 *
 *   - `['constructor', 'prototype', …]` is the severe one. `ensureJsonParent`
 *     walks intermediate segments, so it traverses to `Object.prototype` and
 *     the assignment lands there — global pollution.
 *   - `__proto__` re-parents only the object it is written on. The intended
 *     property is silently not created and that object inherits
 *     attacker-chosen values, but `Object.prototype` is untouched.
 *
 * Reads and deletes refuse (return "absent"); writes throw. A caller trying to
 * WRITE a prototype key is either a bug or an attack and deserves to be loud,
 * while a caller merely reading one is honestly told the config has no such
 * data.
 */
import { describe, expect, it } from 'vitest';
import { getJsonPath, removeJsonPath, setJsonPath } from '../../src/utils/config-json.js';
import { FORBIDDEN_PROTO_KEYS } from '../../src/utils/deep-merge.js';

/** Detects pollution regardless of which key was used to cause it. */
function pollutionProbe(): Record<string, unknown> {
  return {} as Record<string, unknown>;
}

describe('setJsonPath refuses prototype keys (WS-054)', () => {
  it('blocks the GLOBAL vector: constructor → prototype traversal', () => {
    // The severe case. `ensureJsonParent` walks intermediate segments, so this
    // path reaches Object.prototype and the assignment lands on it.
    const config = {} as Record<string, unknown>;
    expect(() =>
      setJsonPath(config, ['constructor', 'prototype', 'pollutedGlobally'], true),
    ).toThrow(/reserved key/);
    expect((pollutionProbe() as { pollutedGlobally?: unknown }).pollutedGlobally).toBeUndefined();
  });

  it('throws on __proto__ as the leaf — the mcpServers-name case', () => {
    const config = { mcpServers: {} } as Record<string, unknown>;
    expect(() => setJsonPath(config, ['mcpServers', '__proto__'], { inherited: 'x' })).toThrow(
      /reserved key/,
    );
    // Scoped, not global: the object under attack would have been re-parented.
    const servers = config['mcpServers'] as Record<string, unknown>;
    expect(servers['inherited']).toBeUndefined();
    expect(Object.getPrototypeOf(servers)).toBe(Object.prototype);
  });

  it('throws on a prototype key anywhere in the path, not just the leaf', () => {
    const config = {} as Record<string, unknown>;
    expect(() => setJsonPath(config, ['__proto__', 'x'], 1)).toThrow(/reserved key/);
    expect(() => setJsonPath(config, ['a', 'constructor', 'b'], 1)).toThrow(/reserved key/);
    expect(() => setJsonPath(config, ['a', 'prototype'], 1)).toThrow(/reserved key/);
  });

  it('covers every key the sibling helper guards', () => {
    // Pinned against the shared set, so extending FORBIDDEN_PROTO_KEYS
    // automatically extends this guard rather than leaving it behind.
    for (const key of FORBIDDEN_PROTO_KEYS) {
      expect(() => setJsonPath({} as Record<string, unknown>, [key], 1), key).toThrow(
        /reserved key/,
      );
    }
  });

  it('leaves ordinary writes working, including nested creation', () => {
    const config = {} as Record<string, unknown>;
    setJsonPath(config, ['mcpServers', 'github', 'command'], 'npx');
    expect(config).toEqual({ mcpServers: { github: { command: 'npx' } } });
    // A name that merely CONTAINS a reserved word is fine — only exact
    // segments are reserved.
    setJsonPath(config, ['mcpServers', 'my__proto__server'], { ok: true });
    expect((config['mcpServers'] as Record<string, unknown>)['my__proto__server']).toEqual({
      ok: true,
    });
  });

  it('does not pollute even when the value itself is hostile', () => {
    // The guard is about the PATH; a value containing a `__proto__` key is
    // just data as far as an assignment is concerned.
    const config = { a: {} } as Record<string, unknown>;
    setJsonPath(config, ['a', 'b'], JSON.parse('{"__proto__":{"polluted":true}}'));
    expect((pollutionProbe() as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe('getJsonPath / removeJsonPath refuse prototype keys (WS-054)', () => {
  it('reports __proto__ as absent rather than returning the prototype', () => {
    expect(getJsonPath({ a: 1 }, ['__proto__'])).toBeUndefined();
    expect(getJsonPath({ a: 1 }, ['__proto__', 'constructor'])).toBeUndefined();
    expect(getJsonPath({ a: { b: 2 } }, ['a', 'b'])).toBe(2);
  });

  it('refuses to delete through the prototype', () => {
    // `'__proto__' in obj` is true for every plain object, so an unguarded
    // delete branch would run against the prototype and report success.
    expect(removeJsonPath({ a: 1 } as Record<string, unknown>, ['__proto__'])).toBe(false);
    const config = { a: 1 } as Record<string, unknown>;
    expect(removeJsonPath(config, ['a'])).toBe(true);
    expect(config['a']).toBeUndefined();
  });
});
