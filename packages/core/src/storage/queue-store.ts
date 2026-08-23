import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from './event-bus-port.js';
import type { ContentBlock } from '../types/blocks.js';
import type { Logger } from '../types/logger.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';

/**
 * The persisted form of a single queued user message. The TUI's
 * in-memory QueueItem has a render id; that's pure UI bookkeeping, so
 * we drop it when serializing — fresh ids are assigned on rehydrate.
 */
export interface PersistedQueueItem {
  displayText: string;
  blocks: ContentBlock[];
  /** When true, the item will be refined via model.refine before entering the agent context. */
  shouldRefine?: boolean | undefined;
  /**
   * Raw (pre-refinement) user text for prompt-journal provenance. Carried on
   * the item so the TUI drainer can stamp `PROMPT_JOURNAL_RAW_MARKER` per-item
   * right before that item runs; survives restart rehydration.
   */
  journalRaw?: string | undefined;
}

/** Hard memory/disk budgets shared by QueueStore and the TUI reducer. */
export const QUEUE_MAX_ITEMS = 100;
export const QUEUE_MAX_BYTES = 16 * 1024 * 1024;
export const QUEUE_MAX_ITEM_BYTES = 8 * 1024 * 1024;

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Keep the FIFO prefix that fits the queue budget. Callers can compare the
 * returned length with the input length to detect a rejected append.
 */
export function retainPersistedQueueItems(
  items: readonly PersistedQueueItem[],
): PersistedQueueItem[] {
  const retained: PersistedQueueItem[] = [];
  let bytes = 2; // JSON array brackets
  for (const item of items) {
    if (retained.length >= QUEUE_MAX_ITEMS) break;
    const itemBytes = serializedBytes(item);
    if (!Number.isFinite(itemBytes) || itemBytes > QUEUE_MAX_ITEM_BYTES) break;
    const nextBytes = bytes + itemBytes + (retained.length > 0 ? 1 : 0);
    if (nextBytes > QUEUE_MAX_BYTES) break;
    retained.push(item);
    bytes = nextBytes;
  }
  return retained;
}

/**
 * Side-file storage for a session's pending input queue. Lives at
 * `<sessionDir>/queue.json` next to the attachment spool. Reads are
 * tolerant (missing/malformed file → empty array); writes are atomic
 * (tmp + rename) so a crash mid-write can never leave a partial file
 * the next launch would choke on.
 *
 * The contract is "snapshot replacement": every mutation hands the
 * full queue and we rewrite the file. The queue is small (rarely more
 * than a handful of messages), so this is cheaper than delta logging
 * and avoids the replay complexity.
 */
export class QueueStore {
  private readonly file: string;
  // Use `| undefined` (not `?`) so exactOptionalPropertyTypes doesn't
  // reject assigning an optional constructor parameter to these fields.
  private readonly events: EventBus | undefined;
  private readonly traceId: string | undefined;
  private readonly logger: Logger | undefined;

  constructor(opts: {
    dir: string;
    events?: EventBus;
    traceId?: string;
    logger?: Logger | undefined;
  }) {
    this.file = path.join(opts.dir, 'queue.json');
    this.events = opts.events;
    this.traceId = opts.traceId;
    this.logger = opts.logger;
  }

  private logWarn(msg: string, ctx?: Record<string, unknown>): void {
    if (this.logger) {
      this.logger.warn(msg, ctx);
    } else {
      console.warn(JSON.stringify({ ...ctx, message: msg, timestamp: new Date().toISOString() }));
    }
  }

