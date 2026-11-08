/**
 * Canonical secret redaction for command lines and outbound message text.
 *
 * This logic used to exist as three hand-mirrored copies:
 *   - `packages/tools/src/_redact-command.ts`             → `redactCommand`
 *   - `packages/core/src/observability/redact-command.ts` → `redactCommand`, `redactCommandArgs`
 *   - `packages/telegram/src/redact.ts`                   → `redactSecrets`
 *
 * Each carried a "keep these two copies in sync" comment. That manual contract
 * failed twice, both times in the leak direction:
 *   1. the tools copy gained a `:` branch that picked the flag/value separator
 *      by PRECEDENCE (= → : → whitespace) instead of by position, so a colon
 *      INSIDE a space-separated value was mistaken for the separator and the
 *      value's prefix was printed verbatim — `redis-cli -a hunter2:pw` rendered
 *      as `-a hunter2:[REDACTED]`;
 *   2. both the `:` handling and the pattern list drifted between copies, and
 *      the pattern lists could not be diffed because they lived in three files.
 *
 * The algorithm now lives here exactly once. Two things still differ per call
 * site — deliberately, and both are *policy*, not drift:
 *
 *   `COMMAND_REDACTION_PROFILE` (`tools`, `core` telemetry)
 *     Matches GLUED short flags (`-tVALUE`, `-aVALUE`) because a `/ps` line or
 *     crash dump should not show a redis/curl secret at all, and leaves a bare
 *     long flag (`--token`) untouched so `redactCommandArgs`' pair-scan can
 *     still recognise it as a flag whose value is the NEXT argv entry.
 *
 *   `OUTBOUND_REDACTION_PROFILE` (`telegram`)
 *     Wipes an unseparable match entirely (`**redacted**`) instead of keeping
 *     the flag name, because a greedy flag-name extraction must never leave
 *     value characters behind on the outward-facing surface. It shares the
 *     command profile's SHORT-FLAG patterns, including the glued form: only the
 *     separated form used to match, so `curl -tSECRET` / `redis-cli -aSECRET`
 *     reached a notification verbatim — under-redaction on the surface where a
 *     leak is worst. The `-target`/`-tries`/`-timeout` false positives this
 *     re-admits are cosmetic next to that.
 *
 * Both profiles share one separator rule: the separator is the FIRST character
 * after the flag name, and it may be `=`, whitespace, `:` or `,` — every one of
 * them declared in the pattern lists' separator class (`(?:[=\s,:][^\s]*)?`,
 * `[=\s,:][A-Za-z0-9+/=]{32,}`, `\s*[=:]`). Deriving it from the flag-name
 * boundary rather than from delimiter precedence is what keeps a colon inside a
 * value from being read as the separator.
 *
 * `:` belongs in the PATTERN class, not only in the boundary rule: with
 * `--password:hunter2` excluded from the named-flag match, the match collapsed
 * to the bare flag name, whose boundary is `''` — so neither profile took the
 * separator branch. The command profile printed the value verbatim, and the
 * outbound profile wiped the flag name into `**redacted**` and left
 * `:hunter2` behind, which is the worst shape: text that reads as redacted
 * while the credential is still on the wire.
 *
 * This module must stay dependency-free: `@wrongstack/primitives` is a
 * dependency leaf and is imported by the lowest tiers of the workspace graph.
 */

export type RedactionProfileId = 'command' | 'outbound';

export interface RedactionProfile {
  /** Stable id, used in diagnostics and by tests that pin the profiles. */
  readonly id: RedactionProfileId;
  /** Sensitive-flag patterns, applied in order. */
  readonly patterns: readonly RegExp[];
  /**
   * Renders a match in which no flag/value separator could be located.
   * Returning the match unchanged is a valid choice (see the command profile).
   */
  readonly renderUnseparated: (match: string) => string;
}

/**
 * `--flag`, `-password`/`-p`/`-a`/`-t`/`-u`/`-b`, or an env-var / header name. The
 * bare name admits `-` so a header (`X-Api-Key: …`) is read whole: stopping at
 * the hyphen put `-` where the separator test looks and rendered `Ap[REDACTED]`.
 */
