/**
 * Lessons a model distilled from stored memory text must not reach the agent
 * unattended when they read like instructions to it. Memory text is untrusted
 * (it can carry injected tool output), and consolidation can turn an aged-out
 * record into a fresh lesson, so a proposal matching any of these patterns is
 * never auto-accepted: it waits in the Review tab for a person.
 *
 * Deliberately narrow: commands, paths and "always run X before Y" are the
 * substance of conventions and command notes. These target override phrasing,
 * download-and-execute, outbound URLs, credential exfiltration, and attempts to
 * close the memory fence.
 */
const HOLD_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'instruction-override',
    /\b(?:ignore|disregard|override|forget)\b[^.\n]{0,40}\b(?:instructions?|rules?|system prompt|previous|prior|guidelines?|policy)\b/i,
  ],
  [
    'download-and-execute',
    /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b[^\n]{0,120}(?:\|\s*(?:sh|bash|zsh|iex|invoke-expression|python|node)\b|-o\s)|\b(?:iex|invoke-expression)\s*\(/i,
  ],
  // The loopback exemption holds only when no `@` ends a userinfo part before
  // the path: in `http://localhost:1@collector.example/x` the host is what
  // follows the `@` (RFC 3986 §3.2), so that URL is outbound.
  [
    'outbound-url',
    /\bhttps?:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?![^\s)'"`/?#]*@)(?:[:/]|$))[^\s)'"`]+/i,
  ],
  [
    'credential-exfiltration',
    /\b(?:send|post|upload|exfiltrate|forward|paste)\b[^.\n]{0,60}\b(?:api[ _-]?keys?|tokens?|passwords?|secrets?|credentials?|\.env)\b/i,
  ],
  ['fence-escape', /<\/?\s*memory\b|\[\/?\s*memory_evidence\b|<\/?\s*system\b/i],
];

/** Names of the patterns a lesson matches; empty when it may be auto-accepted. */
export function consolidationHoldReasons(text: string): string[] {
  return HOLD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/** A lesson that tries to close the memory fence is not a lesson at all. */
export function escapesMemoryFence(text: string): boolean {
  return consolidationHoldReasons(text).includes('fence-escape');
}
