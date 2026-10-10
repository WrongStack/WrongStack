/**
 * Credential pattern catalog for DefaultSecretScrubber. Split out of
 * secret-scrubber.ts.
 */

export interface Pattern {
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
  'AUTHORIZATION"',
  'bearer"',
  'Bearer"',
  'BEARER"',
];

export const PATTERNS: Pattern[] = [
  // Anchored at the start where possible so partial matches inside larger
  // strings don't trigger false positives.
  {
    type: 'anthropic_key',
    regex: /(?<![A-Za-z0-9])sk-ant-api\d+-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    anchor: 'sk-ant-',
  },
  {
    type: 'openai_key',
    regex: /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    anchor: 'sk-',
  },
  {
    // `xai` is a first-class provider in this codebase, but its key shape was
    // absent here — so the one credential format WrongStack itself hands users
    // was the one the scrubber could not recognize (audit 2026-08-20).
    type: 'xai_key',
    regex: /(?<![A-Za-z0-9])xai-[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    anchor: 'xai-',
  },
  {
    type: 'github_pat',
    regex: /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/g,
    anchor: 'ghp_',
  },
  {
    type: 'github_pat_v2',
    regex: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9])/g,
    anchor: 'github_pat_',
  },
  {
    type: 'aws_access_key',
    regex: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
    anchor: 'AKIA',
  },
  {
    type: 'gcp_key',
    regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9])/g,
    anchor: 'AIza',
  },
  {
    type: 'slack_token',
    regex: /(?<![A-Za-z0-9-])xox[abpos]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    anchor: 'xox',
  },
  {
    type: 'stripe_key',
    regex: /(?<![A-Za-z0-9])sk_(?:live|test)_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/g,
    anchor: 'sk_',
  },
  {
    type: 'twilio_sid',
    regex: /(?<![A-Za-z0-9])AC[a-f0-9]{32}(?![A-Za-z0-9])/g,
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
    // Any `-----BEGIN [TYPE ]PRIVATE KEY[ BLOCK]-----` … `-----END …-----`.
    // Deliberately NOT line-anchored: a PEM inside a JSON string (a GCP
    // service-account.json read by a tool) follows `"` and carries literal
    // `\n` escapes, and a CRLF file ends its END line in `\r`. The type words
    // cover ENCRYPTED (PKCS#8) and PGP, whose armor adds ` BLOCK`. All of
    // those shapes used to pass through verbatim.
    regex:
      /(?<!-)-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[^-\r\n]*-----/g,
    anchor: '-----BEGIN',
  },
  { type: 'mongodb_uri', regex: /mongodb(?:\+srv)?:\/\/[^\s"'`]+/g, anchor: 'mongodb' },
  { type: 'postgres_uri', regex: /postgres(?:ql)?:\/\/[^\s"'`]+/g, anchor: 'postgres' },
  { type: 'mysql_uri', regex: /mysql:\/\/[^\s"'`]+/g, anchor: 'mysql://' },
  { type: 'redis_uri', regex: /redis:\/\/[^\s"'`]+/g, anchor: 'redis://' },
  {
    type: 'url_credentials',
    // The password of any other `scheme://user:password@host` — a git remote
    // carrying a token, a proxy URL. Runs in its own pass AFTER the combined
    // one, so the URIs above still take their whole match first. Forward
    // match from the `://` literal: lookbehind forms of this and the two
    // patterns below took scrub time on 60 MB of real journals from 324 to
    // 571 ms (this form: 353 ms). Placeholders (`${TOKEN}`, `<pass>`,
    // `{{secret}}`, an already-masked `***`, the literal word `password`) are
    // not credentials and are left intact. Groups: 1=user, 2=password.
    regex:
      /(?<=[A-Za-z0-9+.-]):\/\/([^\s/:@"'`]{0,256}):(?!(?:[Pp]ass(?:word|wd)?|PASSWORD|[Pp]wd|[Ss]ecret|[Tt]oken)@)([^\s/@"'`$<{*][^\s/@"'`]{0,255})(?=@)/g,
    anchor: '://',
  },
  {
    type: 'aws_secret_key',
    // `~/.aws/credentials` spells the key in lowercase; `high_entropy_env`
    // only accepts UPPERCASE key names, so `aws_secret_access_key = …` leaked.
    // Forward match from the literal key (a lookbehind alternative is
    // re-tried at every position of the combined regex).
    regex: /aws_secret_access_key[ \t]*[=:][ \t]*['"]?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    anchor: 'aws_secret_access_key',
  },
  {
    type: 'azure_storage_key',
    // Azure Storage / Service Bus connection strings.
    regex: /(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{40,512}={0,2}/g,
    anchor: ['AccountKey=', 'SharedAccessKey='],
  },
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
    regex:
      /(?:^|[^A-Za-z0-9_.~+/-])[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9._~+/-]{12,512}=*(?=$|[^A-Za-z0-9_.~+/-])/g,
    // `Bearer` is not a substring of `bearer` or `BEARER`. The pre-scan ORs
    // a case-insensitive word check; see hasCredentialAnchors.
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
    regex:
      // `.` is in the value class: dotted tokens (Discord `a.b.c`) leaked whole.
      // Digits are in the key class (not as its first character): `R2_SECRET_ACCESS_KEY`,
      // `B2_APPLICATION_KEY`, `S3_SECRET_KEY` (object-store credentials) leaked.
      // The prefix is optional and any length: `DB_PASSWORD`, `GH_TOKEN`, `X_KEY` and a
      // bare `PASSWORD=` are as much credentials as `APP_PASSWORD`; a 4-character
      // minimum before the credential word masked some of them and not others.
      /(^|\s)((?:[A-Z_][A-Z0-9_]*)?(?:KEY|TOKEN|SECRET|PASSWORD|PWD|PASSPHRASE))\s*[:=]\s*['"]?([A-Za-z0-9_/+=.-]{20,512})['"]?(?=\s|$)/g,
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
