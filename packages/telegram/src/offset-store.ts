import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { wstackGlobalRoot } from '@wrongstack/core/utils';

/**
 * Offset file path for a bot token. The token itself never appears in the path.
 * Uses the same hash convention as PollLock so both are discoverable together.
 */
export function offsetPathForToken(token: string, globalRoot = wstackGlobalRoot()): string {
  const hash = createHash('sha256').update(token).digest('hex').slice(0, 12);
  return join(globalRoot, 'telegram', `offset-${hash}.json`);
}

/**
 * Typed offset-cursor persistence for Telegram bot polling.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write never leaves a
 * corrupt or incomplete file. Reads handle missing, empty, and malformed files
 * transparently — the caller always gets a valid non-negative number or null.
 */
export interface OffsetStoreOptions {
  /** Bot token — derives a token-scoped default path. Never persisted. */
  token?: string | undefined;
  /**
   * Explicit file path override. Takes precedence over token derivation. An
   * empty string is treated as "no path", which disables persistence.
   */
  path?: string | undefined;
  /** Base directory for token-scoped derivation (defaults to wstackGlobalRoot). */
  globalRoot?: string | undefined;
}

export class OffsetStore {
  private readonly path: string;

  constructor(opts: OffsetStoreOptions = {}) {
    if (opts.path !== undefined) {
      this.path = opts.path;
    } else if (opts.token) {
      this.path = offsetPathForToken(opts.token, opts.globalRoot);
    } else {
      this.path = '';
    }
  }

  /** The derived path for diagnostics. */
  get storePath(): string {
    return this.path;
  }

  /**
   * Read the persisted offset. Returns null when the file is missing, empty,
   * or contains a value that is not a valid non-negative integer.
   */
  read(): number | null {
    if (!this.path) return null;

    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8').trim();
    } catch {
      return null;
    }

    if (raw.length === 0) return null;

    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed !== 'number' ||
        !Number.isFinite(parsed) ||
        parsed < 0 ||
        parsed % 1 !== 0
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Persist an offset value using an atomic write (temp file + rename).
   * Creates the parent directory on first call.
   */
  write(offset: number): void {
    if (!this.path || offset < 0) return;

    mkdirSync(dirname(this.path), { recursive: true });

    const tmp = `${this.path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    // Write to a temp file, fsync it to durable storage, then atomically rename
    // over the target. fsync before rename guarantees the bytes are on disk on
    // both POSIX and Windows before the rename makes them visible.
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(offset));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.path);
    } catch {
      // If rename fails (e.g. cross-device on some setups), clean up the temp
      // file so we don't leak it. The caller can retry on the next poll cycle.
      try {
        unlinkSync(tmp);
      } catch {
        // Temp file removal is best-effort.
      }
    }
  }
}
