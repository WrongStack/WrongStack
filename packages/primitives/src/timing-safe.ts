/**
 * Constant-time credential comparison.
 *
 * `a !== b` on a secret returns as soon as two bytes differ, so the time it
 * takes leaks how long a guess's shared prefix was — enough to recover a token
 * byte by byte given enough attempts against an endpoint that does not rate
 * limit. The project-daemon IPC servers all compared their `authToken` that
 * way, while every other credential surface in the repo already used
 * `timingSafeEqual` — one of them fixed as WS-110 for exactly this reason.
 *
 * All six now call this helper: chronicle, session-catalog, kanban,
 * codebase-index and mailbox were converted first; SAGE was missed by that
 * sweep and kept a raw `supplied !== authToken` until 2026-09-17. If you add
 * a seventh daemon, it belongs on this list.
 *
 * This lives in `primitives` because it is a dependency leaf and the callers
 * span packages that do not otherwise share code: `@wrongstack/core`,
 * `@wrongstack/kanban`, `@wrongstack/tools`, `@wrongstack/webui-server` and
 * `@wrongstack/acp`. Before this, the same six lines existed as two hand-copied
 * helpers whose docblock said "mirrors `tokenMatches` in the WebUI server" —
 * and four call sites that mirrored nothing.
 *
 * @module timing-safe
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * True when `supplied` equals `expected`, compared in constant time.
 *
 * A length mismatch short-circuits. That is deliberate and safe: `timingSafeEqual`
 * throws on unequal lengths, and the length of a credential is not the secret —
 * these tokens are fixed-width hex. An empty or missing value is always false,
 * so a caller cannot accidentally authenticate an unset token against an unset
 * expectation. Non-string runtime values from wire payloads are rejected before
 * buffer conversion rather than coerced or allowed to throw.
 */
export function timingSafeTokenEqual(supplied: unknown, expected: unknown): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !supplied || !expected) {
    return false;
  }
  // UTF-8 replaces lone surrogates, making distinct strings compare equal.
  const a = Buffer.from(supplied, 'utf16le');
  const b = Buffer.from(expected, 'utf16le');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
