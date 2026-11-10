/**
 * @wrongstack/plugins — canonical credential-pattern table.
 *
 * Two plugins detect credentials, at different points in the pipeline:
 *
 *  - `secret-scanner` gates tool *input* and inspects tool *output*.
 *  - `prompt-firewall` inspects the outgoing *provider request* (and the
 *    response) so a credential sitting in context is not shipped to a
 *    third party.
 *
 * They previously each carried their own pattern list. The lists drifted:
 * one grew GitLab, npm, SendGrid and DigitalOcean coverage while the other
 * did not, so which credentials were caught depended on which side of the
 * pipeline they crossed. A credential is a credential — the two surfaces
 * should never disagree about what one looks like.
 *
 * This module is the single source of truth. Adding a pattern here
 * strengthens both surfaces at once.
 *
 * Style notes for new entries:
 *  - Prefer explicit lookaround boundaries — `(?<![A-Za-z0-9])` /
 *    `(?![A-Za-z0-9])` — over ``. `` is defined against word
 *    characters, so it silently fails next to the `+`, `/` and `=` that
 *    base64-shaped secrets routinely end with.
 *  - Keep every group non-capturing (`(?:…)`). The combined regex maps a
 *    capture-group index back to the pattern that fired; an inner group
 *    shifts that mapping. `secret-scanner` compensates for user-supplied
 *    patterns, but built-ins should not need it.
 *  - Avoid unbounded `.*` lookarounds: these run on every provider
 *    request, against the full context.
 */

/** One credential shape, with a stable machine-readable id. */
export interface CredentialPattern {
  /** Stable id, e.g. `github_pat`. Reported to users and in metrics. */
  type: string;
  /** Global-flagged matcher. */
  regex: RegExp;
}

