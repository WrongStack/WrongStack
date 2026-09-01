import type { SecretScrubber } from '../types/secret-scrubber.js';

interface Pattern {
  type: string;
  regex: RegExp;
  /**
   * Cheap literal substring(s) that MUST appear in any text this pattern could
   * match. `scrub()` short-circuits on these before running a single regex, so
   * a pattern whose anchor is missing from the set is silently never applied.
   *
   * WS-034: the anchor set used to be a separate hand-maintained list of
   * `text.includes(...)` calls. It had already drifted — adding a pattern here
   * without remembering to add its anchor there disabled the new pattern
   * entirely, with no test failure and no warning. The field is required, so
   * the compiler now refuses a pattern that has not declared one, and the set
   * is derived from this table rather than written twice.
   */
  anchor: string | readonly string[];
}

/**
 * Pre-scan literals for `json_credential_key`.
 *
 * The anchor must be a literal substring that MUST appear in anything the
 * pattern can match, and the pre-scan uses case-sensitive `String.includes`
 * while the pattern itself is case-insensitive — so the casings are enumerated
 * here rather than relying on the regex flag.
 *
 * Anchoring on `word + closing quote` rather than `opening quote + word` is
 * what lets the pattern accept a prefixed key (`"anthropicApiKey"`) while still
 * ignoring prose that merely mentions the word — `the token was rotated` does
 * not contain `token"`. Over-matching here is free: the anchor only decides
 * whether the regex pass runs at all.
 */
const JSON_CREDENTIAL_KEY_ANCHORS: readonly string[] = [
  'Key"',
  'key"',
  'KEY"',
  'token"',
  'Token"',
  'TOKEN"',
  'secret"',
  'Secret"',
  'SECRET"',
  'password"',
  'Password"',
  'PASSWORD"',
  'authorization"',
  'Authorization"',
  'bearer"',
  'Bearer"',
];

