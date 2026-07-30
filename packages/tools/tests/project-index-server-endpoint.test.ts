import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkUnixSocketPath, unixSocketPathLimit } from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import {
  projectIndexServerBuildId,
  projectIndexServerEndpoint,
  projectIndexServerKey,
  projectIndexServerMetadataPath,
} from '../src/codebase-index/project-server-endpoint.js';

/**
 * Canonical worst-case macOS per-user temp dir: `confstr(_CS_DARWIN_USER_TEMP_DIR)`
 * yields `/var/folders/<2 chars>/<30 chars>/T` (49 bytes). The 2026-07 macOS
 * incident: the old `wrongstack-codebase-index-v1/<key>.sock` subdirectory
 * layout reached 107 bytes here, over the 103 usable `sun_path` bytes, and the
 * detached daemon died silently on bind.
 */
const WORST_CASE_MACOS_TMPDIR = '/var/folders/zz/abcdefghijklmnopqrstuvwxyz0123/T';

describe('project index server endpoint', () => {
  it('is deterministic for one project index and distinct across projects', () => {
    const first = projectIndexServerEndpoint('/workspace/project-a');
    expect(projectIndexServerEndpoint('/workspace/project-a')).toBe(first);
    expect(projectIndexServerEndpoint('/workspace/project-b')).not.toBe(first);
  });

  it('uses an explicit index directory as the local server identity', () => {
    const root = '/workspace/project';
    expect(projectIndexServerKey(root, '/indexes/one')).not.toBe(
      projectIndexServerKey(root, '/indexes/two'),
    );
  });

  it('stores discovery metadata beside the project index database', () => {
    const metadata = projectIndexServerMetadataPath('/workspace/project', '/indexes/custom');
    expect(metadata).toBe(path.join(path.resolve('/indexes/custom'), 'server.json'));
  });

  it('stays under 100 bytes with a worst-case macOS TMPDIR', () => {
    // The Unix filename layout must survive the longest legitimate temp dir.
    // Compose the endpoint exactly as the non-win32 branch does: flat
    // `wsci-v1-<key>.sock` file directly inside the temp dir.
    const key = projectIndexServerKey('/workspace/some-project');
    const filename = `wsci-v1-${key}.sock`;
    const endpoint = path.posix.join(WORST_CASE_MACOS_TMPDIR, filename);
    const byteLength = Buffer.byteLength(endpoint, 'utf8');
    expect(byteLength).toBeLessThan(100);
    expect(checkUnixSocketPath(endpoint, 'darwin')).toMatchObject({ ok: true, maxBytes: 103 });
    // Regression guard for the incident itself: the OLD subdirectory layout
    // must be recognized as over-limit on macOS, or this test proves nothing.
    const legacy = path.posix.join(
      WORST_CASE_MACOS_TMPDIR,
      'wrongstack-codebase-index-v1',
      `${key}.sock`,
    );
    expect(checkUnixSocketPath(legacy, 'darwin').ok).toBe(false);
  });

  it('derives the live endpoint inside the platform temp location', () => {
    const endpoint = projectIndexServerEndpoint('/workspace/project');
    if (process.platform === 'win32') {
      expect(endpoint.startsWith('\\\\.\\pipe\\')).toBe(true);
    } else {
      expect(path.dirname(endpoint)).toBe(os.tmpdir());
      expect(path.basename(endpoint)).toMatch(/^wsci-v\d+-[0-9a-f]{24}\.sock$/);
      expect(Buffer.byteLength(endpoint, 'utf8')).toBeLessThanOrEqual(
        unixSocketPathLimit(),
      );
    }
  });

  it('changes the build identity when the server artifact changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-index-build-id-'));
    const artifact = path.join(dir, 'project-server.js');
    try {
      await fs.writeFile(artifact, 'first');
      const first = projectIndexServerBuildId(artifact);
      expect(projectIndexServerBuildId(pathToFileURL(artifact).href)).toBe(first);
      await fs.writeFile(artifact, 'second-build');

      expect(projectIndexServerBuildId(artifact)).not.toBe(first);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
