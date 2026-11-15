import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isStandaloneBinary, standaloneDaemonUrl } from '@wrongstack/persistence';

/**
 * Locate the built project-server entrypoint.
 *
 * There is deliberately no env var that turns the server off. The mailbox has
 * exactly one mode — one detached owner per project, reached over IPC — so the
 * only reason this returns null is a missing build, and that is an error, not
 * a fallback. `WRONGSTACK_MAILBOX_INLINE` / `WRONGSTACK_MAILBOX_SERVER=0` used
 * to select an in-process store here; they are gone. Do not reintroduce them:
 * the moment a client can quietly open its own store, "one mailbox per
 * project" becomes "one mailbox per process" with no visible symptom.
 */
export function resolveProjectServerUrl(): URL | null {
  if (isStandaloneBinary()) return standaloneDaemonUrl('mailbox');
  for (const relative of [
    // Built output: the package is split into chunks that sit at the dist
    // root next to `mailbox-project-server.js`, so every module resolves it
    // as a sibling. Without it the lookup reports missing-build, which is an
    // error here, never a silent per-process store.
    './mailbox-project-server.js',
    // Source (tests, dev): packages/coordination/src → the package's build.
    '../dist/mailbox-project-server.js',
  ]) {
    try {
      const url = new URL(relative, import.meta.url);
      if (url.protocol !== 'file:') continue;
      const file = fileURLToPath(url);
      // Primary probe: the seam existing callers and tests mock, and the
      // fast path for the common available case.
      if (fs.existsSync(file)) return url;
      // existsSync folds transient stat errors (EMFILE/EPERM/EBUSY spikes
      // under full-suite parallel load) into false. Verify with statSync
      // before declaring the build missing: ENOENT = genuinely absent; any
      // other error (or a contradictory success) = assume present — the
      // recoverable direction, since a spawn against a missing file is a
      // guarded dead child the retry loop survives, while a false negative
      // was fatal to the connect window (observed 2026-09-15, shard 3/4).
      try {
        fs.statSync(file);
        return url;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        return url;
      }
    } catch {
      // Try the next supported build layout.
    }
  }
  return null;
}

export function isMailboxProjectServerAvailable(): boolean {
  return resolveProjectServerUrl() !== null;
}
