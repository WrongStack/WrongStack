// ---------------------------------------------------------------------------
// Secret redaction for outbound Telegram messages.
//
// Mirrors `redactCommand` from `@wrongstack/tools` (process-registry.ts:66)
// without taking a dependency on the tools package. The regex set is the
// same one used by `bash`/`exec`/`_spawn-stream` to redact session JSONL,
// crash dumps, and `/ps` output. The Telegram notification path is the
// highest-risk exfiltration surface — tool output printed by a long bash
// run is forwarded verbatim to a phone notification — so we run every
// outgoing payload through this filter.
//
// This file is intentionally tiny and dependency-free so it can be unit
// tested in isolation and lifted into `@wrongstack/core/utils` later if
// more plugins need it.
// ---------------------------------------------------------------------------

// Patterns match the flag/value or env-var/secret pair. The replacement
// callback preserves the flag name and replaces only the value, so the
// output still reads naturally ("--token=[REDACTED]") and downstream
// debugging is not destroyed.
const SENSITIVE_FLAG_PATTERNS: RegExp[] = [
  // --flag=value or --flag "value" (value captured up to next space/comma)
  /--(?:token|password|passwd|pwd|secret|api[-_]?key|api[-_]?secret|auth|credential|private[-_]?key|access[-_]?key|github[-_]?token|gh[-_]?token|bearer|jwt|oauth|pin|pincode|passphrase|access[-_]?token|database[-_]?url|connection[-_]?string)(?:[=\s,][^\s]*)?/gi,
  // Short flags: -t value, -p value. Only the SEPARATED form (`-t value`,
  // `-t=value`) is matched — the glued form (`-tvalue`) is intentionally
  // NOT matched because it produces too many false positives in practice
  // (`-target`, `-tries`, `-timeout` all start with `-t`). A user typing
  // `curl -tSECRET` is extremely rare; a user typing `clang -target=...`
  // is daily. The lookbehind `(?<![-\w])` rejects `-t` inside `--token`
  // where the preceding char is another `-`.
  /(?<![-\w])-t(?:[\s=][^\s,]+)/g,
  /(?<![-\w])-(?:p|password)(?:[\s=][^\s,]+)/gi,
  // env-var style: TOKEN=x, API_KEY=y, DATABASE_URL=z, …
  /(?:TOKEN|API_KEY|API_SECRET|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|BEARER|JWT|OAUTH|CREDENTIAL|SECRET|PRIVATE_KEY|PASSWORD|PASSWD|DATABASE_URL|CONNECTION_STRING)\s*[=:][^\s,]+/gi,
  // Generic high-entropy look — only when preceded by a flag name.
  /--\w*(?:token|key|secret|password|passwd|auth|credential)\w*[=\s,][A-Za-z0-9+/=]{32,}/g,
];

/**
 * Replace sensitive flag values and env-style secrets with `[REDACTED]`.
 * Pure: never mutates the input. Safe to call on already-redacted text
 * (idempotent — `[REDACTED]` does not match any pattern).
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_FLAG_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const eq = match.indexOf('=');
      const sp = match.search(/\s/);
      let delim: string | null = null;
      let delimIdx = -1;
      if (eq !== -1) {
        delim = '=';
        delimIdx = eq;
      } else if (sp !== -1) {
        delim = match[sp]!;
        delimIdx = sp;
      }
      if (delim !== null && delimIdx >= 0) {
        const flag = match.slice(0, delimIdx + 1);
        return `${flag}[REDACTED]`;
      }
      // No clear delimiter (e.g. `-tVALUE` glued to flag name) — wipe the
      // whole match. We can't tell where the flag name ends and the
      // value begins, so we redact the entire token. Using a single
      // fixed marker (not `flag+marker`) avoids leaking the original
      // value when our char-class-based flag extraction is too greedy
      // (the regex would otherwise match the value characters too).
      return '**redacted**';
    });
  }
  return result;
}
