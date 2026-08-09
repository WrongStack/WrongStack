import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertUnixSocketPathWithinLimit } from '../utils/socket-path.js';
import { SESSION_CATALOG_PROTOCOL_VERSION } from './protocol.js';

export const SESSION_CATALOG_METADATA_FILE = '.session-catalog-server.json';

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function sessionCatalogProjectServerKey(projectDir: string): string {
  return createHash('sha256').update(normalizedPath(projectDir)).digest('hex').slice(0, 24);
}

export function sessionCatalogProjectServerEndpoint(projectDir: string): string {
  const key = sessionCatalogProjectServerKey(projectDir);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-session-catalog-v${SESSION_CATALOG_PROTOCOL_VERSION}-${key}`;
  }
  return path.join(os.tmpdir(), `wssc-v${SESSION_CATALOG_PROTOCOL_VERSION}`, `${key}.sock`);
}

export function sessionCatalogProjectServerMetadataPath(projectDir: string): string {
  return path.join(projectDir, SESSION_CATALOG_METADATA_FILE);
}

export function ensureSessionCatalogSocketDirectory(endpoint: string): void {
  if (process.platform === 'win32') return;
  assertUnixSocketPathWithinLimit(endpoint, 'session-catalog');
  fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
}
