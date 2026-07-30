/**
 * sun_path headroom ratchet for the Kanban project daemon, mirroring
 * `packages/core/tests/coordination/project-server-endpoint-length.test.ts`.
 *
 * The old flat `wrongstack-kanban-v1-<key>.sock` layout sat at 99 of 103
 * usable macOS `sun_path` bytes; the short `wskb-v<V>/` subdirectory keeps
 * ≥13 bytes spare and adds the 0o700 ownership boundary a flat file in
 * multi-user /tmp lacks.
 */
import { describe, expect, it } from 'vitest';
import { checkUnixSocketPath } from '@wrongstack/persistence';
import { kanbanProjectServerEndpoint } from '../src/server/endpoint.js';
import { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/server/protocol.js';

/** Canonical macOS per-user temp dir shape: /var/folders/<2>/<30>/T (48 bytes). */
const WORST_CASE_MACOS_TMPDIR = '/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123/T';

describe('kanban socket endpoint keeps macOS sun_path headroom', () => {
  it('Unix layout stays under 90 bytes worst-case', () => {
    const unixPath = `${WORST_CASE_MACOS_TMPDIR}/wskb-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}/${'a'.repeat(24)}.sock`;
    const check = checkUnixSocketPath(unixPath, 'darwin');
    expect(check.ok).toBe(true);
    expect(check.byteLength).toBeLessThan(90);
  });

  it('the live Unix endpoint uses the short subdirectory', () => {
    const live = kanbanProjectServerEndpoint('/workspace/p');
    if (process.platform === 'win32') {
      expect(live).toContain('\\\\.\\pipe\\');
      return;
    }
    expect(live).toContain(`/wskb-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}/`);
  });
});
