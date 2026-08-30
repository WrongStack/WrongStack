/**
 * The `/resume` loading experience.
 *
 * A resume has two phases with completely different pacing, and the screen has
 * to say which one it is in:
 *
 * 1. **reading** — seconds of work with nothing to show. The journal is parsed
 *    (measured: 0.4s for 18 MB, 2.7s for 131 MB), ownership is claimed, the
 *    writer is opened. This phase gets a live block: a spinner, a byte-progress
 *    bar, and a rolling tail of the stages the host actually reports. Before
 *    this existed the screen simply froze on the old transcript with one static
 *    line, which is why a working resume read as a hang.
 * 2. **replaying** — the transcript itself, streamed in in small batches so it
 *    scrolls into place the way it did when it was live, instead of appearing
 *    as one instantaneous wall of text.
 *
 * Everything here is pure so the block can be asserted on directly; the reducer
 * owns the state and the picker hook owns the pacing.
 */

/** Stage names come from the host (`cli/src/boot/tui-session-resume.ts`). */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  start: 'starting',
  no_session_store: 'no session store',
  load_replay_module: 'loading the replay renderer',
  resolve_id: 'resolving the session id',
  reserve_ownership: 'reserving ownership',
  open_journal: 'reading the journal',
  activate_ownership: 'taking ownership',
  replay_history: 'rebuilding the timeline',
  read_sidecars: 'reading todo/plan sidecars',
  swap_writer: 'attaching the session',
  flush_journal: 'flushing the journal',
  repoint_sidecars: 'repointing sidecars',
  restore_model: 'restoring provider/model',
  finalize_previous_session: 'closing the previous session',
  token_accounting: 'token accounting',
};

/**
 * Human label for a host stage.
 *
 * Unknown stages fall back to the raw name rather than being dropped: a stage
 * this table has not caught up with is still more informative than silence,
 * and silence is exactly what made a stuck resume undiagnosable.
 */
export function resumeStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage.replaceAll('_', ' ');
}

/** Braille spinner; one frame per tick while the read phase runs. */
export const RESUME_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
/** Spinner cadence. Fast enough to read as motion, slow enough to be free. */
export const RESUME_SPINNER_MS = 120;

/** Rows of stage history kept under the headline. Total block height ≤ 5. */
const LOG_ROWS = 3;
/** Progress-bar width in cells. */
const BAR_CELLS = 22;

export interface ResumeLoadState {
  /** Canonical id of the session being opened. */
  sessionId: string;
  /** Display name (session name, title, or id) shown in the headline. */
  label: string;
  /**
   * Id of the history entry the block is rendered into.
   *
   * Carried explicitly rather than derived from `nextId`: background producers
   * (mailbox notices, fleet chatter) can append entries while the journal is
   * being read, and a positionally-derived id would then rewrite one of THEM
   * with the progress block.
   */
  blockEntryId: number;
  phase: 'reading' | 'replaying';
  loadedBytes: number;
  totalBytes: number;
  /** Stage lines, oldest first. Only the newest {@link LOG_ROWS} are rendered. */
  log: string[];
  /**
   * Entries committed so far, and the total to commit, during `replaying`.
   * Read by the statusline while the transcript streams; the block itself is
   * gone by then.
   */
  replayed: number;
  total: number;
  /** Spinner frame index, advanced by the ticker. */
  frame: number;
}

function bar(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * BAR_CELLS);
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}`;
}

function mib(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Render the loading block as the text of a single history entry.
 *
 * A single entry rather than a bespoke viewport widget on purpose: it lives in
 * the transcript, scrolls with it, and needs no changes to the virtual-scroll
 * anchor accounting — which is measured on every commit and is the one part of
 * the history renderer that must not be perturbed for a progress indicator.
 *
 * At most 5 rows: headline, bar, and the newest {@link LOG_ROWS} stage lines.
 */
export function renderResumeLoadBlock(load: ResumeLoadState): string {
  const spin = RESUME_SPINNER_FRAMES[load.frame % RESUME_SPINNER_FRAMES.length] ?? '⠋';
  const rows: string[] = [`${spin} Resuming "${load.label}"  ·  ${load.sessionId}`];

  // No `replaying` branch: the first streamed batch removes this block, so the
  // transcript scrolling into place IS the indicator from then on. The batch
  // counter goes to the statusline instead, which stays visible while the
  // transcript scrolls past.
  if (load.totalBytes > 0) {
    const pct = Math.round((load.loadedBytes / load.totalBytes) * 100);
    rows.push(
      `  ${bar(load.loadedBytes / load.totalBytes)}  ${pct}%  ·  ${mib(load.loadedBytes)} / ${mib(load.totalBytes)}`,
    );
  } else {
    // No byte total yet (the loader has not reported, or a warm cache reports
    // one completed tick). An indeterminate row keeps the block's height stable
    // so it does not jump by a line the moment the first tick lands.
    rows.push(`  ${bar(0)}  reading…`);
  }

  const tail = load.log.slice(-LOG_ROWS);
  for (const [index, line] of tail.entries()) {
    // Everything but the newest line is finished work.
    const done = index < tail.length - 1;
    rows.push(`  ${done ? '✓' : spin} ${line}`);
  }
  return rows.join('\n');
}

/**
 * Append a stage line, collapsing an immediate repeat.
 *
 * The host can re-report the same stage (a retry, a renewed reservation), and a
 * block whose three visible rows are the same sentence three times tells the
 * user nothing.
 */
export function appendResumeLog(log: readonly string[], line: string): string[] {
  if (log.at(-1) === line) return [...log];
  // Bounded: only the newest rows are ever rendered, and a resume that somehow
  // reports thousands of stages must not grow the entry without limit.
  return [...log, line].slice(-(LOG_ROWS * 4));
}

/** Frames the transcript stream is spread across, whatever its length. */
const STREAM_FRAMES = 36;
/** Smallest batch worth a repaint. */
const MIN_CHUNK = 6;
/** Delay between batches. ~14ms lands near one terminal repaint. */
export const RESUME_STREAM_FRAME_MS = 14;

/**
 * Batch size for streaming `total` entries into the transcript.
 *
 * Scaled by length rather than fixed, so a 740-entry session (what a 131 MB
 * journal replays to) and a 30-entry one both finish in roughly half a second:
 * long enough to read as the transcript scrolling into place, short enough that
 * nobody waits for it.
 */
export function resumeChunkSize(total: number): number {
  return Math.max(MIN_CHUNK, Math.ceil(total / STREAM_FRAMES));
}
