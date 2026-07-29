import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ChronicleRuntimeIdentityInput {
  globalRoot: string;
  projectId: string;
  projectDir: string;
  now?: Date | undefined;
}

export interface ChronicleRuntimeLocation {
  installationId: string;
  machineId: string;
  projectId: string;
  /** Directory holding this project's Chronicle storage, whatever its format. */
  chronicleDirectory: string;
  /**
   * Day this location was resolved for, `YYYY-MM-DD` UTC.
   *
   * It is also the chain scope: the legacy writer used it to name a partition
   * file, and SQLite uses it as the `day` column. Exposing the day rather than
   * a `.jsonl` path keeps identity resolution independent of storage format.
   */
  day: string;
}

/**
 * Resolve privacy-preserving stable IDs and the UTC day that scopes a chain.
 * Raw host names and global paths never enter the journal envelope.
 */
export function resolveChronicleRuntimeLocation(
  input: ChronicleRuntimeIdentityInput,
): ChronicleRuntimeLocation {
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  return {
    installationId: stableId('installation', path.resolve(input.globalRoot)),
    machineId: stableId('machine', `${os.hostname()}\0${os.platform()}\0${os.arch()}`),
    projectId: input.projectId,
    chronicleDirectory: path.join(input.projectDir, 'chronicle'),
    day,
  };
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}
