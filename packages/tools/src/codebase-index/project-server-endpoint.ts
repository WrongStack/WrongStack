import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Deterministic per-project local IPC endpoint. */
export function projectIndexServerEndpoint(projectRoot: string, indexDir?: string): string {
  const key = projectIndexServerKey(projectRoot, indexDir);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-codebase-index-v${PROJECT_INDEX_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  return path.join(
    os.tmpdir(),
    `wrongstack-codebase-index-v${PROJECT_INDEX_SERVER_PROTOCOL_VERSION}`,
    `${key}.sock`,
  );
}

export function projectIndexServerMetadataPath(projectRoot: string, indexDir?: string): string {
  return path.join(
    path.resolve(resolveIndexDir(projectRoot, indexDir)),
    PROJECT_INDEX_SERVER_METADATA_FILE,
  );
}

export function ensureProjectIndexSocketDirectory(endpoint: string): void {
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  }
}