const FLAG_NAME = /^--[\w-]+|^-(?:password|p|a|t|u|b)|^[A-Za-z_][\w-]*/i;
/**
 * Characters that may introduce a sensitive flag's value. `,` and `:` are
 * included because the pattern lists accept them as separators; leaving either
 * out made the pattern match a value the redactor then emitted verbatim.
 * Not global: `lastIndex` state must never leak between calls.
 */
const SEPARATOR = /^[=:,\s]$/;

/**
 * Short-flag patterns for the COMMAND profile (`tools` `/ps` output, crash
 * dumps, `core` telemetry).
 *
 * They match the GLUED form as well as the separated one. The value class is
 * narrow on purpose: `[^\s,-]` stops at a hyphen and `-t` additionally demands
 * a token-like value (>= 8 chars), because this text is READ by a human
 * debugging `/ps` output and `clang -target=x86_64`, `tar -tf`, `-tries` and
 * `-timeout` are everyday noise there. A false positive is cosmetic; a false
 * negative in a crash dump is still a leak, so this is a readability tradeoff,
 * not a licence to under-redact — the OUTBOUND profile below deliberately does
 * NOT copy the narrow class.
 *
 * Sharing the instances is safe: `applyProfile` is synchronous and
 * `String.prototype.replace` resets `lastIndex` on a global regex, so no
 * `lastIndex` state can leak between the profiles that use them.
 */
const SHORT_FLAG_TOKEN_PATTERN = /(?<![-\w])-t(?:[=\s]+)?[^\s,-]{8,}/g;
// A quoted password is taken whole (`-p "hunter two"`), like the long flags'
// QUOTED_VALUE below; the bare class alone printed the tail after the space.
const SHORT_FLAG_SECRET_PATTERN =
  /(?<![-\w])-(?:password|p|a)(?:[=\s]+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s,-]+)/gi;
/**
 * Short-flag patterns for the OUTBOUND profile (`telegram` notifications).
 *
 * Same glued + separated shape as the command profile — that part IS shared
 * deliberately, because matching only the separated form let
 * `curl -tSECRET` / `redis-cli -aSECRET` reach a phone notification verbatim.
 * The VALUE CLASS is not shared, and that is the point of these two: the
 * command profile's `[^\s,-]` + `{8,}` is a readability tradeoff that
 * TRUNCATES the value at the first hyphen, which on this surface prints the
 * tail of a credential into a notification (`redis-cli -a s3cr3t-hunter2`
 * rendered as `-a [REDACTED]-hunter2`, and a dashed token like
 * `-t sk-live-…` was skipped altogether because `sk` is under the `-t`
 * length floor). Secrets are routinely hyphenated, so outbound keeps the
 * whole non-space token. The widened `-target`-style false positive is the
 * accepted cost here; see the outbound tests.
 */
const OUTBOUND_SHORT_FLAG_TOKEN_PATTERN = /(?<![-\w])-t(?:[=\s]+)?[^\s,]+/g;
const OUTBOUND_SHORT_FLAG_SECRET_PATTERN =
  /(?<![-\w])-(?:password|p|a)(?:[=\s]+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s,]+)/gi;
/** Shared: high-entropy value behind a secret-looking flag name. */
const HIGH_ENTROPY_FLAG_PATTERN =
  /--[\w-]*(?:token|key|secret|password|passwd|auth|credential)[\w-]*[=\s,:]\s*[A-Za-z0-9+/=]{32,}/g;
/**
 * Shared: an HTTP Authorization header value (`curl -H "Authorization: Bearer
 * …"`, `Basic …`, `token …`) — the most common way a credential sits on a
 * command line, and no flag name marks it. The match starts at the header
 * name, so the separator rule renders `Authorization:[REDACTED]`.
 */
// HTTP credentials may be token68 or a comma-separated auth-param list (Digest,
// AWS SigV4). Quoted parameter values can themselves contain commas and escapes.
const HTTP_AUTH_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const HTTP_AUTH_PARAM_VALUE = String.raw`(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|[^\s"',]+)`;
const HTTP_AUTH_PARAM = `${HTTP_AUTH_TOKEN}[ \\t]*=[ \\t]*${HTTP_AUTH_PARAM_VALUE}`;
const AUTHORIZATION_HEADER_PATTERN = new RegExp(
  String.raw`\bAuthorization\s*:\s*(?:${HTTP_AUTH_TOKEN}\s+)?(?:${HTTP_AUTH_PARAM}(?:[ \t]*,[ \t]*${HTTP_AUTH_PARAM})*|[^\s"',]+)`,
  'gi',
);
/**
 * Shared: a session cookie is the other everyday credential on a curl line —
 * the `Cookie:` header (every `name=value; …` pair) and curl's `--cookie`
 * value. `--cookie-jar <file>` names a file, not a secret, and stays.
 */
