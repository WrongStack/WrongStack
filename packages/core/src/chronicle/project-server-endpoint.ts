import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION } from './project-server-protocol.js';

export const CHRONICLE_PROJECT_SERVER_METADATA_FILE = 'server.json';

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function chronicleProjectServerKey(projectDir: string): string {
  return createHash('sha256')
    .update(normalizedPath(path.join(projectDir, 'chronicle')))
    .digest('hex')
    .slice(0, 24);
}

export function chronicleProjectServerEndpoint(projectDir: string): string {
  const key = chronicleProjectServerKey(projectDir);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-chronicle-v${CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  return path.join(
    os.tmpdir(),
    `wrongstack-chronicle-v${CHRONICLE_PROJECT_SERVER_PROTOCOL_VERSION}`,
    `${key}.sock`,
  );
}

export function chronicleProjectServerMetadataPath(projectDir: string): string {
  return path.join(projectDir, 'chronicle', CHRONICLE_PROJECT_SERVER_METADATA_FILE);
}

export function ensureChronicleProjectServerSocketDirectory(endpoint: string): void {
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  }
}
