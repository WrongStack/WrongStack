import { expectDefined } from '../utils/expect-defined.js';
import { toErrorMessage } from '../utils/error.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { sessionScopedPath } from '../utils/session-scoped-path.js';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { WrongStackError, ERROR_CODES } from '../types/errors.js';
import type { EventBus } from '../kernel/events.js';
/**
 * L2-B: AnnotationsStore — sidecar storage for collaboration annotations
 * (Phase 2 of idea #13 from IDEAS.md).
 *
 * Why a sidecar file, not the session JSONL?
 *
 *   The session log is an event-sourced append-only journal
 *   (`packages/core/src/types/session.ts` invariant: events are
 *   append-only, with `truncateToCheckpoint` only as an explicit
 *   rewind). Mixing in human-typed annotations would break that
 *   invariant — the user's note about "this rm looks dangerous"
 *   is not part of the agent's event history; it is meta-commentary
 *   on the history.
 *
 *   So we keep annotations in a sibling file: one JSON document per
 *   session, resolved with `sessionScopedPath(sessionDir, sessionId,
 *   '.annotations.json')`. The shape is a simple versioned array,
 *   written atomically.
 *
 * Concurrency model:
 *
 *   The store uses a per-session Promise chain to serialize writes.
 *   Multiple annotators adding notes at the same time will queue,
 *   not race. The atomic write itself is the second line of
 *   defense (in case the chain is bypassed — e.g. two processes
 *   pointing at the same dir).
 */

/** Wire/storage shape for one annotation. */
export interface Annotation {
  /** Stable id (UUIDv4-ish). Referenced by resolve/delete. */
  id: string;
  /** Session this annotation belongs to. */
  sessionId: string;
  /** Index into the session event log the annotation refers to. */
  atEventIndex: number;
  /** Participant id of the annotator (matches WSCollabParticipantJoined.participantId). */
  authorId: string;
  /** Human-readable role label snapshot for display (e.g. "annotator"). */
  authorRole: 'annotator';
  /** The note itself. Trimmed, capped at `MAX_TEXT_LENGTH` on add. */
  text: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Resolved state. Annotations start unresolved. */
  resolved: boolean;
  /** ISO timestamp when resolved (if resolved). */
  resolvedAt?: string | undefined;
  /** Participant id of the resolver (if resolved). */
  resolvedBy?: string | undefined;
}

interface AnnotationsFile {
  /** Bumped when the on-disk shape changes. v1 = initial release. */
  version: 1;
  annotations: Annotation[];
}

/** Bumped when the on-disk shape changes. Bump + migration on change. */
const FILE_VERSION = 1;
/** Hard cap to keep a runaway annotator from writing megabytes. */
const MAX_TEXT_LENGTH = 2000;
/** Hard cap on total annotations per session (oldest are evicted beyond this). */
const MAX_ANNOTATIONS = 1000;

export interface AnnotationsStoreOptions {
  /** Root sessions directory used with `sessionScopedPath(..., '.annotations.json')`. */
  dir: string;
  events?: EventBus;
  traceId?: string;
}

