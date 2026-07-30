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
  // Derivation stays pure: clients need the endpoint VALUE to report or
  // degrade on an unbindable path (`isKanbanServerAvailable`, connection
  // probes). The hard length assert lives at bind time in
  // `ensureParentDir` in project-server.ts, mirroring the codebase-index
  // pattern. The endpoint is ~99 bytes under a canonical macOS TMPDIR —
  // close to the 103-byte `sun_path` budget — and would surface as an
  // opaque ENAMETOOLONG inside the detached daemon whose stderr is
  // discarded, so we fail fast with an actionable message there instead.
  return path.join(
    dir,
    `wrongstack-kanban-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}-${key}.sock`,
  );
}
