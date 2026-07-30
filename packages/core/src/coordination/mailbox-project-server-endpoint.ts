import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertUnixSocketPathWithinLimit } from '../utils/socket-path.js';
import { MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION } from './mailbox-project-server-protocol.js';

export const MAILBOX_PROJECT_SERVER_METADATA_FILE = '.mailbox-server.json';

function normalizeLocalPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function mailboxProjectServerKey(projectDir: string): string {
  return createHash('sha256')
    .update(normalizeLocalPath(projectDir))
    .digest('hex')
    .slice(0, 24);
}

export function mailboxProjectServerEndpoint(projectDir: string): string {
  const key = mailboxProjectServerKey(projectDir);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-mailbox-v${MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  return path.join(
    os.tmpdir(),
    `wrongstack-mailbox-v${MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION}`,
    `${key}.sock`,
  );
}

export function mailboxProjectServerMetadataPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), MAILBOX_PROJECT_SERVER_METADATA_FILE);
}

export function ensureMailboxProjectServerSocketDirectory(endpoint: string): void {
  if (process.platform !== 'win32') {
    // 100 bytes under a canonical macOS TMPDIR — only 3 bytes of sun_path
    // headroom. Assert so growth fails loudly instead of as a silent bind
    // error in the detached daemon (see the codebase-index macOS incident).
    assertUnixSocketPathWithinLimit(endpoint, 'mailbox');
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  }
}
