import type { SecretScrubber } from '../types/secret-scrubber.js';

interface Pattern {
  type: string;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  // Anchored at the start where possible so partial matches inside larger
  // strings don't trigger false positives.
  {
    type: 'anthropic_key',
    regex: /(?<![A-Za-z0-9])sk-ant-api\d+-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
  },
  { type: 'openai_key', regex: /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g },
  { type: 'github_pat', regex: /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/g },
  { type: 'github_pat_v2', regex: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9])/g },
  { type: 'aws_access_key', regex: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  { type: 'gcp_key', regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9])/g },
  { type: 'slack_token', regex: /(?<![A-Za-z0-9-])xox[abpos]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g },
  {
    type: 'stripe_key',
    regex: /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/g,
  },
  {
    type: 'twilio_sid', regex: /(?<![A-Za-z0-9])AC[a-f0-9]{32}(?![A-Za-z0-9])/g,
  },
  {
    type: 'telegram_bot_token',
    // Telegram tokens are of the form  bot<digits>:<alphanum>  in URL paths
    regex: /\/bot\d+:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  },
  {
    type: 'jwt',
    // Anchored: look for literal "eyJ" which is unambiguous for JWT header
    regex:
      /(?<![A-Za-z0-9/+=])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9/+=])/g,
  },
  {
    type: 'private_key',
    // Anchored: start must be BEGIN, end must be END with no extra dashes after END
    regex:
      /(?:^|\n)-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP)? ?PRIVATE KEY-----[\s\S]*?-----END[^-]*-----(?:\n|$)/g,
  },
  { type: 'mongodb_uri', regex: /mongodb(?:\+srv)?:\/\/[^\s"'`]+/g },
  { type: 'postgres_uri', regex: /postgres(?:ql)?:\/\/[^\s"'`]+/g },
  { type: 'mysql_uri', regex: /mysql:\/\/[^\s"'`]+/g },
  { type: 'redis_uri', regex: /redis:\/\/[^\s"'`]+/g },
  // AI/ML provider keys — modern LLM services with well-known prefixes
  {
    type: 'huggingface_token',
    // HuggingFace tokens: hf_ followed by 34 alphanumeric chars
    regex: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{34}(?![A-Za-z0-9])/g,
  },
  {
    type: 'replicate_token',
    // Replicate tokens: r8_ followed by 40+ alphanumeric chars
    regex: /(?<![A-Za-z0-9])r8_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
  },
  {
    type: 'perplexity_key',
    // Perplexity API keys: pplx- followed by 40+ alphanumeric chars
    regex: /(?<![A-Za-z0-9])pplx-[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
  },
  {
    type: 'groq_key',
    // Groq API keys: gsk_ followed by 40+ alphanumeric chars
    regex: /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
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
    regex: /(^|\s)([A-Z_]{4,}(?:KEY|TOKEN|SECRET|PASSWORD|PWD))\s*[:=]\s*['"]?([A-Za-z0-9_/+=-]{20,512})['"]?(?=\s|$)/g,
  },
];

/**
 * `high_entropy_env` is the one pattern that needs special replacement logic
 * (it preserves the key name), so it runs in its own pass. Every other pattern
 * is folded into a single combined regex. Derive the split by type rather than
 * by hard-coded indices so adding/removing a pattern can't silently drop one.
 */
const SIMPLE_PATTERNS = PATTERNS.filter((p) => p.type !== 'high_entropy_env');

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
 * Quick pre-scan: check if the text contains any substring that MUST be
 * present for a credential pattern to match. If none are found, the text
 * is guaranteed clean — skip all regex passes (2 total: 16-pattern combined + high_entropy_env).
 *
 * Each anchor is the shortest unique substring from the corresponding pattern.
 * V8's `String.includes()` is hand-tuned C++ — O(n) with near-zero overhead
 * for typical tool-output lengths (100–5000 chars). A single combined regex
 * via `text.search()` is consistently slower for this many alternatives.
 */
function hasCredentialAnchors(text: string): boolean {
  return (
    text.includes('-----BEGIN') ||    // Private keys (most unique → cheap reject)
    text.includes('sk-') ||           // Anthropic + OpenAI keys
    text.includes('sk_') ||           // Stripe live/test keys
    text.includes('ghp_') ||          // GitHub PAT v1
    text.includes('github_pat_') ||   // GitHub PAT v2
    text.includes('eyJ') ||           // JWT
    text.includes('AKIA') ||          // AWS access key
    text.includes('AIza') ||          // GCP service key
    text.includes('xox') ||           // Slack token (xoxa/xoxb/xoxp/xoxo/xoxs)
    text.includes('Bearer ') ||       // Bearer token (space suffix reduces false positives)
    text.includes('/bot') ||          // Telegram bot token (URL path pattern)
    text.includes('hf_') ||           // HuggingFace token
    text.includes('r8_') ||           // Replicate token
    text.includes('pplx-') ||         // Perplexity API key
    text.includes('gsk_') ||          // Groq API key
    text.includes('_KEY=') ||         // High-entropy env vars: API_KEY=, SECRET_KEY=, ...
    text.includes('_TOKEN=') ||       // ACCESS_TOKEN=, AUTH_TOKEN=, ...
    text.includes('_SECRET=') ||      // API_SECRET=, CLIENT_SECRET=, ...
    text.includes('_PASSWORD=') ||    // DB_PASSWORD=, ROOT_PASSWORD=, ...
    text.includes('mongodb://') ||
    text.includes('mongodb+srv://') ||
    text.includes('postgres://') ||
    text.includes('postgresql://') ||
    text.includes('mysql://') ||
    text.includes('redis://') ||
    // JSON-style credential keys: tool outputs often serialise objects as
    // raw JSON strings rather than parsed objects. The value may not start
    // with a recognisable prefix (sk-, ghp_, etc.), so we anchor on common
    // key names. The `"` prefix avoids matching prose that happens to mention
    // these words — JSON serialisation always quotes string keys.
    // NOTE: `high_entropy_env` (below) only captures alphanumeric + `_/+=-`
    // value chars. This deliberately excludes `!@#$%^&*()` etc to keep the
    // false-positive rate low — generated secrets containing those characters
    // may not be redacted by this pattern. The other 16 patterns still catch
    // them if they have recognisable prefixes (e.g. `sk-`, `Bearer `, etc.).
    text.includes('"apiKey"') ||
    text.includes('"api_key"') ||
    text.includes('"token"') ||
    text.includes('"secret"') ||
    text.includes('"password"') ||
    text.includes('"authorization"') ||
    text.includes('"bearer"') ||
    text.includes('"private_key"') ||
    text.includes('"access_token"') ||
    text.includes('"refresh_token"') ||
    text.includes('"client_secret"')
  );
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
      }
      out.push(this.scrubOne(text.slice(i, end)));
      i = end;
    }
    return out.join('');
  }

  private scrubOne(text: string): string {
    // The caller (scrub) already ran hasCredentialAnchors on the full
    // text. For the chunked path, the chunk may have been small enough
    // to anchor-skip independently — the re-check here is cheap.
    if (!hasCredentialAnchors(text)) return text;

    // Pass 1: combined single-pass regex for all simple patterns. Each
    // alternative is a capturing group; only the group that matched is
    // non-undefined. The trailing offset/string args replace() appends are
    // always defined, so the matched group (which precedes them) is found first.
    let out = text.replace(
      COMBINED_REGEX,
      (match, ...groups) => {
        // groups[i] corresponds to SIMPLE_PATTERNS[i]; find which one fired.
        const idx = groups.findIndex((g) => g !== undefined);
        if (idx < 0) return match;
        const replacement = COMBINED_REPLACEMENTS[idx];
        return replacement !== undefined ? replacement : match;
      },
    );

    // Pass 2: high_entropy_env needs special handling — preserve the key name.
    // Groups: 1=leading delimiter (re-emitted so adjacent-secret separators
    // aren't collapsed), 2=key name, 3=value (redacted).
    out = out.replace(HIGH_ENTROPY_REGEX, (_match, lead, key, _value) => {
      return `${lead}${key}=[REDACTED:high_entropy_env]`;
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
}