const PATTERNS: Pattern[] = [
  // Anchored at the start where possible so partial matches inside larger
  // strings don't trigger false positives.
  {
    type: 'anthropic_key',
    regex: /(?<![A-Za-z0-9])sk-ant-api\d+-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    anchor: 'sk-ant-',
  },
  { type: 'openai_key', regex: /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g, anchor: 'sk-' },
  {
    // `xai` is a first-class provider in this codebase, but its key shape was
    // absent here — so the one credential format WrongStack itself hands users
    // was the one the scrubber could not recognize (audit 2026-08-20).
    type: 'xai_key',
    regex: /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    anchor: 'xai-',
  },
  { type: 'github_pat', regex: /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/g, anchor: 'ghp_' },
  { type: 'github_pat_v2', regex: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9])/g, anchor: 'github_pat_' },
  { type: 'aws_access_key', regex: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, anchor: 'AKIA' },
  { type: 'gcp_key', regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9])/g, anchor: 'AIza' },
  { type: 'slack_token', regex: /(?<![A-Za-z0-9-])xox[abpos]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g, anchor: 'xox' },
  {
    type: 'stripe_key',
    regex: /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/g,
    anchor: 'sk_',
  },
  {
    type: 'twilio_sid', regex: /(?<![A-Za-z0-9])AC[a-f0-9]{32}(?![A-Za-z0-9])/g,
    anchor: 'AC',
  },
  {
    type: 'telegram_bot_token',
    // Telegram tokens are of the form  bot<digits>:<alphanum>  in URL paths
    regex: /\/bot\d+:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    anchor: '/bot',
  },
  {
    type: 'jwt',
    // Anchored: look for literal "eyJ" which is unambiguous for JWT header
    regex:
      /(?<![A-Za-z0-9/+=])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9/+=])/g,
    anchor: 'eyJ',
  },
  {
    type: 'private_key',
    // Anchored: start must be BEGIN, end must be END with no extra dashes after END
    regex:
      /(?:^|\n)-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP)? ?PRIVATE KEY-----[\s\S]*?-----END[^-]*-----(?:\n|$)/g,
    anchor: '-----BEGIN',
  },
  { type: 'mongodb_uri', regex: /mongodb(?:\+srv)?:\/\/[^\s"'`]+/g, anchor: 'mongodb' },
  { type: 'postgres_uri', regex: /postgres(?:ql)?:\/\/[^\s"'`]+/g, anchor: 'postgres' },
  { type: 'mysql_uri', regex: /mysql:\/\/[^\s"'`]+/g, anchor: 'mysql://' },
  { type: 'redis_uri', regex: /redis:\/\/[^\s"'`]+/g, anchor: 'redis://' },
  // AI/ML provider keys — modern LLM services with well-known prefixes
  {
    type: 'huggingface_token',
    // HuggingFace tokens: hf_ followed by 34 alphanumeric chars
    regex: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{34}(?![A-Za-z0-9])/g,
    anchor: 'hf_',
  },
  {
    type: 'replicate_token',
    // Replicate tokens: r8_ followed by 40+ alphanumeric chars
    regex: /(?<![A-Za-z0-9])r8_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
    anchor: 'r8_',
  },
  {
    type: 'perplexity_key',
    // Perplexity API keys: pplx- followed by 40+ alphanumeric chars
    regex: /(?<![A-Za-z0-9])pplx-[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
    anchor: 'pplx-',
  },
  {
    type: 'groq_key',
    // Groq API keys: gsk_ followed by 40+ alphanumeric chars
    regex: /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
    anchor: 'gsk_',
  },
  {
    type: 'bearer_token',
    // Anchored with alternation instead of negative lookahead — avoids V8
    // backtracking risk on adversarial input. Bounded at 512 chars.
    // Min 12 chars: some OAuth providers issue shorter-lived tokens (< 20
    // chars). A 12-char base64 string has ~71 bits of entropy — above the
    // threshold where random strings are unlikely to produce false matches.
    // The trailing boundary is a NON-consuming lookahead: two adjacent bearer
    // tokens sharing a single delimiter (`Bearer a… Bearer b…`) must both be
    // redacted. A consuming trailing delimiter would eat the separator the
    // next match needs for its leading anchor, leaking the second token.
    regex: /(?:^|[^A-Za-z0-9_.~+/-])Bearer\s+[A-Za-z0-9._~+/-]{12,512}=*(?=$|[^A-Za-z0-9_.~+/-])/g,
    anchor: 'Bearer',
  },
  {
    type: 'high_entropy_env',
    // Anchored with alternation instead of lookbehind to avoid backtracking.
    // Value bounded at 512 chars.
    // The trailing boundary is a NON-consuming lookahead so two secrets
    // separated by a single delimiter (one space OR one newline, e.g.
    // `printenv` / `.env` dumps: `API_KEY=… \n SESSION_TOKEN=…`) are BOTH
    // redacted. A consuming trailing `\s` would swallow the separator the
    // next match needs for its leading anchor, so every other secret would
    // leak in plaintext.
    // The leading delimiter is CAPTURED (group 1) and re-emitted by the
    // replacement so the separator between adjacent secrets is preserved
    // rather than collapsed. Capture groups are therefore: 1=leading
    // delimiter, 2=key name, 3=value.
    regex: /(^|\s)([A-Z_]{4,}(?:KEY|TOKEN|SECRET|PASSWORD|PWD|PASSPHRASE))\s*[:=]\s*['"]?([A-Za-z0-9_/+=-]{20,512})['"]?(?=\s|$)/g,
    anchor: ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PWD', 'PASSPHRASE'],
  },
  {
    type: 'json_credential_key',
    // The JSON counterpart to `high_entropy_env`, and the pattern that the
    // now-deleted `JSON_KEY_ANCHORS` list was written for. Without it those
    // anchors only widened the cheap pre-scan — `hasCredentialAnchors` said
    // "this text may hold a secret", every pattern then declined to match, and
    // the value went out verbatim. `high_entropy_env` cannot cover these: it
    // requires an UPPERCASE unquoted key (`API_KEY=…`), so `{"apiKey":"…"}`
    // never matched.
    //
    // Tool results are routinely serialised as JSON, and a credential with no
    // recognisable prefix (Azure, self-hosted gateways, Anthropic/Codex OAuth)
    // has no other pattern that can catch it — this is the only thing standing
    // between such a value and the session JSONL, chronicle, HQ broadcast and
    // the model's own context.
    //
    // The key may carry a prefix (`"anthropicApiKey"`), but the credential word
    // must END the key: `"tokenCount"` and `"maxTokens"` do not match, because
    // the closing quote has to follow the word immediately.
    // H-7 (security report VF-08): the prefix class now admits `-` and the
    // alternation uses `api[-_]?key` — hyphenated header-style keys
    // (`x-api-key`, `x-goog-api-key`, `api-key`) previously failed BOTH the
    // prefix class and the literal `apiKey|api_key` spellings, so the literal
    // Anthropic API header name passed through verbatim. Parity with
    // `config-secrets.ts` SECRET_KEY_PATTERN is pinned by
    // tests/security/redaction-api-key-parity.test.ts.
    // Value floor of 8 chars keeps enum-ish values (`"authorization":"none"`)
    // out. Capture groups: 1=key + punctuation, 2=value, 3=closing quote.
    regex:
      /("[A-Za-z0-9_-]*(?:api[-_]?key|token|secret|password|authorization|bearer|private_key|access_token|refresh_token|client_secret)"\s*:\s*")([^"\\]{8,512})(")/gi,
    anchor: JSON_CREDENTIAL_KEY_ANCHORS,
  },

  // ── Ported from packages/plugins credential-patterns.ts (WS-034) ─────────
  // The plugin runtime carried 37 patterns while this scrubber — the one that
  // guards session JSONL, chronicle, HQ broadcast, WebUI events and the auth
  // audit — carried 22. The plugin side already had a parity test; it just did
  // not cover core. Most consequential: WrongStack mints `gho_` tokens itself
  // in the Copilot OAuth flow, and `gh[ousr]_` was absent here.
  {
    type: 'github_oauth_token',
    regex: /(?<![A-Za-z0-9])gh[ousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/g,
    anchor: ['gho_', 'ghu_', 'ghs_', 'ghr_'],
  },
  {
    type: 'gitlab_pat',
    regex: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    anchor: 'glpat-',
  },
  {
    type: 'gitlab_runner_token',
    regex: /(?<![A-Za-z0-9])glrt-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    anchor: 'glrt-',
  },
  {
    type: 'npm_token',
    regex: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
    anchor: 'npm_',
  },
  {
    type: 'slack_app_token',
    regex: /(?<![A-Za-z0-9-])xapp-\d-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    anchor: 'xapp-',
  },
  {
    type: 'slack_webhook',
    regex:
      /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_-]+\/B[A-Za-z0-9_-]+\/[A-Za-z0-9]{16,}/g,
    anchor: 'hooks.slack.com',
  },
  {
    type: 'sendgrid_key',
    regex: /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    anchor: 'SG.',
  },
  {
    type: 'digitalocean_token',
    regex: /(?<![A-Za-z0-9])dop_v1_[a-f0-9]{64}(?![A-Za-z0-9])/g,
    anchor: 'dop_v1_',
  },
  {
    type: 'doppler_token',
    regex: /(?<![A-Za-z0-9])dp\.(?:pt|st|sa|scim|audit)\.[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
    anchor: 'dp.',
  },
  {
    type: 'shopify_token',
    regex: /(?<![A-Za-z0-9])shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}(?![A-Za-z0-9])/g,
    anchor: 'shp',
  },
  {
    type: 'docker_pat',
    regex: /(?<![A-Za-z0-9])dckr_pat_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    anchor: 'dckr_pat_',
  },
  {
    type: 'linear_key',
    regex: /(?<![A-Za-z0-9])lin_api_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
    anchor: 'lin_api_',
  },
  {
    type: 'atlassian_token',
    regex: /(?<![A-Za-z0-9])ATATT3[A-Za-z0-9_\-=]{40,}(?![A-Za-z0-9_\-=])/g,
    anchor: 'ATATT3',
  },
  {
    type: 'square_token',
    regex: /(?<![A-Za-z0-9])(?:sq0(?:atp|csp)-|EAAA)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    anchor: ['sq0atp-', 'sq0csp-', 'EAAA'],
  },
  {
    type: 'google_oauth_client_secret',
    regex: /(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    anchor: 'GOCSPX-',
  },
];

/**
 * `high_entropy_env` is the one pattern that needs special replacement logic
 * (it preserves the key name), so it runs in its own pass. Every other pattern
 * is folded into a single combined regex. Derive the split by type rather than
 * by hard-coded indices so adding/removing a pattern can't silently drop one.
 */
const SIMPLE_PATTERNS = PATTERNS.filter(
  (p) => p.type !== 'high_entropy_env' && p.type !== 'json_credential_key',
);

/**
 * Combined single-pass regex for all simple patterns. Each alternative is a
 * capturing group so the callback can determine which original pattern fired
 * (only one group is non-undefined at match time). Order matches SIMPLE_PATTERNS
 * (longer/more-specific prefixes first). Relies on each simple pattern source
 * containing no internal capturing groups — only `(?:...)` and lookarounds.
 */
const COMBINED_REGEX = new RegExp(SIMPLE_PATTERNS.map((p) => `(${p.regex.source})`).join('|'), 'g');

/** Separate pattern for high_entropy_env (different replacement logic). */
const HIGH_ENTROPY_REGEX = PATTERNS.find((p) => p.type === 'high_entropy_env')!.regex;

/**
 * Separate pattern for json_credential_key — like high_entropy_env, it preserves
 * the key so the redacted output stays valid, readable JSON.
 */
const JSON_CREDENTIAL_REGEX = PATTERNS.find((p) => p.type === 'json_credential_key')!.regex;

/**
 * Replacements for the combined patterns, parallel to SIMPLE_PATTERNS. The
 * combined-regex callback indexes into this with the matched group's position.
 */
const COMBINED_REPLACEMENTS = SIMPLE_PATTERNS.map((p) => `[REDACTED:${p.type}]`);

/**
 * Per-chunk cap. Splits long inputs into 64 KB chunks to keep scrub() memory
 * bounded. Real scrub() inputs (LLM responses, tool outputs) are typically
 * much smaller; this cap handles edge cases without impacting normal usage.
 */
const SCRUB_CHUNK_BYTES = 64 * 1024;

/**
 * Overlap window used to nudge a chunk boundary onto a safe separator so a
 * secret straddling the 64 KB cut isn't split in half (which would leave
 * neither half matching, leaking the secret verbatim).
 *
 * Sized above the longest BOUNDED credential pattern: `high_entropy_env`
 * caps its value at 512 chars (+ key name + quotes ≈ 560) and `bearer_token`
 * at 512; every prefix-keyed pattern is far shorter. Because all of these
 * patterns are whitespace-free, the first whitespace at/after the nominal cut
 * is guaranteed to sit *past the end* of any such secret — so snapping the
 * boundary forward to it keeps every bounded secret wholly inside one chunk.
 * 1 KB gives comfortable headroom over the 560-char worst case.
 */
const SCRUB_OVERLAP_BYTES = 1024;

/**
 * Marker + shape for the one multi-line credential pattern (`private_key`).
 *
 * The whitespace-snap invariant above does NOT hold for this pattern: a PEM
 * block is newline-delimited throughout its body, so the first whitespace at
 * or after the nominal cut inside a PEM is a `\n` *within the key*. Snapping
 * there splits `-----BEGIN …` from `… -----END -----` across two chunks;
 * neither half matches the pattern and both halves leak verbatim (SEC-003).
 * {@link extendChunkBoundaryPastPem} moves such a boundary past the block's
 * closing marker instead.
 */
const PEM_PRIVATE_KEY_BEGIN_RE = /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP)? ?PRIVATE KEY-----/;
const PEM_END_MARKER = '-----END';
/**
 * Hard bound on how far a chunk boundary may extend to keep a PEM block
 * inside one chunk. Real PEMs are ≤ a few KB (a 16 KB certificate at 64
 * chars/line is ~250 lines); anything longer than this is pathological or
 * hostile, and we fall back to the hard cut rather than growing unboundedly.
 */
const MAX_PEM_BLOCK_BYTES = 64 * 1024;

/**
 * Tolerance on the END-marker position check. A block whose length sits just
 * past {@link MAX_PEM_BLOCK_BYTES} (END starting in (cap, cap+64]) would
 * otherwise be rejected knife-edge style even though extending past its
 * closing line is bounded by one line (~31 bytes). Blocks whose END starts
 * beyond this are pathological/hostile — hard cut.
 */
const PEM_END_LINE_TOLERANCE = 64;

/**
 * Move a proposed chunk boundary past a PEM private-key block that the cut
 * would otherwise split. Pure: returns `proposedEnd` unchanged unless the
 * chunk `[chunkStart, proposedEnd)` ends strictly inside an opened
 * `-----BEGIN … PRIVATE KEY-----` block whose closing marker exists within
 * {@link MAX_PEM_BLOCK_BYTES} of the opening one.
 *
 * Marker-line cuts (chimera follow-up to SEC-003): the marker test must run
 * against the FULL text, not the head — a cut landing inside the BEGIN or
 * END marker line itself leaves only a prefix of the marker in the head, and
 * a head-only match test would miss the block and leak both halves. Never
 * shrinks a boundary: when the block already ends inside the head, the
 * whitespace-snapped boundary is kept as-is.
 */
function extendChunkBoundaryPastPem(
  text: string,
  chunkStart: number,
  proposedEnd: number,
): number {
  const head = text.slice(chunkStart, proposedEnd);
  const lastBegin = head.lastIndexOf('-----BEGIN ');
  if (lastBegin === -1) return proposedEnd;
  const fromBegin = text.slice(chunkStart + lastBegin);
  const marker = PEM_PRIVATE_KEY_BEGIN_RE.exec(fromBegin);
  // A stray "-----BEGIN " in prose that never completes into a private-key
  // marker must not grow the chunk.
  if (marker?.index !== 0) return proposedEnd;
  const bodyStart = marker[0].length;
  const cap = Math.min(text.length, chunkStart + lastBegin + MAX_PEM_BLOCK_BYTES);
  const closeIdx = fromBegin.indexOf(PEM_END_MARKER, bodyStart);
  // END must START within cap + one marker line; then the boundary extends
  // past the closing line unclamped (worst-case overshoot ~31 bytes).
  if (closeIdx === -1 || chunkStart + lastBegin + closeIdx >= cap + PEM_END_LINE_TOLERANCE) {
    return proposedEnd;
  }
  // The END marker starts within the cap — extend past its closing line even
  // when that overshoots `cap` by one line (~31 bytes). Clamping to `cap`
  // here could cut mid-`-----END` (block length in (cap-30, cap] window),
  // which fails the pattern's END tail and re-leaks the whole key body
  // (review follow-up to SEC-003). Worst-case overshoot is one marker line.
  const lineEnd = fromBegin.indexOf('\n', closeIdx);
  const end = lineEnd === -1 ? text.length : chunkStart + lastBegin + lineEnd + 1;
  return Math.max(proposedEnd, end);
}

/**
 * Quick pre-scan: check if the text contains any substring that MUST be
 * present for a credential pattern to match. If none are found, the text
 * is guaranteed clean — skip all regex passes (2 total: 16-pattern combined + high_entropy_env).
 *
 * Each anchor is the shortest unique substring from the corresponding pattern.
 * V8's `String.includes()` is hand-tuned C++ — O(n) with near-zero overhead
 * for typical tool-output lengths (100–5000 chars). A single combined regex
 * via `text.search()` is consistently slower for this many alternatives.
 */
/**
 * Anchors derived from {@link PATTERNS}, plus JSON key names.
 *
 * WS-034: this set used to be a hand-written parallel list of
 * `text.includes(...)` calls, and it had already drifted from the pattern
 * table — `twilio_sid` had no anchor at all, so that pattern could never fire.
 * Because the anchors gate ALL regex work, a missing entry silently disables a
 * pattern with no failing test. Deriving the set from the table makes that
 * class of drift impossible: `Pattern.anchor` is required, so a new pattern
 * cannot compile without declaring one.
 */
const PATTERN_ANCHORS: readonly string[] = [
  ...new Set(
    PATTERNS.flatMap((pattern) =>
      typeof pattern.anchor === 'string' ? [pattern.anchor] : [...pattern.anchor],
    ),
  ),
];

/**
 * Every anchor now comes from the pattern table.
 *
 * There used to be a second, hand-maintained `JSON_KEY_ANCHORS` list here for
 * JSON-style credential keys, described as belonging "to no single pattern".
 * That was the bug: an anchor with no backing pattern does not redact anything,
 * it only tells the pre-scan to stop short-circuiting. `{"apiKey":"…"}` cleared
 * the anchor check, matched no pattern, and went out verbatim — the exact drift
 * the `Pattern.anchor` docblock warns about, in the one place the derivation was
 * bypassed. The list is now `json_credential_key`'s declared anchor, so a
 * pattern and its anchors cannot separate again.
 */
const ALL_ANCHORS: readonly string[] = PATTERN_ANCHORS;

/** Escape a literal anchor for embedding in {@link ANCHOR_PRESCAN}. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * All {@link ALL_ANCHORS} as one alternation, built once at module load.
 *
 * Matches exactly when some anchor is a substring — the same predicate the
 * per-anchor `includes()` loop computed, in ONE pass over the text instead of
 * one pass per anchor.
 */
const ANCHOR_PRESCAN = new RegExp(ALL_ANCHORS.map(escapeLiteral).join('|'));

/**
 * Quick pre-scan: does the text contain any substring that MUST be present for
 * some credential pattern to match? If not, the text is guaranteed clean and
 * every regex pass is skipped.
 *
 * One combined regex, not a loop of `String.includes()`.
 *
 * The loop was chosen when the anchor set was small and the inputs were single
 * tool outputs: `includes()` is hand-tuned C++ and beats a regex at that size.
 * But the set is derived from the pattern table and has grown to 48 anchors,
 * and the heaviest caller is not a tool output — it is a session resume, which
 * runs this over every string in a journal. Measured on a real 133 MB journal
 * (309k strings, 124 MB of text, of which FOUR needed redacting): 48 sequential
 * `includes()` passes cost 1492 ms, one combined-alternation `test()` costs
 * 627 ms. That is 865 ms off every large resume, for an identical predicate —
 * a regex alternation of literals matches iff one of the literals occurs.
 *
 * Anchor-set growth used to make this quadratically worse; now it costs one
 * more alternative in a single scan.
 */
function hasCredentialAnchors(text: string): boolean {
  return ANCHOR_PRESCAN.test(text);
}

export class DefaultSecretScrubber implements SecretScrubber {
  scrub(text: string): string {
    if (!text) return text;

    // Fast path: if no credential anchor substrings exist in the text,
    // none of the 17 regex patterns can match. Skip all regex work.
    // This covers the vast majority of tool outputs (~95% of calls on
    // typical sessions are file paths, status messages, diffs, etc.).
    if (!hasCredentialAnchors(text)) return text;

    // For oversize inputs, scrub in fixed chunks to keep memory bounded.
    // The boundary is snapped FORWARD to the next whitespace within an
    // overlap window so a secret straddling the nominal 64 KB cut is never
    // split in half. Every bounded credential pattern is whitespace-free, so
    // the next whitespace at/after the cut necessarily falls past the end of
    // any such secret — guaranteeing it stays wholly inside the current chunk.
    if (text.length <= SCRUB_CHUNK_BYTES) {
      return this.scrubOne(text);
    }
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(i + SCRUB_CHUNK_BYTES, text.length);
      if (end < text.length) {
        // Look for the first whitespace at/after the nominal cut, bounded by
        // the overlap window. Extending forward (not backward) ensures any
        // secret that began before `end` finishes before the new boundary.
        const limit = Math.min(end + SCRUB_OVERLAP_BYTES, text.length);
        let safe = -1;
        for (let j = end; j < limit; j++) {
          const ch = text.charCodeAt(j);
          // space, \t, \n, \r
          if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
            safe = j;
            break;
          }
        }
        // Snap onto the whitespace if found; otherwise fall back to the hard
        // cut (an unbroken >1 KB run with no whitespace can't be a bounded
        // secret anyway — those are all ≤ ~560 chars and whitespace-free).
        end = safe === -1 ? end : safe + 1;
        // The whitespace snap assumes whitespace-free secrets. A PEM private
        // key is multi-line: when the cut lands inside one, the snap above
        // splits it and both halves leak (SEC-003). Move the boundary past
        // the block's closing marker instead — bounded by MAX_PEM_BLOCK_BYTES.
        end = extendChunkBoundaryPastPem(text, i, end);
      }
      out.push(this.scrubOne(text.slice(i, end)));
      i = end;
    }
    return out.join('');
  }

  private scrubOne(text: string): string {
    // Redundant guard: if we reached scrubOne via the chunked path, the
    // chunk may have been small enough to anchor-skip independently.
    if (!hasCredentialAnchors(text)) return text;

    // Pass 1: combined single-pass regex for all simple patterns. Each
    // alternative is a capturing group; only the group that matched is
    // non-undefined. The trailing offset/string args replace() appends are
    // always defined, so the matched group (which precedes them) is found first.
    let out = text.replace(COMBINED_REGEX, function (match) {
      for (let i = 1; i <= SIMPLE_PATTERNS.length; i++) {
        // biome-ignore lint/complexity/noArguments: Performance-critical hot path to avoid 20+ element array allocation per secret token
        if (arguments[i] !== undefined) {
          const replacement = COMBINED_REPLACEMENTS[i - 1];
          return replacement !== undefined ? replacement : match;
        }
      }
      return match;
    });

    // Pass 2: high_entropy_env needs special handling — preserve the key name.
    // Groups: 1=leading delimiter (re-emitted so adjacent-secret separators
    // aren't collapsed), 2=key name, 3=value (redacted).
    out = out.replace(HIGH_ENTROPY_REGEX, (_match, lead, key, _value) => {
      return `${lead}${key}=[REDACTED:high_entropy_env]`;
    });

    // Pass 3: json_credential_key — preserve the key and both quotes so the
    // redacted text is still parseable JSON. Groups: 1=key with its punctuation
    // and opening quote, 2=value (redacted), 3=closing quote.
    out = out.replace(JSON_CREDENTIAL_REGEX, (_match, keyPrefix, _value, closingQuote) => {
      return `${keyPrefix}[REDACTED:json_credential_key]${closingQuote}`;
    });

    return out;
  }

  /**
   * Recursively scrub every string value in an object/array graph. Secrets can
   * appear under any key — a URL query param, an `authorization` header, an
   * arbitrarily-named nested field — so we don't gate recursion on key names.
   * The per-string `scrub()` fast-path (anchor pre-scan) keeps this cheap: any
   * value without a credential anchor returns immediately without regex work.
   */
  scrubObject<T>(obj: T): T {
    const seen = new WeakSet();
    const visit = (v: unknown): unknown => {
      if (typeof v === 'string') return this.scrub(v);
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v as object)) return v;
      seen.add(v as object);
      if (Array.isArray(v)) return v.map(visit);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = visit(val);
      }
      return out;
    };
    return visit(obj) as T;
  }

  /**
   * Copy-on-write {@link scrubObject}: clean subtrees come back by reference.
   *
   * `scrubObject` rebuilds the entire graph unconditionally — a new object for
   * every node, a new array for every array — whether or not anything was
   * redacted. On the read path that is almost all waste: measured over a real
   * 133 MB journal, 488k nodes and 309k strings were rebuilt so that FOUR
   * strings could be redacted, costing ~480 ms of allocation and the GC
   * pressure that comes with it. Rebuilding only the spine above an actual
   * redaction gives the same output for a fraction of the garbage.
   *
   * The sharing is why this is a separate method rather than a change to
   * `scrubObject`: see the contract note on `SecretScrubber.scrubObjectShared`.
   */
  scrubObjectShared<T>(obj: T): T {
    const seen = new WeakSet();
    const visit = (v: unknown): unknown => {
      if (typeof v === 'string') return this.scrub(v);
      if (v === null || typeof v !== 'object') return v;
      // Matches `scrubObject`: a node reached twice is returned as-is rather
      // than re-entered, which terminates on cycles.
      if (seen.has(v as object)) return v;
      seen.add(v as object);
      if (Array.isArray(v)) {
        let out: unknown[] | undefined;
        for (let i = 0; i < v.length; i++) {
          const before = v[i];
          const after = visit(before);
          if (after === before) continue;
          // First change in this array: copy it, then patch. Later elements
          // already sit in the copy at their original (unchanged) values.
          out ??= [...v];
          out[i] = after;
        }
        return out ?? v;
      }
      const source = v as Record<string, unknown>;
      let out: Record<string, unknown> | undefined;
      for (const k of Object.keys(source)) {
        const before = source[k];
        const after = visit(before);
        if (after === before) continue;
        out ??= { ...source };
        out[k] = after;
      }
      return out ?? v;
    };
    return visit(obj) as T;
  }
}