export class AnnotationsStore {
  private readonly dir: string;
  private readonly events: EventBus | undefined;
  private readonly traceId: string | undefined;
  /** Per-session write queue. Created lazily on first add. */
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(opts: AnnotationsStoreOptions) {
    this.dir = opts.dir;
    this.events = opts.events;
    this.traceId = opts.traceId;
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  /**
   * Return all annotations for `sessionId` in insertion order
   * (oldest first). Returns an empty array when no file exists
   * yet (the normal case for a fresh session) and also degrades
   * gracefully to `[]` on a read error (permissions, corruption) —
   * the failure is still surfaced via a `storage.read` event so it
   * never silently hides I/O problems from observers.
   */
  async list(sessionId: string): Promise<Annotation[]> {
    const t0 = Date.now();
    const fp = this.filePath(sessionId);
    try {
      const file = await this.readFile(sessionId);
      const durationMs = Date.now() - t0;
      this.events?.emit('storage.read', {
        sessionId,
        store: 'annotations',
        filePath: fp,
        operation: 'list',
        outcome: 'success',
        durationMs,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      return file ? file.annotations : [];
    } catch (err) {
      this.events?.emit('storage.read', {
        sessionId,
        store: 'annotations',
        filePath: fp,
        operation: 'list',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: toErrorMessage(err),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      return [];
    }
  }

  /**
   * Convenience: only unresolved annotations, newest first — the
   * common UI rendering for "what still needs attention?".
   */
  async listOpen(sessionId: string): Promise<Annotation[]> {
    const all = await this.list(sessionId);
    return all.filter((a) => !a.resolved).reverse();
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  /**
   * Add a new annotation. Returns the persisted record (with id
   * and timestamps filled in). Throws when `text` is empty or
   * exceeds `MAX_TEXT_LENGTH`.
   */
  async add(input: {
    sessionId: string;
    atEventIndex: number;
    authorId: string;
    text: string;
  }): Promise<Annotation> {
    const text = input.text.trim();
    if (text.length === 0) {
      throw new WrongStackError({
        message: 'Annotation text must be non-empty',
        code: ERROR_CODES.VALIDATION_ERROR,
        subsystem: 'general',
        context: { field: 'text', sessionId: input.sessionId },
      });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new WrongStackError({
        message: `Annotation text exceeds ${MAX_TEXT_LENGTH} chars (got ${text.length})`,
        code: ERROR_CODES.VALIDATION_ERROR,
        subsystem: 'general',
        context: { field: 'text', maxLength: MAX_TEXT_LENGTH, actualLength: text.length },
      });
    }
    if (!Number.isInteger(input.atEventIndex) || input.atEventIndex < 0) {
      throw new WrongStackError({
        message: 'atEventIndex must be a non-negative integer',
        code: ERROR_CODES.VALIDATION_ERROR,
        subsystem: 'general',
        context: { field: 'atEventIndex', value: input.atEventIndex },
      });
    }
    const annotation: Annotation = {
      id: randomUUID(),
      sessionId: input.sessionId,
      atEventIndex: input.atEventIndex,
      authorId: input.authorId,
      authorRole: 'annotator',
      text,
      createdAt: new Date().toISOString(),
      resolved: false,
    };
    const fp = this.filePath(input.sessionId);
    const t0 = Date.now();
    try {
      await this.enqueue(input.sessionId, async () => {
        await withFileLock(fp, async () => {
          const all = await this.list(input.sessionId);
          all.push(annotation);
          // Evict oldest if we crossed the cap. Resolved first, then oldest.
          if (all.length > MAX_ANNOTATIONS) {
            const sorted = all
              .map((a, i) => ({ a, i }))
              .sort((x, y) => {
                // resolved=false wins (keep unresolved); among same resolved state, oldest first.
                /* v8 ignore next -- scale+tiebreak: needs >1000 annotations with mixed resolved states */
                if (x.a.resolved !== y.a.resolved) return x.a.resolved ? 1 : -1;
                return x.a.createdAt.localeCompare(y.a.createdAt);
              });
            const evictCount = all.length - MAX_ANNOTATIONS;
            const toEvict = new Set(sorted.slice(0, evictCount).map((s) => s.a.id));
            const kept = all.filter((a) => !toEvict.has(a.id));
            await this.writeFile(input.sessionId, { version: FILE_VERSION, annotations: kept });
            const durationMs = Date.now() - t0;
            this.events?.emit('storage.write', {
              sessionId: input.sessionId,
              store: 'annotations',
              filePath: fp,
              operation: 'evict',
              outcome: 'success',
              durationMs,
              ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
            });
          } else {
            await this.writeFile(input.sessionId, { version: FILE_VERSION, annotations: all });
            const durationMs = Date.now() - t0;
            this.events?.emit('storage.write', {
              sessionId: input.sessionId,
              store: 'annotations',
              filePath: fp,
              operation: 'add',
              outcome: 'success',
              durationMs,
              ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
            });
          }
        });
      });
      return annotation;
    } catch (err) {
      this.events?.emit('storage.error', {
        sessionId: input.sessionId,
        store: 'annotations',
        filePath: fp,
        operation: 'add',
        outcome: 'failure',
        error: toErrorMessage(err),
        recoverable: false,
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      throw err;
    }
  }

  /**
   * Mark an annotation as resolved. Returns the updated record, or
   * `null` if no annotation with that id exists in this session.
   * Idempotent: resolving an already-resolved annotation refreshes
   * `resolvedAt` / `resolvedBy` to the latest call.
   */
  async resolve(input: {
    sessionId: string;
    annotationId: string;
    resolvedBy: string;
  }): Promise<Annotation | null> {
    let updated: Annotation | null = null;
    const fp = this.filePath(input.sessionId);
    const t0 = Date.now();
    try {
      await this.enqueue(input.sessionId, async () => {
        await withFileLock(fp, async () => {
          const all = await this.list(input.sessionId);
          const idx = all.findIndex((a) => a.id === input.annotationId);
          if (idx === -1) {
            updated = null;
            return;
          }
          const next: Annotation = {
            ...expectDefined(all[idx]),
            resolved: true,
            resolvedAt: new Date().toISOString(),
            resolvedBy: input.resolvedBy,
          };
          all[idx] = next;
          await this.writeFile(input.sessionId, { version: FILE_VERSION, annotations: all });
          updated = next;
          const durationMs = Date.now() - t0;
          this.events?.emit('storage.write', {
            sessionId: input.sessionId,
            store: 'annotations',
            filePath: fp,
            operation: 'resolve',
            outcome: 'success',
            durationMs,
            ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
          });
        });
      });
      return updated;
    } catch (err) {
      this.events?.emit('storage.error', {
        sessionId: input.sessionId,
        store: 'annotations',
        filePath: fp,
        operation: 'resolve',
        outcome: 'failure',
        error: toErrorMessage(err),
        recoverable: false,
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      throw err;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private filePath(sessionId: string): string {
    // Containment-checked: date-sharded ids ("2026-06-11/<base>") are
    // legitimate; traversal is rejected. A plain slash ban here used to
    // throw for every modern session id, breaking annotations entirely.
    return sessionScopedPath(this.dir, sessionId, '.annotations.json');
  }

  private async readFile(sessionId: string): Promise<AnnotationsFile | null> {
    const fp = this.filePath(sessionId);
    let raw: string;
    try {
      raw = await fs.readFile(fp, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Non-ENOENT I/O errors (EACCES, ENOSPC): re-throw so callers emit
      // storage.error.
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as AnnotationsFile;
      if (parsed.version !== FILE_VERSION) {
        return { version: FILE_VERSION, annotations: [] };
      }
      return parsed;
    } catch {
      // JSON parse error (SyntaxError): treat as empty store — not an I/O failure.
      return null;
    }
  }

  private async writeFile(sessionId: string, file: AnnotationsFile): Promise<void> {
    const fp = this.filePath(sessionId);
    await atomicWrite(fp, JSON.stringify(file, null, 2));
  }

  /**
   * Serialize writes per-sessionId. We chain promises instead of
   * using a Mutex class so the contract is obvious from the
   * call-site: `enqueue(sid, fn)` runs `fn` after every prior
   * enqueue for `sid` has settled.
   */
  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain intact even when `fn` throws; failures
    // shouldn't break subsequent writes.
    this.writeChains.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }
}
