/**
 * sun_path headroom ratchet for the SAGE project daemon, mirroring
 * `packages/core/tests/coordination/project-server-endpoint-length.test.ts`.
 *
 * The old `wrongstack-sage-v1/` subdirectory sat at 97 of 103 usable macOS
 * `sun_path` bytes; the short `wssg-v<V>/` layout keeps ≥13 bytes spare.
 */
import { describe, expect, it } from 'vitest';
import { checkUnixSocketPath } from '@wrongstack/core/utils';
import { sageProjectServerEndpoint } from '../src/project-server-endpoint.js';
import { SAGE_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/project-server-protocol.js';

/** Canonical macOS per-user temp dir shape: /var/folders/<2>/<30>/T (48 bytes). */
const WORST_CASE_MACOS_TMPDIR = '/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123/T';

describe('sage socket endpoint keeps macOS sun_path headroom', () => {
  it('Unix layout stays under 90 bytes worst-case', () => {
    const unixPath = `${WORST_CASE_MACOS_TMPDIR}/wssg-v${SAGE_PROJECT_SERVER_PROTOCOL_VERSION}/${'a'.repeat(24)}.sock`;
    const check = checkUnixSocketPath(unixPath, 'darwin');
    expect(check.ok).toBe(true);
    expect(check.byteLength).toBeLessThan(90);
  });

  it('the live Unix endpoint uses the short subdirectory', () => {
    const live = sageProjectServerEndpoint('/workspace/p');
    if (process.platform === 'win32') {
      expect(live).toContain('\\\\.\\pipe\\');
      return;
    }
    expect(live).toContain(`/wssg-v${SAGE_PROJECT_SERVER_PROTOCOL_VERSION}/`);
  });
});