export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // LLM provider keys
  {
    type: 'anthropic_key',
    regex: /(?<![A-Za-z0-9])sk-ant-api\d+-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
  },
  {
    type: 'openai_key',
    regex: /(?<![A-Za-z0-9])sk-(?!ant)(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
  },
  // GitHub. `ghp_` is only the personal-access-token prefix — the OAuth
  // (`gho_`), user-to-server (`ghu_`), server-to-server (`ghs_`) and
  // refresh (`ghr_`) tokens grant the same or broader access and were
  // previously not detected at all.
  { type: 'github_pat', regex: /(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/g },
  {
    type: 'github_oauth_token',
    regex: /(?<![A-Za-z0-9])gh[ousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/g,
  },
  { type: 'github_pat_v2', regex: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9])/g },
  // GitLab
  { type: 'gitlab_pat', regex: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
  {
    type: 'gitlab_runner_token',
    regex: /(?<![A-Za-z0-9])glrt-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  },
  // npm — a leaked publish token is a supply-chain compromise.
  { type: 'npm_token', regex: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  // AWS
  { type: 'aws_access_key', regex: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  // GCP
  { type: 'gcp_key', regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9])/g },
  // Slack. `xoxe` (token-rotation) and `xapp` (app-level) were missing;
  // both are as sensitive as the bot/user tokens already covered.
  {
    type: 'slack_token',
    regex: /(?<![A-Za-z0-9-])xox[abposer]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
  },
  { type: 'slack_app_token', regex: /(?<![A-Za-z0-9-])xapp-\d-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g },
  {
    type: 'slack_webhook',
    regex:
      /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_-]+\/B[A-Za-z0-9_-]+\/[A-Za-z0-9]{16,}/g,
  },
  // Discord: the token is the last path segment of the webhook URL.
  {
    type: 'discord_webhook',
    regex:
      /https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]{40,}/g,
  },
  // Stripe
  {
    type: 'stripe_key',
    // Secret (`sk_`) and restricted (`rk_`) keys carry the same authority.
    regex: /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/g,
  },
  // Twilio
  { type: 'twilio_sid', regex: /(?<![A-Za-z0-9])AC[a-f0-9]{32}(?![A-Za-z0-9])/g },
  // Telegram: a bot ID, a colon, then exactly 35 secret characters. Any digit
  // run and 20+ characters also matched `grep -n` output such as
  // `118:SOME_LONG_IDENTIFIER` (#443).
  {
    type: 'telegram_bot_token',
    regex:
      /(?:(?<![A-Za-z0-9_])|(?<=(?:^|[^A-Za-z0-9_])bot))\d{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  },
  // JWT
  {
    type: 'jwt',
    regex:
      /(?<![A-Za-z0-9/+=])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9/+=])/g,
  },
  // Private keys
  {
    type: 'private_key',
    // Same shape as core's secret-scrubber: not line-anchored (a PEM inside a
    // JSON string — a service-account.json — follows `"` and carries literal
    // `\n` escapes), and any type words, so PKCS#8 ENCRYPTED keys match too.
    regex:
      /(?<!-)-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[^-\r\n]*-----/g,
  },
  // AI/ML provider tokens
  { type: 'huggingface_token', regex: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{34}(?![A-Za-z0-9])/g },
  // PyPI: `pypi-` + a macaroon whose base64url v2 header always reads `AgE…`
  {
    type: 'pypi_token',
    regex: /(?<![A-Za-z0-9_-])pypi-AgE[A-Za-z0-9_-]{50,}(?![A-Za-z0-9_-])/g,
  },
  { type: 'replicate_token', regex: /(?<![A-Za-z0-9])r8_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g },
  { type: 'perplexity_key', regex: /(?<![A-Za-z0-9])pplx-[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g },
  { type: 'groq_key', regex: /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g },
  // SaaS / infrastructure tokens — each grants API access on the user's
  // account, and each was previously invisible to this gate.
  {
    type: 'sendgrid_key',
    regex: /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  },
  { type: 'digitalocean_token', regex: /(?<![A-Za-z0-9])dop_v1_[a-f0-9]{64}(?![A-Za-z0-9])/g },
  {
    type: 'doppler_token',
    regex: /(?<![A-Za-z0-9])dp\.(?:pt|st|sa|scim|audit)\.[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g,
  },
  {
    type: 'shopify_token',
    regex: /(?<![A-Za-z0-9])shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}(?![A-Za-z0-9])/g,
  },
  { type: 'docker_pat', regex: /(?<![A-Za-z0-9])dckr_pat_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
  { type: 'linear_key', regex: /(?<![A-Za-z0-9])lin_api_[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g },
  {
    type: 'atlassian_token',
    regex: /(?<![A-Za-z0-9])ATATT3[A-Za-z0-9_\-=]{40,}(?![A-Za-z0-9_\-=])/g,
  },
  {
    type: 'square_token',
    regex: /(?<![A-Za-z0-9])(?:sq0(?:atp|csp)-|EAAA)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  },
  {
    type: 'azure_storage_key',
    regex: /AccountKey=[A-Za-z0-9+/]{80,}={0,2}/g,
  },
  {
    type: 'google_oauth_client_secret',
    regex: /(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
  },
  // Bearer tokens
  {
    type: 'bearer_token',
    regex: /(?<![A-Za-z0-9_.~+/-])Bearer\s+[A-Za-z0-9._~+/-]{12,512}=*(?![A-Za-z0-9._~+/-])/g,
  },
  // Database URIs. Require password-bearing user-info; credential-free values stay scannable.
  { type: 'mongodb_uri', regex: /mongodb(?:\+srv)?:\/\/[^\s:/@"'`]*:[^\s/@"'`]+@[^\s"'`]+/g },
  {
    type: 'postgres_uri',
    // Query parsers decode percent-encoded parameter names. Recognize each
    // encoded character in `password` so mixed forms such as `pass%77ord`
    // cannot bypass detection while keeping the scan strictly bounded.
    regex:
      /postgres(?:ql)?:\/\/(?:[^\s:/@"'`]*:[^\s/@"'`]+@[^\s"'`]+|[^&\s?"'`#]{1,2048}\?(?:(?!(?:p|%70)(?:a|%61)(?:s|%73)(?:s|%73)(?:w|%77)(?:o|%6[fF])(?:r|%72)(?:d|%64)=)[^&\s#"'`]{1,256}&){0,32}(?:p|%70)(?:a|%61)(?:s|%73)(?:s|%73)(?:w|%77)(?:o|%6[fF])(?:r|%72)(?:d|%64)=[^&\s#"'`]{1,4096})/g,
  },
  { type: 'mysql_uri', regex: /mysql:\/\/[^\s:/@"'`]*:[^\s/@"'`]+@[^\s"'`]+/g },
  { type: 'redis_uri', regex: /redis:\/\/[^\s:/@"'`]*:[^\s/@"'`]+@[^\s"'`]+/g },
  {
    // The ENV counterpart to `json_credential_key` below, and the half of that
    // pair that never made it across.
    //
    // `@wrongstack/core` -> `security/secret-scrubber.ts` carries both
    // `high_entropy_env` and `json_credential_key`, and its docblock calls the
    // JSON one "the JSON counterpart to high_entropy_env". Only the JSON half
    // was ported here, so the two lists disagreed about the single most common
    // way a secret is written down: a `.env` file, a `docker-compose`
    // environment block, a `printenv` dump, a shell `export`. Probe-verified
    // (2026-09-22): core scrubbed 4 of 5 such samples, this table caught 0 --
    // and this table is what `secret-scanner` (default-ACTIVE) uses to scan
    // tool OUTPUT, so `cat .env` handed the values straight to the model.
    //
    // Deliberately conservative, matching core: the key must be SCREAMING_CASE
    // ending in a credential word, and the value at least 20 chars, so
    // `DEBUG=true` and `NODE_ENV=production` stay untouched.
    //
    // Written with a lookbehind rather than core's capture groups because this
    // table forbids capturing groups -- `secret-scanner` maps a combined-regex
    // group index back to the pattern that fired, and an inner group shifts
    // that mapping (enforced by credential-pattern-parity.test.ts).
    type: 'high_entropy_env',
    regex:
      /(?<=(?:^|\s)[A-Z_][A-Z0-9_]{3,}(?:KEY|TOKEN|SECRET|PASSWORD|PWD|PASSPHRASE)\s{0,8}[:=]\s{0,8}['"]?)[A-Za-z0-9_/+=-]{20,512}(?=['"]?(?:\s|$))/gm,
  },
  {
    // Credentials serialised as JSON, keyed rather than prefixed. Every other
    // entry in this table recognises a credential by its SHAPE (`ghp_`, `sk-`,
    // `eyJ`), which means a key with no distinctive prefix — Azure, a
    // self-hosted gateway, an Anthropic/Codex OAuth token — was invisible to
    // both surfaces. `prompt-firewall` guards the outgoing provider request, so
    // this is what stops a JSON-shaped tool result carrying such a value to a
    // third party.
    //
    // The key is matched in a LOOKBEHIND, so the reported match is the secret
    // itself and the pattern keeps zero capturing groups — `secret-scanner`
    // maps a combined-regex group index back to the pattern that fired, and an
    // inner group would shift that mapping (see the style note above, enforced
    // by credential-pattern-parity.test.ts).
    //
    // Mirrors `json_credential_key` in
    // `@wrongstack/core` → `src/security/secret-scrubber.ts`. Keep the two key
    // lists in step; the core side additionally preserves the key name when it
    // rewrites, which is why it is written with capture groups instead.
    type: 'json_credential_key',
    regex:
      /(?<="[A-Za-z0-9_]{0,64}(?:apiKey|api_key|token|secret|password|authorization|bearer|private_key|access_token|refresh_token|client_secret)"\s{0,8}:\s{0,8}")(?:[^"\\]|\\[\s\S]){8,512}(?=")/gi,
  },
];

/** Fresh, independently-stateful copies (RegExp `lastIndex` is mutable). */
export function cloneCredentialPatterns(): CredentialPattern[] {
  return CREDENTIAL_PATTERNS.map((p) => ({
    type: p.type,
    regex: new RegExp(p.regex.source, p.regex.flags),
  }));
}
