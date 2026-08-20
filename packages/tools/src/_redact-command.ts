import { expectDefined } from '@wrongstack/core/utils';

// Sensitive CLI flag patterns that may appear in process command lines.
// Redacted to [REDACTED] so crash dumps /ps output cannot leak secrets.
// Split out of process-registry.ts so entries that only need the registry
// (e.g. ps-slash) don't carry this module's dependencies.
//
// NOTE: @wrongstack/core carries its own copy (observability/redact-command.ts)
// so the emitProcessStarted telemetry producer can redact command+args
// centrally. Keep these two copies in sync when updating the patterns.
const SENSITIVE_FLAG_PATTERNS: RegExp[] = [
  // --flag=value  or  --flag "value"  (value captured up to next space or comma)
  /--(?:token|password|passwd|pwd|secret|api[-_]?key|api[-_]?secret|auth|credential|private[-_]?key|access[-_]?key|github[-_]?token|gh[-_]?token|bearer|jwt|oauth|pin|pincode|passphrase|access[-_]?token)(?:[=\s,][^\s]*)?/gi,
  // -t short flag (token): attached (-tVALUE), separated (-t VALUE), or -t=VALUE.
  // (?<![-\w]) anchors to a token start so we don't match the `-t` inside `--token`.
  // The value must be token-like (>= 8 chars) so ordinary combined flags such
  // as `tar -tf` / `ssh -tt` are not eaten. Global flag: EVERY occurrence is
  // redacted, not just the first.
  // NOTE: synced with @wrongstack/core observability/redact-command.ts.
  /(?<![-\w])-t(?:[=\s]+)?[^\s,-]{8,}/g,
  // -p|-password|-a (redis auth) short flags: attached + separated + =value.
  // Same token-start anchor; over-redaction is an accepted tradeoff for a
  // redaction function. Synced with core copy.
  /(?<![-\w])-(?:password|p|a)(?:[=\s]+)?[^\s,-]+/gi,
  // env var–style secrets: TOKEN=x, API_KEY=y, etc.
  /(?:TOKEN|API_KEY|API_SECRET|AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|BEARER|JWT|OAUTH|CREDENTIAL|SECRET|PRIVATE_KEY|PASSWORD|PASSWD|PASSPHRASE)\s*[=:]\s*[^\s,]+/gi,
  // Generic high-entropy look: base64 strings >32 chars or hex strings >32 digits — but only
  // when preceded by a flag name (e.g. --github-token=EyJ...). Global flag so
  // every such flag in the command line is redacted, not just the first.
  /--\w*(?:token|key|secret|password|passwd|auth|credential)\w*[=\s,][A-Za-z0-9+/=]{32,}/g,
];

/**
 * Returns a display-safe copy of `cmd` with sensitive flag values replaced by [REDACTED].
 * The original string is unchanged; this is pure and has no side effects.
 */
export function redactCommand(cmd: string): string {
  let result = cmd;
  for (const pattern of SENSITIVE_FLAG_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Preserve the flag name portion; redact only the value part.
      // e.g. "--token=sekrit_abc"  →  "--token=[REDACTED]"
      const eq = match.indexOf('=');
      const sp = match.search(/\s/);
      const delim = eq !== -1 ? '=' : sp !== -1 ? match[sp] : null;
      if (delim !== null) {
        const flag = match.slice(0, match.indexOf(expectDefined(delim)) + 1);
        return `${flag}[REDACTED]`;
      }
      // No delimitable separator found in the match.
      if (match.startsWith('--')) {
        // Long flag with no value attached (e.g. a bare "--token" argv token).
        // No secret here — leave it untouched so downstream pair-scan can still
        // recognize the bare flag. NOTE: keep this synced with
        // @wrongstack/core observability/redact-command.ts.
        return match;
      }
      // Short flag attached form (-pVALUE, -tVALUE, -aVALUE): flag name is the
      // leading -X (2 chars); redact everything after. Don't use a greedy
      // [a-zA-Z0-9_-]* flag-name match — value chars would be consumed into the
      // flag name and the secret would survive. Synced with core copy.
      return `${match.slice(0, 2)}[REDACTED]`;
    });
  }
  return result;
}
