import { expectDefined } from '../utils/expect-defined.js';

// Sensitive CLI flag patterns that may appear in process command lines.
// Redacted to [REDACTED] so crash dumps / ps output / telemetry events cannot
// leak secrets. This is the canonical copy consumed by the telemetry producers
// (emitProcessStarted); packages/tools carries a synced copy (_redact-command.ts).
//
// SECURITY TRADEOFF: this is a redaction function. We deliberately err toward
// OVER-redaction: a false positive (redacting a non-secret) is cosmetic noise
// in telemetry; a false negative (leaking a real secret) is a security incident.
const SENSITIVE_FLAG_PATTERNS: RegExp[] = [
  // --flag=value  or  --flag "value"  (value captured up to next space or comma)
  /--(?:token|password|passwd|pwd|secret|api[-_]?key|api[-_]?secret|auth|credential|private[-_]?key|access[-_]?key|github[-_]?token|gh[-_]?token|bearer|jwt|oauth|pin|pincode|passphrase|access[-_]?token)(?:[=\s,][^\s]*)?/gi,
  // -t short flag (token): attached (-tVALUE), separated (-t VALUE), or -t=VALUE.
  // The separator group is optional so the attached form (the common one) matches.
  // (?<![-\w]) anchors to a token start so we don't match the `-t` inside `--token`.
  // The value must be token-like (>= 8 chars) so ordinary combined flags such
  // as `tar -tf` / `ssh -tt` are not eaten. Global flag: EVERY occurrence is
  // redacted, not just the first. Synced with packages/tools _redact-command.ts.
  /(?<![-\w])-t(?:[=\s]+)?[^\s,-]{8,}/g,
  // -p|-password|-a (redis auth) short flags: attached + separated + =value.
  // Same token-start anchor; over-redaction is an accepted tradeoff for a
  // redaction function (false positive = cosmetic noise; false negative = leak).
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
  if (typeof cmd !== 'string') return '';
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
        // There is no secret here — leave it untouched so downstream pair-scan
        // (flag + next-arg value) can still recognize the bare flag.
        return match;
      }
      // Short flag attached form (-pVALUE, -tVALUE, -aVALUE): the flag name is
      // the leading -X (2 chars); redact everything after it. We must NOT use a
      // greedy [a-zA-Z0-9_-]* flag-name match here, because the value characters
      // would be consumed into the "flag name" and the secret would survive.
      return `${match.slice(0, 2)}[REDACTED]`;
    });
  }
  return result;
}

// Long flag names that carry a secret when supplied as a bare flag followed by
// a separate value arg (e.g. ["--token", "s3cr3t"]). Used by redactCommandArgs.
const BARE_SENSITIVE_LONG_FLAG =
  /^--(?:token|password|passwd|pwd|secret|api[-_]?key|api[-_]?secret|auth|credential|private[-_]?key|access[-_]?key|github[-_]?token|gh[-_]?token|bearer|jwt|oauth|pin|pincode|passphrase|access[-_]?token)$/i;
// Short flags that carry a secret when bare (e.g. ["-p", "s3cr3t"]).
const BARE_SENSITIVE_SHORT_FLAG = /^-(?:p|t|a)$/i;

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
  const redactedArgs = args.map((a) => redactCommand(a));
  for (let i = 0; i < redactedArgs.length - 1; i++) {
    const flag = redactedArgs[i];
    const next = redactedArgs[i + 1];
    if (flag === undefined || next === undefined) continue;
    const isBareSensitive =
      (BARE_SENSITIVE_LONG_FLAG.test(flag) || BARE_SENSITIVE_SHORT_FLAG.test(flag)) &&
      !flag.includes('[REDACTED]');
    // Only redact the following arg if it looks like a value, not another flag.
    if (isBareSensitive && !next.startsWith('-')) {
      redactedArgs[i + 1] = '[REDACTED]';
    }
  }
  return { command: redactedCommand, args: redactedArgs };
}
