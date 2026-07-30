import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertUnixSocketPathWithinLimit, canonicalProjectRoot } from '@wrongstack/core/utils';
import { resolveSagePaths } from './paths.js';
import { SAGE_PROJECT_SERVER_PROTOCOL_VERSION } from './project-server-protocol.js';

export const SAGE_PROJECT_SERVER_METADATA_FILE = 'server.json';

function normalizeLocalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function resolveProjectSageStorageRoot(projectRoot: string, directory?: string): string {
  return resolveSagePaths(canonicalProjectRoot(projectRoot), directory).rootDir;
}

export function sageProjectServerKey(projectRoot: string, directory?: string): string {
  const storageRoot = normalizeLocalPath(resolveProjectSageStorageRoot(projectRoot, directory));
  return createHash('sha256').update(storageRoot).digest('hex').slice(0, 24);
}

/**
 * Deterministic per-project SAGE IPC endpoint.
 *
 * The Unix subdirectory is the short `wssg-v<V>/` (was `wrongstack-sage-v<V>/`
 * at 97 of 103 usable macOS `sun_path` bytes — see the codebase-index macOS
 * incident and `@wrongstack/persistence` socket-path helpers). ~86 bytes
 * worst-case macOS now.
 *
 * Migration: the protocol version stays embedded in the path, so this rename
 * behaves exactly like a protocol bump — old daemons keep listening on the old
 * path, are never contacted again, and exit on their idle timeout. No
 * coexistence window. The Windows pipe name keeps the long prefix — named
 * pipes have no `sun_path` limit.
 */
export function sageProjectServerEndpoint(projectRoot: string, directory?: string): string {
  const key = sageProjectServerKey(projectRoot, directory);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-sage-v${SAGE_PROJECT_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  return path.join(
    os.tmpdir(),
    `wssg-v${SAGE_PROJECT_SERVER_PROTOCOL_VERSION}`,
    `${key}.sock`,
  );
}

export function sageProjectServerMetadataPath(projectRoot: string, directory?: string): string {
  return path.join(
    resolveProjectSageStorageRoot(projectRoot, directory),
    SAGE_PROJECT_SERVER_METADATA_FILE,
  );
}

export function ensureSageProjectServerSocketDirectory(endpoint: string): void {
  if (process.platform !== 'win32') {
    // ~86 bytes under a canonical macOS TMPDIR since the wssg-v1/ rename.
    // Assert so growth fails loudly instead of as a silent bind error in the
    // detached daemon (see the codebase-index macOS incident).
    assertUnixSocketPathWithinLimit(endpoint, 'sage');
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  }
}
