/**
 * Which memory backend this process chose for a project, so surfaces that do
 * not see the configuration (connection health panels, service actions, the
 * project-server client) can tell a WrongMemory project from a local one.
 *
 * Recorded by `createSageMemoryPortForService` (`local` and `wrongmemory`
 * modes) and by the `auto` port once it has picked a backend. Keyed by the
 * resolved project root.
 */
import * as path from 'node:path';

export type SageServiceBackend = 'local' | 'wrongmemory';

export interface SageServiceBackendRecord {
  backend: SageServiceBackend;
  dataRoot?: string | undefined;
}

const records = new Map<string, SageServiceBackendRecord>();

function key(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function recordSageServiceBackend(
  projectRoot: string,
  backend: SageServiceBackend,
  dataRoot?: string | undefined,
): void {
  records.set(key(projectRoot), { backend, dataRoot });
}

/** The backend recorded for `projectRoot`, or `undefined` when none was chosen here. */
export function sageServiceBackendFor(projectRoot: string): SageServiceBackendRecord | undefined {
  return records.get(key(projectRoot));
}

/** Test helper. */
export function clearSageServiceBackends(): void {
  records.clear();
}

/** A local SAGE server must not be started for a project WrongMemory serves. */
export class SageServedByWrongMemoryError extends Error {
  readonly code = 'SAGE_SERVED_BY_WRONGMEMORY' as const;
  constructor(readonly projectRoot: string) {
    super(
      `SAGE memory for ${projectRoot} is served by the WrongMemory service (Sage.service.mode); ` +
        'the local SAGE server is not started. Manage the service with `wstack sage service` or `wrongmemory daemon`.',
    );
    this.name = 'SageServedByWrongMemoryError';
  }
}
