import * as fs from 'node:fs';

/**
 * Transient-tolerant entrypoint probe. ENOENT means the layout genuinely
 * does not exist; ANY other stat failure (EMFILE/EPERM/EBUSY spikes under
 * full-suite parallel load) is "unknown", and `fs.existsSync` folds that
 * into false — one transient miss then threw "Built Chronicle project
 * server is unavailable" straight out of the connect loop and failed the
 * caller (mailbox/SAGE sibling flake, observed 2026-09-15). Assume-present
 * is the recoverable direction: a dead spawn is guarded and cadence-
 * retryable, while a false negative was fatal to the connect window.
 */
export function probeFileExists(filePath: string): boolean {
  try {
    // Primary probe: the seam existing callers and tests mock, and the fast
    // path for the common available case.
    if (fs.existsSync(filePath)) return true;
  } catch {
    // existsSync itself failed — fall through to the stat verification.
  }
  // existsSync folds transient stat errors (EMFILE/EPERM/EBUSY spikes under
  // full-suite parallel load) into false. Verify with statSync before
  // declaring the build missing: ENOENT = genuinely absent; any other error
  // (or a contradictory success) = assume present — the recoverable
  // direction, since a dead spawn is guarded and cadence-retryable while a
  // false negative was fatal to the connect window (mailbox/SAGE sibling
  // flakes, observed 2026-09-15).
  try {
    fs.statSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}
