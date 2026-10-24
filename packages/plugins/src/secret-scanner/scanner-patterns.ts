import { cloneCredentialPatterns } from '../runtime/credential-patterns.js';

// ---------------------------------------------------------------------------
// Pattern set
// ---------------------------------------------------------------------------
//
// Mirrors the simple patterns in `primitives/src/secret-scrubber-patterns.ts`,
// minus the high-entropy-env detector (which is too slow + too
// false-positive prone for a synchronous pre-tool gate). Adding a new
// pattern here is cheap: each entry is a tuple of (id, regex). The
// combined regex folds every pattern into one pass, with the matched
// group's position used to index into the id list.

export interface Pattern {
  type: string;
  regex: RegExp;
}

/**
 * Base patterns — always present, never removed by custom config.
 * Custom patterns from config are APPENDED at setup() time.
 *
 * The table itself lives in `runtime/credential-patterns` so that
 * `prompt-firewall` (which inspects outgoing provider requests) matches
 * exactly the same credential shapes. The two lists used to be maintained
 * separately and had drifted, so whether a credential was caught depended
 * on which side of the pipeline it crossed.
 */
export const BASE_PATTERNS: Pattern[] = cloneCredentialPatterns();

/**
 * Active pattern set. Starts as a clone of BASE_PATTERNS; setup()
 * appends user-supplied custom patterns from config and rebuilds
 * COMBINED_REGEX. Each live PluginAPI captures its own projection.
 *
 * @internal
 */
export const scannerPatterns = { patterns: [...BASE_PATTERNS], groupIndexes: [] as number[] };

/**
 * Which capture-group index belongs to which pattern.
 *
 * `scannerPatterns.patterns[i]` does NOT necessarily own group `i + 1`: a pattern whose
 * own source contains a capturing group consumes extra slots and shifts
 * every pattern after it. That is not hypothetical — user-supplied
 * `customPatterns` are appended verbatim, so a single custom pattern
 * spelled `(foo|bar)_[0-9]{10}` silently mis-attributed every later
 * pattern's matches (wrong `[REDACTED:<type>]` label, wrong reported
 * type). This table is rebuilt alongside the regex and consulted instead
 * of assuming a 1:1 mapping.
 *
 * @internal
 */

/**
 * Rebuild the combined regex from a pattern array. Each pattern's
 * source is wrapped in a capturing group so findMatches/redactInput
 * can identify which one fired.
 *
 * Performance: only rebuilds when the pattern set has actually changed
 * (detected via patternCacheKey comparison). Avoids expensive regex
 * compilation on every setup() reload when patterns are unchanged.
 *
 * @internal
 */
/**
 * Count the capturing groups in a regex source. Appending `|` makes the
 * whole pattern optional, so `exec('')` always matches and its result
 * length reveals the group count without needing to parse the source.
 */
export function countCaptureGroups(source: string, flags = ''): number {
  try {
    return new RegExp(`${source}|`, flags).exec('')!.length - 1;
  } catch {
    return 0;
  }
}

/**
 * Map a match's capture groups back to the pattern that fired.
 * `groups` is 0-indexed from the first capture group (i.e. `m[1]`).
 */
export function patternTypeForGroups(groups: readonly unknown[]): string | undefined {
  for (let i = 0; i < scannerPatterns.patterns.length; i++) {
    const at = scannerPatterns.groupIndexes[i];
    if (at !== undefined && groups[at] !== undefined) return scannerPatterns.patterns[i]!.type;
  }
  return undefined;
}

export function buildCombinedRegex(patterns: Pattern[]): RegExp {
  // Record each pattern's outer-group offset before its own inner groups.
  const offsets: number[] = [];
  let cursor = 0;
  // One combined regex carries ONE flag set, so per-pattern flags must be
  // unioned in. Dropping them silently changed matching: `json_credential_key`
  // is authored with `i`, and the 'g'-only combined regex missed every
  // case-variant JSON key ("API_KEY", "Password") that prompt-firewall's
  // per-pattern loop and core's scrubber both catch on the same text.
  // Union is also the safe direction for a redaction gate — it can only
  // widen what is matched, never narrow it. Sticky (`y`) is excluded: it
  // would break the exec-loop advancement the scan depends on.
  const flags = new Set<string>(['g']);
  for (const p of patterns) {
    offsets.push(cursor);
    cursor += 1 + countCaptureGroups(p.regex.source, p.regex.flags);
    for (const f of p.regex.flags) if (f !== 'y') flags.add(f);
  }
  scannerPatterns.groupIndexes = offsets;
  return new RegExp(patterns.map((p) => `(${p.regex.source})`).join('|'), [...flags].join(''));
}