  async write(items: PersistedQueueItem[]): Promise<void> {
    const t0 = Date.now();
    if (items.length === 0) {
      // Empty queue → remove the file rather than write `[]`. Keeps
      // a clean idle state on disk and makes `read()` cheaper.
      await this.clear();
      return;
    }
    try {
      const retained = retainPersistedQueueItems(items);
      if (retained.length !== items.length) {
        this.logWarn(
          'Queue snapshot exceeded its memory budget; oversized tail was not persisted',
          {
            event: 'queue_store.budget_exceeded',
            path: this.file,
            suppliedItems: items.length,
            retainedItems: retained.length,
            maxItems: QUEUE_MAX_ITEMS,
            maxBytes: QUEUE_MAX_BYTES,
          },
        );
      }
      if (retained.length === 0) {
        await this.clear();
        return;
      }
      await atomicWrite(this.file, JSON.stringify(retained), { mode: 0o600 });
      this.events?.emit('storage.write', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'write',
        outcome: 'success',
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
    } catch (err) {
      this.events?.emit('storage.error', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'write',
        outcome: 'failure',
        error: toErrorMessage(err),
        recoverable: false,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      this.logWarn('Queue store write failed', {
        event: 'queue_store.write_failed',
        path: this.file,
        message: toErrorMessage(err),
      });
    }
  }

  async read(): Promise<PersistedQueueItem[]> {
    const t0 = Date.now();
    let raw: string;
    try {
      const stat = await fsp.stat(this.file);
      if (stat.size > QUEUE_MAX_BYTES) {
        this.logWarn('Queue file exceeds the safe read budget; ignoring it', {
          event: 'queue_store.read_budget_exceeded',
          path: this.file,
          bytes: stat.size,
          maxBytes: QUEUE_MAX_BYTES,
        });
        this.events?.emit('storage.read', {
          sessionId: this.traceId ?? '~boot~',
          store: 'queue',
          filePath: this.file,
          operation: 'read',
          outcome: 'failure',
          durationMs: Date.now() - t0,
          error: 'size_limit_exceeded',
          ...(this.traceId !== undefined && { traceId: this.traceId }),
        });
        return [];
      }
      raw = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.events?.emit('storage.read', {
          sessionId: this.traceId ?? '~boot~',
          store: 'queue',
          filePath: this.file,
          operation: 'read',
          outcome: 'success',
          durationMs: Date.now() - t0,
          ...(this.traceId !== undefined && { traceId: this.traceId }),
        });
        return [];
      }
      this.events?.emit('storage.error', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'read',
        outcome: 'failure',
        error: toErrorMessage(err),
        recoverable: true,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      this.logWarn('Queue store read failed', {
        event: 'queue_store.read_failed',
        path: this.file,
        message: toErrorMessage(err),
      });
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.events?.emit('storage.read', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'read',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: 'parse_failed',
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      return [];
    }
    if (!Array.isArray(parsed)) {
      this.events?.emit('storage.read', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'read',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: 'invalid_schema',
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      return [];
    }
    this.events?.emit('storage.read', {
      sessionId: this.traceId ?? '~boot~',
      store: 'queue',
      filePath: this.file,
      operation: 'read',
      outcome: 'success',
      durationMs: Date.now() - t0,
      ...(this.traceId !== undefined && { traceId: this.traceId }),
    });
    const out: PersistedQueueItem[] = [];
    let outBytes = 2;
    for (const v of parsed) {
      if (!isPersistedQueueItem(v)) continue;
      if (out.length >= QUEUE_MAX_ITEMS) break;
      const itemBytes = serializedBytes(v);
      if (!Number.isFinite(itemBytes) || itemBytes > QUEUE_MAX_ITEM_BYTES) break;
      const nextBytes = outBytes + itemBytes + (out.length > 0 ? 1 : 0);
      if (nextBytes > QUEUE_MAX_BYTES) break;
      out.push(v);
      outBytes = nextBytes;
    }
    return out;
  }

  async clear(): Promise<void> {
    const t0 = Date.now();
    try {
      await fsp.unlink(this.file);
      this.events?.emit('storage.write', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'clear',
        outcome: 'success',
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      this.events?.emit('storage.error', {
        sessionId: this.traceId ?? '~boot~',
        store: 'queue',
        filePath: this.file,
        operation: 'clear',
        outcome: 'failure',
        error: toErrorMessage(err),
        recoverable: true,
        ...(this.traceId !== undefined && { traceId: this.traceId }),
      });
      // Best-effort: a permission/lock error during clear is rare and
      // the queue slash command is non-critical. Warn so it's observable
      // but don't throw so the slash command doesn't crash.
      this.logWarn('Queue store clear failed', {
        event: 'queue_store.clear_failed',
        path: this.file,
        message: (err as Error).message,
      });
    }
  }
}

function isPersistedQueueItem(v: unknown): v is PersistedQueueItem {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['displayText'] === 'string' && Array.isArray(o['blocks']);
}
