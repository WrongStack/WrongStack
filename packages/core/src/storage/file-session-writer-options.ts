import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import type { SessionEvent, SessionSummary } from '@wrongstack/contracts/types/session';
import type { SessionCheckpointCas } from './session-checkpoint-cas.js';

/** Constructor options for `FileSessionWriter` (file-session-writer.ts). */
export interface FileSessionWriterOptions {
  resumed?: boolean | undefined;
  dir?: string | undefined;
  filePath?: string | undefined;
  secretScrubber?: SecretScrubber | undefined;
  checkpointCas?: SessionCheckpointCas | undefined;
  /** Called synchronously after each event is scrubbed + observed, before it enters the write buffer. */
  onAppend?: ((event: SessionEvent) => void) | undefined;
  /** Batch variant called after all events in the batch have been scrubbed + observed. */
  onAppendBatch?: ((events: SessionEvent[]) => void) | undefined;
  /** Existing cumulative summary when reopening a persisted session. */
  initialSummary?: SessionSummary | undefined;
  /** Called on close() with the finalized summary for index/sidecar writes. */
  onClose?: ((summary: SessionSummary) => void | Promise<void>) | undefined;
  /** Reconcile an explicit name changed while this writer remained open. */
  resolveName?: (() => Promise<Pick<SessionSummary, 'name'> | null>) | undefined;
  /**
   * Mid-session metadata checkpoint throttle (ms). While the session is
   * live and dirty, the summary sidecar + index row are refreshed at most
   * this often, so a SIGKILLed process still leaves accurate listing
   * metadata instead of its create-time stub. 0 disables checkpointing —
   * killed sessions then stay visible through the store's list()-union
   * scan, but only with analyzer-derived metadata rather than tracked
   * counters. Default 10_000.
   */
  metadataCheckpointMs?: number | undefined;
  /**
   * Persists a mid-session summary snapshot (store-level index row /
   * catalog upsert). The sidecar file itself is written by the writer
   * under its manifest lock; this callback covers the index side.
   */
  onMetadataCheckpoint?: ((summary: SessionSummary) => void | Promise<void>) | undefined;
}
