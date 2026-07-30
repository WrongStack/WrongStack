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

/**
 * Deterministic per-project Kanban IPC endpoint.
 *
 * The Unix layout is a short `wskb-v<V>/` subdirectory (was a flat
 * `wrongstack-kanban-v<V>-<key>.sock` at 99 of 103 usable macOS `sun_path`
 * bytes — see the codebase-index macOS incident and the
 * `@wrongstack/persistence` socket-path helpers). ~86 bytes worst-case macOS
 * now, and the `0o700` subdirectory restores the ownership boundary a flat
 * file in multi-user `/tmp` lacks.
 *
 * Migration: the protocol version stays embedded in the path, so this rename
 * behaves exactly like a protocol bump — old daemons keep listening on the old
 * path, are never contacted again, and exit on their idle timeout. No
 * coexistence window. The Windows pipe name keeps the long prefix — named
 * pipes have no `sun_path` limit.
 *
 * Derivation stays pure: clients need the endpoint VALUE to report or degrade
 * on an unbindable path. The hard length assert lives at bind time in
 * `ensureParentDir` in project-server.ts.
 */
export function kanbanProjectServerEndpoint(projectRoot: string): string {
  const key = projectKey(projectRoot);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-kanban-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  const dir = process.env['TMPDIR'] ?? '/tmp';
  return path.join(dir, `wskb-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}`, `${key}.sock`);
}
