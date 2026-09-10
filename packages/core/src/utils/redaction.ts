/**
 * The one secret-scrubber instance shared by the low-level output paths.
 *
 * Why this module exists rather than each caller constructing its own:
 *
 *  - **One pattern table.** Two scrubbers is two answers to "is this a
 *    secret", and the audit history of this repo is a list of exactly that
 *    kind of divergence (WS-034 found the plugin runtime carrying 37 patterns
 *    while the canonical scrubber carried fewer; WS-066 found one surface
 *    scrubbing and its sibling not).
 *  - **Layering.** `package-boundaries` Rule 7 forbids `infrastructure/` from
 *    importing runtime values out of `security/`, and it is right to: the
 *    layer graph puts `infrastructure` below `security`. But the logger is
 *    precisely where credentials must not be written to disk (WS-SEC-07).
 *    `utils/` sits outside the layer graph as the shared-leaf area that every
 *    layer already depends on — `infrastructure/logger.ts` imports
 *    `utils/color` and `utils/term` today — so the seam belongs here.
 *
 * The dependency on `security/secret-scrubber` is nominal rather than real
 * coupling: that module imports one type and nothing else. The cleaner
 * long-term shape is for the scrubber to live below `security/` outright,
 * since it is a dependency-free string transform that low-level code
 * legitimately needs; that move would change a public export path, so it is
 * left as an owner decision rather than made here.
 *
 * @module utils/redaction
 */

import { DefaultSecretScrubber } from '../security/secret-scrubber.js';

const scrubber = new DefaultSecretScrubber();

/**
 * Redact credential-shaped substrings from text.
 *
 * Cheap on the common path: the scrubber prescans for anchor substrings and
 * skips all regex work when none are present, which covers the large majority
 * of log lines and error messages.
 */
export function redactText(text: string): string {
  return scrubber.scrub(text);
}

/**
 * Redact strings anywhere inside a value, copy-on-write.
 *
 * Clean subtrees come back by reference, so this is affordable on a per-call
 * hot path such as a log sink. The result is only safe to serialize or read —
 * never to mutate — because it shares structure with the input.
 */
export function redactValue<T>(value: T): T {
  return scrubber.scrubObjectShared(value);
}