const COOKIE_HEADER_PATTERN =
  /\bCookie\s*:\s*[^\s=;"']+\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s"';]*)(?:;\s*[^\s=;"']+\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s"';]*))*/gi;
const COOKIE_FLAG_PATTERN = /--cookie(?![\w-])[=\s]+(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/gi;
// Curl's short alias is sensitive only with inline cookie data, not a filename
// or an ordinary `git checkout -b branch` argument.
const SHORT_COOKIE_FLAG_PATTERN =
  /(?<![-\w])-b\s*(?:"[^"\n]*=[^"\n]*"|'[^'\n]*=[^'\n]*'|[^\s"'=]+=[^\s]+)/g;
/**
 * Shared: the password in URL userinfo (`https://user:TOKEN@host`,
 * `postgres://app:PW@db`). Look-arounds keep `scheme://` and `@host` out of the
 * match, so it renders as `user:[REDACTED]` and the URL stays readable.
 */
// Password-only userinfo (for example Redis default-user auth) has no username.
const URL_USERINFO_PASSWORD_PATTERN = /(?<=:\/\/)[^\s/:@]*:[^\s/@]+(?=@)/g;
/**
 * Shared: a token used ALONE as URL userinfo (`git clone https://ghp_…@github.com/…`,
 * GitLab `glpat-…`) — no `:` so the pattern above never sees it. Known token
 * prefixes, or a 32+ character token-like run; a user name (`alice@`) stays.
 * The match starts at `//`, which no flag name can read, so both profiles wipe
 * the token (`https://[REDACTED]@host` / `https:**redacted**@host`).
 */
const URL_USERINFO_TOKEN_PATTERN =
  /\/\/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|[\w-]{32,})(?=@)/g;
/**
 * Shared: curl-style basic-auth credentials — `-u user:pass`, glued
 * `-uuser:pass`, `--user user:pass`, `--proxy-user user:pass`. Only a value
 * holding a `:` matches, so a bare user name (`sudo -u root`, `ps -u alice`)
 * stays readable.
 */
const USER_CREDENTIAL_PATTERN =
  /(?<![-\w])(?:-u|--(?:[\w-]+-)?user)(?:[=\s]+)?(?:"[^"\n]*:[^"\n]*"|'[^'\n]*:[^'\n]*'|[^\s,"']*:[^\s,]+)/g;

/**
 * Shared: a JSON field holding a secret (`curl -d '{"password":"…"}'`,
 * `{"client_secret": "…"}`). The key-value rules need `[=:]` right after the
 * name, and here the key's closing quote sits in between, so a request body
 * reached every surface verbatim. The match starts at the `:` (the key is in
 * the look-behind), so the separator rule renders `"password":[REDACTED]`.
 * A shell-escaped body (`\"password\":\"…\"`) is covered too.
 * The bare-value class excludes `[` so a second pass leaves `[REDACTED]` alone.
 */
// Each quoted branch must end on its own delimiter, not on a quote inside the value.
const JSON_SECRET_FIELD_PATTERN =
  /(?<=["'][\w-]*(?:password|passwd|pwd|secret|token|api[-_]?key|auth|credential|private[-_]?key|access[-_]?key|bearer|jwt|passphrase)\\?["']\s*):\s*(?:\\?"(?:[^"\\\n]|\\[^"\n])*\\?"|\\?'(?:[^'\\\n]|\\[^'\n])*\\?'|[^\s,{}[\]"'\\]+)/gi;

/**
 * Secret keywords are matched as the FINAL hyphen-separated segment of a
 * compound long flag: `--(?:[\w-]+-)?KEYWORD`. Real tools spell secret flags
 * `--db-password`, `--auth-token`, `--signing-key`, and a list that only
 * accepts the keyword as the ENTIRE name left those leaking verbatim through
 * every surface — while the value-less env-var pattern (which needs `[=:]`)
 * could not backstop the space- or comma-separated forms. The optional
 * hyphenated prefix closes that, and the existing callback rule (the
 * separator must sit immediately after the flag NAME) keeps keyword-in-the-
 * middle names such as `--token-file` and `--auth-scheme` visible: their
 * match truncates before the separator and renders unchanged.
 */
const KEYWORDS =
  'token|password|passwd|pwd|secret|api[-_]?key|api[-_]?secret|auth|credential|private[-_]?key|access[-_]?key|github[-_]?token|gh[-_]?token|bearer|jwt|oauth|pin|pincode|passphrase|access[-_]?token';

/**
 * A quoted value, tried before the bare one. Without it a quoted secret that
 * contains a space (`--password="hunter two"`) was cut at the space and its
 * tail printed verbatim (`--password=[REDACTED] two"`). The env-style literals
 * below spell the same alternation inline.
 */
const QUOTED_VALUE = `"[^"\\n]*"|'[^'\\n]*'`;

/** Shared by `tools` (`/ps` output, crash dumps) and `core` telemetry. */
const COMMAND_PATTERNS: readonly RegExp[] = [
  // --flag=value, --flag "value", --flag,value (value captured up to the next
  // space, or the whole quoted value).
  // `\s*` after the separator: `--password   hunter2` must not match only the
  // first space and leave the value to be printed.
  new RegExp(`--(?:[\\w-]+-)?(?:${KEYWORDS})(?:[=\\s,:]\\s*(?:${QUOTED_VALUE}|[^\\s]*))?`, 'gi'),
  SHORT_FLAG_TOKEN_PATTERN,
  SHORT_FLAG_SECRET_PATTERN,
  // env var–style secrets: TOKEN=x, API_KEY=y, TOKEN:z, PASSWORD="x y", …
  // `ACCESS_KEY`/`SECRET_KEY` are the cloud spellings (`AWS_SECRET_ACCESS_KEY=… aws s3 ls`,
  // `S3_SECRET_KEY`); without them the most common inline credential printed verbatim.
  /(?:TOKEN|API[-_]?KEY|API[-_]?SECRET|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|BEARER|JWT|OAUTH|CREDENTIAL|SECRET|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY|PASSWORD|PASSWD|PASSPHRASE)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,]+)/gi,
  HIGH_ENTROPY_FLAG_PATTERN,
  AUTHORIZATION_HEADER_PATTERN,
  COOKIE_HEADER_PATTERN,
  COOKIE_FLAG_PATTERN,
  SHORT_COOKIE_FLAG_PATTERN,
  URL_USERINFO_PASSWORD_PATTERN,
  URL_USERINFO_TOKEN_PATTERN,
  USER_CREDENTIAL_PATTERN,
  JSON_SECRET_FIELD_PATTERN,
];

/** Telegram outbound notifications: the highest-risk exfiltration surface. */
const OUTBOUND_PATTERNS: readonly RegExp[] = [
  // Same named long flags plus DATABASE_URL / CONNECTION_STRING spellings.
  new RegExp(
    `--(?:[\\w-]+-)?(?:${KEYWORDS}|database[-_]?url|connection[-_]?string)(?:[=\\s,:]\\s*(?:${QUOTED_VALUE}|[^\\s]*))?`,
    'gi',
  ),
  // Glued short forms match here too, closing the `curl -tSECRET` /
  // `redis-cli -aSECRET` under-redaction. The outbound value class is wider
  // than the command profile's so a hyphenated secret is not truncated at its
  // first hyphen — see OUTBOUND_SHORT_FLAG_* above for the accepted
  // `-target`-style false-positive cost.
  OUTBOUND_SHORT_FLAG_TOKEN_PATTERN,
  OUTBOUND_SHORT_FLAG_SECRET_PATTERN,
  // env-var style, including DATABASE_URL / CONNECTION_STRING. PASSPHRASE is
  // part of the set because a short (<20-char) value is not caught by the
  // core scrubber's high_entropy_env pattern, so this is its only guard. That
  // is also why the separator admits surrounding whitespace, as the command
  // profile's does: `PASSWORD: hunter2` and `PASSWORD = hunter2` used to reach
  // the phone verbatim while `/ps` redacted them.
  /(?:TOKEN|API[-_]?KEY|API[-_]?SECRET|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|BEARER|JWT|OAUTH|CREDENTIAL|SECRET|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY|PASSWORD|PASSWD|PASSPHRASE|DATABASE_URL|CONNECTION_STRING)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,]+)/gi,
  HIGH_ENTROPY_FLAG_PATTERN,
  AUTHORIZATION_HEADER_PATTERN,
  COOKIE_HEADER_PATTERN,
  COOKIE_FLAG_PATTERN,
  SHORT_COOKIE_FLAG_PATTERN,
  URL_USERINFO_PASSWORD_PATTERN,
  URL_USERINFO_TOKEN_PATTERN,
  USER_CREDENTIAL_PATTERN,
  JSON_SECRET_FIELD_PATTERN,
];

