import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalProjectRoot } from '@wrongstack/core/utils';
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

export function sageProjectServerEndpoint(projectRoot: string, directory?: string): string {
  const key = sageProjectServerKey(projectRoot, directory);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-sage-v${SAGE_PROJECT_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  return path.join(
    os.tmpdir(),
    `wrongstack-sage-v${SAGE_PROJECT_SERVER_PROTOCOL_VERSION}`,
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
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  }
}
