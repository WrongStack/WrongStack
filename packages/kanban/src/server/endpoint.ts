import { createHash } from 'node:crypto';
import * as path from 'node:path';

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
  return path.join(dir, `wrongstack-kanban-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}-${key}.sock`);
}