export const COMMAND_REDACTION_PROFILE: RedactionProfile = {
  id: 'command',
  patterns: COMMAND_PATTERNS,
  renderUnseparated: (match) =>
    // Bare long flag (e.g. an argv token `--token`): there is no secret here, so
    // leave it intact for the downstream pair-scan. NOTE: do not "improve" this
    // to wipe the token — `redactCommandArgs` relies on seeing the bare flag.
    match.startsWith('--')
      ? match
      : // Glued short flag (-pVALUE, -tVALUE, -aVALUE, -passwordVALUE): the flag
        // name is matched by FLAG_NAME and everything after it is the value.
        `${FLAG_NAME.exec(match)?.[0] ?? match.slice(0, 2)}[REDACTED]`,
};

export const OUTBOUND_REDACTION_PROFILE: RedactionProfile = {
  id: 'outbound',
  patterns: OUTBOUND_PATTERNS,
  // We cannot tell where the flag name ends and the value begins, and this text
  // is forwarded to a phone notification, so wipe the whole match rather than
  // risk leaving value characters behind. One marker keeps it idempotent.
  renderUnseparated: () => '**redacted**',
};

/** Apply one profile to `text`. Pure; never throws on non-string input. */
function applyProfile(text: string, profile: RedactionProfile): string {
  if (typeof text !== 'string') return '';
  let result = text;
  for (const pattern of profile.patterns) {
    result = result.replace(pattern, (match) => {
      // The separator is the FIRST character after the FLAG NAME — never a
      // delimiter chosen by precedence, which would misread a `:` inside a value
      // as the separator and print the value's prefix verbatim.
      const flagName = FLAG_NAME.exec(match)?.[0] ?? '';
      const boundary = match.charAt(flagName.length);
      if (boundary !== '' && SEPARATOR.test(boundary)) {
        return `${flagName}${boundary}[REDACTED]`;
      }
      return profile.renderUnseparated(match);
    });
  }
  return result;
}

