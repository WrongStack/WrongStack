import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIndexDir } from './writer.js';

export const PROJECT_INDEX_SERVER_PROTOCOL_VERSION = 1;
const PROJECT_INDEX_SERVER_METADATA_FILE = 'server.json';
/**
 * Short directory name that owns the per-project Unix socket on Linux.
 *
 * The directory is created `0o700` by `bindProjectEndpoint`: on
 * multi-user Linux `/tmp` the kernel's sticky bit otherwise lets a local
 * attacker pre-bind a predictable socket name (project paths are guessable
 * via the public `buildId` handshake), hijacking clients whose `bind()` hits
 * EADDRINUSE. macOS is unaffected because each user already has a private
 * TMPDIR, so the subdirectory adds no extra ownership boundary there.
 *
 * The name is kept short to stay under the 103-byte `sun_path` cap on macOS
 * (48 bytes of `/var/folders/<xx>/<30 chars>/T` + 8 + 24 + 5 = 85 bytes).
 */
const PROJECT_INDEX_SERVER_SOCKET_DIR = `wsci-v${PROJECT_INDEX_SERVER_PROTOCOL_VERSION}`;

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
  // Vite query-suffixed imports (`project-server.ts?case=…`) surface in
  // import.meta.url; fileURLToPath rejects the query, so strip it. The
  // artifact identity is the file content, which the query does not change.
  const href = entrypoint instanceof URL ? entrypoint.href : entrypoint;
  const cleanHref = href.split(/[?#]/, 1)[0] ?? href;
  const file = cleanHref.startsWith('file:') ? fileURLToPath(cleanHref) : path.resolve(cleanHref);
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
 * The Unix layout places the socket inside a short `wsci-v1/` subdirectory of
 * the temp dir: macOS's per-user TMPDIR is ~48 bytes of
 * `/var/folders/<xx>/<30 chars>/T`, and `sun_path` caps the whole socket path
 * at 104 bytes including the NUL on macOS/BSD (108 on Linux). The previous
 * `wrongstack-codebase-index-v1/<key>.sock` subdirectory layout came to ~107
 * bytes there, so `bind()` failed with ENAMETOOLONG inside a detached child
 * whose stderr was discarded — clients saw only a 10s connect timeout. The
 * short `wsci-v1/` subdirectory stays well under both limits (85 bytes on the
 * worst-case macOS TMPDIR) and restores the `0o700` ownership boundary the
 * flat layout lost on multi-user Linux `/tmp`. The pipe name keeps the long
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
  // `bindProjectEndpoint` (@wrongstack/persistence), platform-aware via the
  // shared helper.
  return path.join(os.tmpdir(), PROJECT_INDEX_SERVER_SOCKET_DIR, `${key}.sock`);
}

export function projectIndexServerMetadataPath(projectRoot: string, indexDir?: string): string {
  return path.join(
    path.resolve(resolveIndexDir(projectRoot, indexDir)),
    PROJECT_INDEX_SERVER_METADATA_FILE,
  );
}
