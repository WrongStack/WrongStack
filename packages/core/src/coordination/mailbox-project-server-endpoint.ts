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
  return createHash('sha256').update(normalizeLocalPath(projectDir)).digest('hex').slice(0, 24);
}

/**
 * Deterministic per-project mailbox IPC endpoint.
 *
 * The Unix subdirectory is the short `wsmb-v<V>/` (was
 * `wrongstack-mailbox-v<V>/`, which left only 3 bytes of macOS `sun_path`
 * headroom under the ~48-byte per-user TMPDIR — see the codebase-index macOS
 * incident and `@wrongstack/persistence` socket-path helpers). ~86 bytes
 * worst-case macOS now.
 *
 * Migration: the protocol version stays embedded in the path, so this rename
 * behaves exactly like a protocol bump — old daemons keep listening on the old
 * `wrongstack-mailbox-v<V>/` path, are never contacted again, and exit on
 * their idle timeout. No coexistence window: a client build always talks only
 * to the endpoint scheme it derives. Bump
 * `MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION` for wire changes as before; the
 * prefix itself must not grow without re-checking the byte budget.
 * The Windows pipe name keeps the long prefix — named pipes have no
 * `sun_path` limit.
 */
export function mailboxProjectServerEndpoint(projectDir: string): string {
  const key = mailboxProjectServerKey(projectDir);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-mailbox-v${MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  return path.join(os.tmpdir(), `wsmb-v${MAILBOX_PROJECT_SERVER_PROTOCOL_VERSION}`, `${key}.sock`);
}

export function mailboxProjectServerMetadataPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), MAILBOX_PROJECT_SERVER_METADATA_FILE);
}

export function ensureMailboxProjectServerSocketDirectory(endpoint: string): void {
  if (process.platform !== 'win32') {
    // ~86 bytes under a canonical macOS TMPDIR since the wsmb-v1/ rename.
    // Assert so growth fails loudly instead of as a silent bind error in the
    // detached daemon (see the codebase-index macOS incident).
    assertUnixSocketPathWithinLimit(endpoint, 'mailbox');
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  }
}