/**
 * Returns a display-safe copy of `cmd` with sensitive flag values replaced by
 * `[REDACTED]`. The original string is unchanged; this is pure.
 */
export function redactCommand(cmd: string): string {
  return applyProfile(cmd, COMMAND_REDACTION_PROFILE);
}

/**
 * Replace sensitive flag values and env-style secrets in outbound text with
 * `[REDACTED]`. Pure, and idempotent — no pattern matches `[REDACTED]`.
 */
export function redactSecrets(text: string): string {
  return applyProfile(text, OUTBOUND_REDACTION_PROFILE);
}

// Long flag names that carry a secret when supplied as a bare flag followed by
// a separate value arg (e.g. ["--token", "s3cr3t"]). Used by redactCommandArgs.
// Same keyword-as-final-segment rule as the named long-flag patterns above, so
// ["--db-password", "s3cr3t"] redacts like ["--password", "s3cr3t"] while
// ["--token-file", "/path"] stays visible.
const BARE_SENSITIVE_LONG_FLAG = new RegExp(`^--(?:[\\w-]+-)?(?:${KEYWORDS})$`, 'i');
const ATTACHED_ENV_SECRET_KEY =
  /^(?:[\w-]*[_-])?(?:TOKEN|API[-_]?KEY|API[-_]?SECRET|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|BEARER|JWT|OAUTH|CREDENTIAL|SECRET|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY|PASSWORD|PASSWD|PASSPHRASE)$/i;
const BARE_COOKIE_FLAG = /^--cookie$/i;
// Short flags that carry a secret when bare (e.g. ["-p", "s3cr3t"]).
const BARE_SENSITIVE_SHORT_FLAG = /^-(?:password|p|t|a)$/i;
// curl-style user flags: the next arg is a secret only as `user:pass`.
const BARE_USER_CREDENTIAL_FLAG = /^(?:-u|--(?:[\w-]+-)?user)$/;

