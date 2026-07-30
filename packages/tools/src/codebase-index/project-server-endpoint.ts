import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUnixSocketPathWithinLimit } from '@wrongstack/core/utils';
import { resolveIndexDir } from './writer.js';

export const PROJECT_INDEX_SERVER_PROTOCOL_VERSION = 1;
export const PROJECT_INDEX_SERVER_METADATA_FILE = 'server.json';

let buildIdCache:
  | {
      file: string;
      mtimeMs: number;
      size: number;
      buildId: string;
    }
  | undefined;

/**
 * Content identity for the actual server artifact.
 *
 * Package versions do not change during a local rebuild, so the handshake
 * hashes the resolved `project-server.js` itself. The stat guard avoids
 * re-reading the bundle on every reconnect while still noticing a rebuild in a
 * long-lived client process.
 */
export function projectIndexServerBuildId(entrypoint: string | URL): string {
  const file =
    entrypoint instanceof URL || entrypoint.startsWith('file:')
      ? fileURLToPath(entrypoint)
      : path.resolve(entrypoint);
  try {
    const stat = fs.statSync(file);
    if (
      buildIdCache?.file === file &&
      buildIdCache.mtimeMs === stat.mtimeMs &&
      buildIdCache.size === stat.size
    ) {
      return buildIdCache.buildId;
    }
    const buildId = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 24);
    buildIdCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, buildId };
    return buildId;
  } catch {
    // Both sides resolve the same artifact path. This fallback keeps exotic
    // read-only packagers usable, though normal builds always take the hash.
    return `unreadable:${path.basename(file)}`;
  }
}

function normalizeLocalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Local project identity used by the index transport.
 *
 * The index directory is authoritative rather than the cross-machine project
 * id: worktrees and local clones may share a project id while requiring
 * physically separate SQLite indexes.
 */
export function projectIndexServerKey(projectRoot: string, indexDir?: string): string {
  const resolvedIndexDir = normalizeLocalPath(resolveIndexDir(projectRoot, indexDir));
  return createHash('sha256').update(resolvedIndexDir).digest('hex').slice(0, 24);
}

/**
 * Deterministic per-project local IPC endpoint.
 *
 * The Unix layout is deliberately flat and short (`wsci-v1-<key>.sock`
 * directly in the temp dir): macOS's per-user TMPDIR is ~49 bytes of
 * `/var/folders/<xx>/<30 chars>/T`, and `sun_path` caps the whole socket
 * path at 104 bytes including the NUL on macOS/BSD (108 on Linux). The
 * previous `wrongstack-codebase-index-v1/<key>.sock` subdirectory layout came
 * to ~107 bytes there, so `bind()` failed with ENAMETOOLONG inside a detached
 * child whose stderr was discarded — clients saw only a 10s connect timeout.
 * The flat layout stays well under both limits; the pipe name keeps the long
 * prefix because named pipes have no such limit.
 */
export function projectIndexServerEndpoint(projectRoot: string, indexDir?: string): string {
  const key = projectIndexServerKey(projectRoot, indexDir);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-codebase-index-v${PROJECT_INDEX_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  // Derivation stays pure: clients need the endpoint VALUE to report or
  // degrade on an unbindable path (`resolveProjectIndexDaemonAvailability`,
  // connection-state probes). The hard length assert lives at bind time in
  // `ensureProjectIndexSocketDirectory`, platform-aware via the shared helper.
  return path.join(os.tmpdir(), `wsci-v${PROJECT_INDEX_SERVER_PROTOCOL_VERSION}-${key}.sock`);
}

export function projectIndexServerMetadataPath(projectRoot: string, indexDir?: string): string {
  return path.join(
    path.resolve(resolveIndexDir(projectRoot, indexDir)),
    PROJECT_INDEX_SERVER_METADATA_FILE,
  );
}

export function ensureProjectIndexSocketDirectory(endpoint: string): void {
  if (process.platform !== 'win32') {
    // Fail fast with an actionable message: an over-long sun_path would
    // otherwise surface as ENAMETOOLONG/EINVAL inside a detached child whose
    // stderr is discarded, leaving clients a bare 10s connect timeout.
    assertUnixSocketPathWithinLimit(endpoint, 'codebase-index');
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  }
}
