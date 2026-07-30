/**
 * sun_path headroom ratchet for the core-owned project daemons (mailbox,
 * chronicle).
 *
 * After the codebase-index macOS incident, every daemon's Unix endpoint must
 * keep real headroom under the 103 usable macOS `sun_path` bytes: the old
 * `wrongstack-mailbox-v3/` and `wrongstack-chronicle-v2/` subdirectories left
 * 3 and 1 byte(s) respectively, so any prefix growth would have re-broken
 * macOS silently. The short `wsmb-v<V>/` / `wsch-v<V>/` layout keeps ≥13
 * bytes spare; this test fails if a rename ever eats into that budget again.
 *
 * The Unix layout is composed from the same protocol-version constants the
 * production code uses (on Windows the live return value is a named pipe with
 * the long prefix — deliberate, since pipes have no sun_path limit — so the
 * Unix branch cannot be exercised through the public function there).
 */
import { describe, expect, it } from 'vitest';
import { checkUnixSocketPath } from '@wrongstack/persistence';
import { chronicleProjectServerEndpoint } from '../../src/chronicle/project-server-endpoint.js';
import { CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION } from '../../src/chronicle/project-server-protocol.js';
import { mailboxProjectServerEndpoint } from '../../src/coordination/mailbox-project-server-endpoint.js';
import { MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION } from '../../src/coordination/mailbox-project-server-protocol.js';

/** Canonical macOS per-user temp dir shape: /var/folders/<2>/<30>/T (48 bytes). */
const WORST_CASE_MACOS_TMPDIR = '/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123/T';

/** 24-hex key + '.sock' — the fixed per-project suffix both daemons append. */
const KEY_FILENAME = `${'a'.repeat(24)}.sock`;

describe('core daemon socket endpoints keep macOS sun_path headroom', () => {
  it.each([
    ['mailbox', `wsmb-v${MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION}`],
    ['chronicle', `wsch-v${CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION}`],
  ])('%s Unix layout stays under 90 bytes worst-case', (_name, subdir) => {
    const unixPath = `${WORST_CASE_MACOS_TMPDIR}/${subdir}/${KEY_FILENAME}`;
    const check = checkUnixSocketPath(unixPath, 'darwin');
    expect(check.ok).toBe(true);
    // Ratchet: ≥13 bytes of headroom (90 vs 103) so prefix growth is caught
    // in review, not by a macOS bind failure.
    expect(check.byteLength).toBeLessThan(90);
  });

  it('the live Unix endpoints actually use the short subdirectories', () => {
    // On Windows the endpoints are named pipes (long prefix by design); the
    // Unix branch is what this repo's macOS/Linux CI exercises.
    if (process.platform === 'win32') {
      expect(mailboxProjectServerEndpoint('/workspace/p')).toContain('\\\\.\\pipe\\');
      expect(chronicleProjectServerEndpoint('/workspace/p')).toContain('\\\\.\\pipe\\');
      return;
    }
    expect(mailboxProjectServerEndpoint('/workspace/p')).toContain(
      `/wsmb-v${MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION}/`,
    );
    expect(chronicleProjectServerEndpoint('/workspace/p')).toContain(
      `/wsch-v${CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION}/`,
    );
  });

  it('documents why the legacy prefixes were replaced (≤3 bytes headroom)', () => {
    const key = 'a'.repeat(24);
    for (const legacyDir of [
      `wrongstack-mailbox-v${MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION}`,
      `wrongstack-chronicle-v${CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION}`,
    ]) {
      const legacy = `${WORST_CASE_MACOS_TMPDIR}/${legacyDir}/${key}.sock`;
      const { byteLength } = checkUnixSocketPath(legacy, 'darwin');
      // 100 and 102 bytes: technically under 103, but with ≤3 bytes headroom —
      // the reason the prefixes were shortened.
      expect(byteLength).toBeGreaterThanOrEqual(100);
      expect(byteLength).toBeLessThanOrEqual(103);
    }
  });
});