/**
 * Redact a command + argument vector WITHOUT corrupting the array shape.
 *
 * Each token is redacted independently (catches attached/equal forms like
 * `--token=secret`, `-pSECRET`, `TOKEN=secret` within a single arg). Then a
 * pair-scan handles the split-flag-value case where a bare sensitive flag
 * (`--token` / `-p`) and its value arrive as two separate args — which
 * per-token redaction would otherwise miss. This avoids the join→split
 * round-trip that corrupted args containing spaces.
 */
export function redactCommandArgs(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (!Array.isArray(args)) {
    return { command: redactCommand(command), args: [] };
  }
  const redactedCommand = redactCommand(command);
  const redactedArgs = args.map((a) => {
    // Preserve bare flags for the pair scan: text redaction can mistake
    // -password for a glued -p value and erase the flag's identity.
    if (typeof a === 'string' && BARE_SENSITIVE_SHORT_FLAG.test(a)) return a;
    // argv already bounds the value, including any unquoted whitespace.
    const attachedPassword =
      typeof a === 'string' ? /^(-(?:password|p|a))(=)?(.+)$/is.exec(a) : null;
    if (attachedPassword) {
      return `${attachedPassword[1]}${attachedPassword[2] ?? ''}[REDACTED]`;
    }
    const attachedShortToken = typeof a === 'string' ? /^(-t=)(.+)$/s.exec(a) : null;
    if (attachedShortToken) {
      return `${attachedShortToken[1]}[REDACTED]`;
    }
    const attachedUserCred =
      typeof a === 'string'
        ? (/^(-u|--(?:[\w-]+-)?user)(=)(.+:.+)$/s.exec(a) ?? /^(-u)([^=\s].*:.+)$/s.exec(a))
        : null;
    if (attachedUserCred) {
      return `${attachedUserCred[1]}${attachedUserCred[2]?.includes(':') ? '' : (attachedUserCred[2] ?? '')}[REDACTED]`;
    }
    const attachedCookie = typeof a === 'string' ? /^(--cookie=)(.+)$/is.exec(a) : null;
    if (attachedCookie) {
      return `${attachedCookie[1]}[REDACTED]`;
    }
    if (typeof a === 'string' && a.startsWith('-b') && a.slice(2).includes('=')) {
      return '-b[REDACTED]';
    }
    const equals = typeof a === 'string' ? a.indexOf('=') : -1;
    // An argv value can contain unquoted whitespace; it is already one token.
    if (equals > 0 && BARE_SENSITIVE_LONG_FLAG.test(a.slice(0, equals))) {
      return `${a.slice(0, equals + 1)}[REDACTED]`;
    }
    if (equals > 0 && ATTACHED_ENV_SECRET_KEY.test(a.slice(0, equals).trim())) {
      return `${a.slice(0, equals + 1)}[REDACTED]`;
    }
    const comma = typeof a === 'string' ? a.indexOf(',') : -1;
    if (comma > 0 && BARE_SENSITIVE_LONG_FLAG.test(a.slice(0, comma))) {
      return `${a.slice(0, comma + 1)}[REDACTED]`;
    }
    return redactCommand(a);
  });
  for (let i = 0; i < redactedArgs.length - 1; i++) {
    const flag = redactedArgs[i];
    const next = redactedArgs[i + 1];
    if (flag === undefined || next === undefined) continue;
    const isBareSensitive =
      (BARE_SENSITIVE_LONG_FLAG.test(flag) ||
        BARE_COOKIE_FLAG.test(flag) ||
        BARE_SENSITIVE_SHORT_FLAG.test(flag)) &&
      !flag.includes('[REDACTED]');
    // Only redact the following arg if it looks like a value, not another flag.
    if (isBareSensitive && !next.startsWith('-')) {
      redactedArgs[i + 1] = '[REDACTED]';
    } else if (flag === '-b' && next.includes('=')) {
      redactedArgs[i + 1] = '[REDACTED]';
    } else if (BARE_USER_CREDENTIAL_FLAG.test(flag) && next.includes(':')) {
      redactedArgs[i + 1] = '[REDACTED]';
    }
  }
  return { command: redactedCommand, args: redactedArgs };
}
