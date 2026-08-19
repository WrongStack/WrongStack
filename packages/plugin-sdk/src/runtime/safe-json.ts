/**
 * @wrongstack/plugins — serialisation that cannot take the process down.
 *
 * Plugins routinely stringify values they did not construct: event-bus
 * payloads, tool results, mailbox bodies. `JSON.stringify` throws on a
 * circular reference and on `BigInt`, and several of these call sites sit
 * inside detached (fire-and-forget) work where a throw becomes an
 * unhandled rejection rather than a handled failure.
 *
 * `safeJsonStringify` never throws. A value it cannot represent is
 * replaced with a marker, so the surrounding feature degrades to "this
 * field is unreadable" instead of failing — or crashing — outright.
 */

/** Placeholder substituted for a value that cannot be serialised. */
export const UNSERIALIZABLE = '[unserializable]';

/**
 * `JSON.stringify` with cycle handling and a total-failure fallback.
 *
 * @param value  anything
 * @param indent passed through to `JSON.stringify` (e.g. `2` to pretty-print)
 * @returns a JSON string, or a marker string when the value resists
 *          serialisation entirely. Never throws.
 */
export function safeJsonStringify(value: unknown, indent?: number): string {
  try {
    // A `WeakSet` of the ancestors currently on the stack: replacing only
    // true cycles keeps repeated-but-acyclic references intact, which a
    // naive "seen everything" set would mangle into false positives.
    const stack: unknown[] = [];
    const out = JSON.stringify(
      value,
      function replacer(this: unknown, _key: string, val: unknown): unknown {
        if (typeof val === 'bigint') return `${val.toString()}n`;
        if (val === null || typeof val !== 'object') return val;
        // `this` is the container being serialised; unwind the stack back
        // to it before testing membership.
        while (stack.length > 0 && stack[stack.length - 1] !== this) stack.pop();
        if (stack.includes(val)) return '[circular]';
        stack.push(val);
        return val;
      },
      indent,
    );
    // `JSON.stringify(undefined)` is `undefined`, not a string.
    return out ?? String(value);
  } catch {
    return UNSERIALIZABLE;
  }
}
