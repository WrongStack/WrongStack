import type { Sage } from '../types.js';

/**
 * Campaign/round progress logs: "Bug-hunt round r17-20261023 (17/25 session):
 * NO-PROVEN-BUG, zero edits …", "Writer durability LANDED 2026-08-21 (suites
 * 120/120; tsc clean) …". They read as decisions or outcomes, so the narrow
 * ephemeral-chatter gate in memory-input-validation.ts lets them through.
 *
 * On the live store they dominated injection: the six most-injected active
 * memories were all LANDED logs (8k–14k injections, zero uses). Some do carry
 * campaign continuity ("do not re-audit X") and are referenced while the
 * campaign runs, so they are not rejected: they stop being *automatically*
 * injected once idle (see {@link isIdleProgressLog}) and stay searchable.
 *
 * A single signal is ordinary prose ("landed in commit …"); two independent
 * ones are the log shape.
 */
const PROGRESS_LOG_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'round',
    /\brounds?\s+r?\d+\s*(?:\/|of)\s*\d+\b|\br\d{1,3}-20\d{6}\b|\(\d{1,3}\/\d{1,3} session\)|\brounds?\s+r?\d+(?:-\d+)?\b(?=[^.]{0,40}\b(?:session|campaign|20\d\d))/i,
  ],
  [
    'status',
    /\bLANDED\b|\bNO-PROVEN-BUG\b|\bzero (?:production )?edits\b|\bfixed-and-verified\b|\bfixed-verification-incomplete\b|\boutcome\s*:?\s*`?(?:no-proven-bug|fixed)/i,
  ],
  [
    'suites',
    /\b\d{1,5}\/\d{1,5}\b(?=[^.\n]{0,30}\b(?:pass|green|tests?|suites?)\b)|\b(?:suites?|tests?)\s+\d{1,5}\/\d{1,5}\b/i,
  ],
  ['head', /\bHEAD\s+[0-9a-f]{7,40}\b/i],
  ['remaining', /\bremaining\b[^.]{0,80}\b(?:rounds?|for future|surfaces?)\b|\bnext round\b/i],
];

export function progressLogSignals(text: string): string[] {
  const hits: string[] = [];
  for (const [name, pattern] of PROGRESS_LOG_SIGNALS) if (pattern.test(text)) hits.push(name);
  return hits;
}

export function isProgressLogText(text: string): boolean {
  return progressLogSignals(text).length >= 2;
}

/** A progress log neither written nor referenced within this window is retired from auto-injection. */
export const PROGRESS_LOG_IDLE_MS = 30 * 86_400_000;

/**
 * True when a progress log has gone idle: created, and last referenced, more
 * than {@link PROGRESS_LOG_IDLE_MS} ago. A recorded use renews the window, so a
 * ledger the running campaign keeps citing stays eligible. `permanent` is an
 * explicit human decision and is never retired.
 */
export function isIdleProgressLog(
  memory: Pick<Sage, 'text' | 'persistence' | 'createdAt' | 'lastUsedAt'>,
  nowMs: number,
): boolean {
  if (memory.persistence === 'permanent') return false;
  const created = Date.parse(memory.createdAt);
  const used = Date.parse(memory.lastUsedAt ?? '');
  const lastTouch =
    Number.isFinite(used) && Number.isFinite(created)
      ? Math.max(used, created)
      : Number.isFinite(used)
        ? used
        : created;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(lastTouch) ||
    nowMs - lastTouch < PROGRESS_LOG_IDLE_MS
  )
    return false;
  return isProgressLogText(memory.text);
}
