import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { assertUnixSocketPathWithinLimit } from '@wrongstack/persistence';

import { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from './protocol.js';

function canonicalRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectKey(projectRoot: string): string {
  return createHash('sha256').update(canonicalRoot(projectRoot)).digest('hex').slice(0, 24);
}

export function kanbanProjectServerEndpoint(projectRoot: string): string {
  const key = projectKey(projectRoot);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-kanban-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  const dir = process.env['TMPDIR'] ?? '/tmp';
  const endpoint = path.join(
    dir,
    `wrongstack-kanban-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}-${key}.sock`,
  );
  // ~99 bytes under a canonical macOS TMPDIR — close to the 103-byte sun_path
  // budget. Assert so growth fails loudly instead of as a silent bind error in
  // the detached daemon (see the codebase-index macOS incident).
  assertUnixSocketPathWithinLimit(endpoint, 'kanban');
  return endpoint;
}
