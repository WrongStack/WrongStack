/**
 * Print the "Update available: vX → vY" notice on stderr.
 *
 * If `initialUpdateInfo` is missing (boot's background check missed the
 * cache), this function fires a fresh quick check with a 2s timeout and
 * returns whichever `UpdateInfo` it ended up with. The caller can chain
 * off the return value to short-circuit later in the boot pipeline.
 *
 * Best-effort: any failure to fetch the update info is swallowed (the
 * notice is decorative, not load-bearing). Returns the resolved
 * `UpdateInfo` so callers that want to log it elsewhere don't have to
 * re-run the check.
 *
 * The standalone executable also reports the background update
 * (standalone-auto-update.ts): the swap a previous session made, once, and a
 * downloaded build that is waiting for a session to exit.
 */
import { realpathSync } from 'node:fs';
import type { Config } from '@wrongstack/contracts/types';
import { isStandaloneBinary, writeErr } from '@wrongstack/core/utils';
import type { UpdateInfo } from './update-check.js';

const NOTICE_FMT = `\n  \x1b[33m↑ Update available: v%s → v%s\x1b[0m  Run \`wrongstack update\` to upgrade.\n\n`;
const READY_FMT = `\n  \x1b[33m↑ v%s is downloaded\x1b[0m  It replaces this executable when this session exits.\n\n`;
const READY_MANUAL_FMT = `\n  \x1b[33m↑ v%s is downloaded\x1b[0m  Run \`wrongstack update\` to install it.\n\n`;
const APPLIED_FMT = `\n  \x1b[32m✓ Updated wrongstack v%s → v%s\x1b[0m\n\n`;

/** Background-update notices of the standalone executable; true when one was printed. */
async function printStandaloneUpdateNotice(
  info: UpdateInfo | undefined,
  config: Config | undefined,
): Promise<boolean> {
  const [{ autoUpdateEnabled, standaloneUpdater, takeAppliedUpdate }, { isNewer }, version] =
    await Promise.all([
      import('./standalone-auto-update.js'),
      import('./update-check.js'),
      import('./version.js'),
    ]);
  const applied = takeAppliedUpdate();
  if (applied) writeErr(APPLIED_FMT.replace('%s', applied.from).replace('%s', applied.to));
  // Only this executable's build: another install's is not swapped in by this one.
  const pending = standaloneUpdater({
    executable: realpathSync(process.execPath),
    target: version.STANDALONE_TARGET ?? '',
    current: version.CLI_VERSION,
  }).pending();
  if (
    pending &&
    info &&
    isNewer(pending.version, info.current) &&
    pending.version === info.latest
  ) {
    // Switched off, the exit swap does not run; the build waits for `wstack update`.
    const fmt = autoUpdateEnabled(config) ? READY_FMT : READY_MANUAL_FMT;
    writeErr(fmt.replace('%s', pending.version));
    return true;
  }
  return false;
}

export async function printUpdateNotice(
  initialUpdateInfo?: UpdateInfo | undefined,
  config?: Config | undefined,
): Promise<UpdateInfo | undefined> {
  let info = initialUpdateInfo;
  if (!info?.outdated) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    try {
      const { checkForUpdate } = await import('./update-check.js');
      info = await checkForUpdate(ac.signal);
    } catch {
      // best-effort
    } finally {
      clearTimeout(timer);
    }
  }
  let reported = false;
  if (isStandaloneBinary()) {
    try {
      reported = await printStandaloneUpdateNotice(info, config);
    } catch {
      // best-effort
    }
  }
  if (info?.outdated && !reported) {
    writeErr(NOTICE_FMT.replace('%s', info.current).replace('%s', info.latest));
  }
  return info;
}
