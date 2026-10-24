/** Shapes shared by the Chronicle file observer and its scan / journal helpers. */

import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput } from './types.js';

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  hash?: string | undefined;
}

/** One reconciled path with its fingerprints on either side of the change. */
export interface FileChange {
  relative: string;
  before?: FileFingerprint | undefined;
  after?: FileFingerprint | undefined;
}

/**
 * One journal event paired with the fingerprint-state writes that become
 * valid only once that event's commit unit — an `appendBatch` chunk, or a
 * single `append` on the legacy fallback path — has actually landed.
 *
 * Pairing state with its event (rather than keeping a flat side map) is what
 * makes partial-commit recovery exact: when chunk 3 of 5 throws, chunks 1–2
 * have already applied their state, so the retry re-derives only the
 * uncommitted remainder instead of re-emitting committed events.
 */
export interface PendingEvent {
  input: ChronicleEventInput;
  /** `[relative, after]` pairs; `undefined` after marks a delete. */
  state: Array<[relative: string, after: FileFingerprint | undefined]>;
  /**
   * Deferred live `file.activity` emission. Built at observation time but
   * invoked at most once, and only when this event's commit unit lands —
   * emitting at build time meant a failed flush had already announced the
   * change and the recovery re-derive announced it a second time.
   */
  emitActivity?: (() => void) | undefined;
  /**
   * Tool-mutation hint claimed by this event, and the `recentToolMutations`
   * key it was claimed under. Released at commit; restored with a fresh
   * `at` on flush failure so the recovery pass re-attributes the event as
   * `file.tool.*` with its original correlation instead of degrading it to
   * `file.external.*`.
   */
  attribution?: RecentToolMutation | undefined;
  attributionKey?: string | undefined;
}

export interface RecentToolMutation {
  at: number;
  toolUseId: string;
  toolName: string;
  agentId?: string | undefined;
  sessionId?: string | undefined;
}

export interface ChronicleToolMutationHint {
  path: string;
  toolUseId: string;
  toolName: string;
  agentId?: string | undefined;
  sessionId?: string | undefined;
  at?: number | undefined;
}

export interface ChronicleFileObserverOptions {
  projectRoot: string;
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  events?: EventBus | undefined;
  debounceMs?: number | undefined;
  maxHashBytes?: number | undefined;
  excludedDirectories?: readonly string[] | undefined;
  /** Absolute or project-relative path prefixes that must never be observed. */
  excludedPaths?: readonly string[] | undefined;
  /** Min gap between full-project rescans triggered by null-filename events. */
  minFullRescanIntervalMs?: number | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

export interface ChronicleFileObserver {
  close(): Promise<void>;
  readonly watchedFiles: number;
  noteToolMutation(hint: ChronicleToolMutationHint): void;
}
