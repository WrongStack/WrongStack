/**
 * Constant-time credential comparison.
 *
 * `a !== b` on a secret returns as soon as two bytes differ, so the time it
 * takes leaks how long a guess's shared prefix was — enough to recover a token
 * byte by byte given enough attempts against an endpoint that does not rate
 * limit. The four project-daemon IPC servers (chronicle, session-catalog,
 * kanban, codebase-index) all compared their `authToken` that way, while every
 * other credential surface in the repo already used `timingSafeEqual` — one of
 * them fixed as WS-110 for exactly this reason.
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
 * expectation.
 */
export function timingSafeTokenEqual(
  supplied: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
