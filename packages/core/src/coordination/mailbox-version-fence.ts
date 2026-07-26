/**
 * Writer-version fence for safe mixed-version mailbox mutation.
 *
 * GM-P0.4A: Once any v2 receipt record is appended to a mailbox file,
 * previous-version processes MUST be prevented from mutating that file.
 * This prevents an old compactor from erasing v2 receipt state or collapsing
 * actor-scoped completion back into global state.
 *
 * Implementation: a sentinel line `{"__mailboxVersion":2}` is written
 * to the JSONL file before or alongside the first v2 receipt record.
 * An old process that encounters the marker MUST refuse mutation operations.
 *
 * The fence is checked at the start of every mutation (send, ack, softDelete,
 * restore, purge, compact, clearAll). Read operations are unaffected — old
 * processes can still read v2 mailboxes (they simply ignore unknown JSONL lines).
 *
 * @module mailbox-version-fence
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** The sentinel line written to mark a mailbox file as v2-fenced. */
export const MAILBOX_VERSION_SENTINEL = '{"__mailboxVersion":2}';

/** Discriminator key for the version marker. */
export const MAILBOX_VERSION_KEY = '__mailboxVersion';

/** Current mailbox file version. */
export const MAILBOX_VERSION_CURRENT = 2;

/**
 * Check if a parsed JSONL value is a version marker.
 */
export function isMailboxVersionMarker(value: unknown): value is { __mailboxVersion: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v[MAILBOX_VERSION_KEY] !== undefined && typeof v[MAILBOX_VERSION_KEY] === 'number';
}

/**
 * Error thrown when an old process attempts to mutate a v2-fenced mailbox.
 */
export class MailboxVersionFenceError extends Error {
  readonly expectedVersion: number;
  readonly foundVersion: number;
  readonly mailboxPath: string;

  constructor(mailboxPath: string, expectedVersion: number, foundVersion: number) {
    super(
      `Mailbox ${mailboxPath} is version ${foundVersion} (expected ${expectedVersion}). ` +
        'A newer process has written v2 receipt records. ' +
        'Mutation is refused to prevent data corruption. ' +
        'Update to the latest version or roll back using an offline backup.',
    );
    this.name = 'MailboxVersionFenceError';
    this.expectedVersion = expectedVersion;
    this.foundVersion = foundVersion;
    this.mailboxPath = mailboxPath;
  }
}

/**
 * Check whether a mailbox file contains a version marker.
 * Returns the detected version, or `null` if no marker is present (v1).
 *
 * This is a read-only check — it does NOT mutate the file.
 */
export async function checkMailboxVersion(mailboxPath: string): Promise<number | null> {
  try {
    const raw = await fsp.readFile(mailboxPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isMailboxVersionMarker(parsed)) {
          return parsed[MAILBOX_VERSION_KEY]!;
        }
      } catch {
        // Skip malformed lines — they're not version markers.
      }
    }
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist yet — no version marker, safe to write.
      return null;
    }
    throw err;
  }
}

/**
 * Check whether a raw JSONL string contains a version marker.
 * Non-async variant for use inside locked sections where the file content
 * is already in memory.
 */
export function checkMailboxVersionFromContent(raw: string): number | null {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isMailboxVersionMarker(parsed)) {
        return parsed[MAILBOX_VERSION_KEY]!;
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return null;
}

/**
 * Assert that the mailbox file is NOT v2-fenced (or is at our version).
 * Called at the start of mutation operations.
 *
 * @throws {MailboxVersionFenceError} if the file has a newer version marker.
 */
export async function assertMailboxNotFenced(
  mailboxPath: string,
  ourVersion: number = MAILBOX_VERSION_CURRENT,
): Promise<void> {
  const version = await checkMailboxVersion(mailboxPath);
  if (version !== null && version > ourVersion) {
    throw new MailboxVersionFenceError(mailboxPath, ourVersion, version);
  }
}

/**
 * Write the version sentinel to a mailbox file if it doesn't already have one.
 * Called before appending the first v2 receipt record.
 *
 * This operation is idempotent — if the sentinel already exists, it's a no-op.
 * The caller MUST hold the file lock when calling this.
 */
export async function ensureVersionSentinel(mailboxPath: string): Promise<void> {
  const existingVersion = await checkMailboxVersion(mailboxPath);
  if (existingVersion !== null && existingVersion >= MAILBOX_VERSION_CURRENT) {
    return; // Already fenced.
  }

  // Append the sentinel line.
  const line = MAILBOX_VERSION_SENTINEL + '\n';
  await fsp.mkdir(path.dirname(mailboxPath), { recursive: true });
  await fsp.appendFile(mailboxPath, line, 'utf8');
}

/**
 * Build the sentinel line for inclusion in a batch append.
 * Useful when you want to write the sentinel alongside the first v2 receipt
 * in a single appendFile call.
 */
export function sentinelLine(): string {
  return MAILBOX_VERSION_SENTINEL + '\n';
}
