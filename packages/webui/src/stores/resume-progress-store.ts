/**
 * resume-progress-store.ts — which tabs are waiting for a transcript.
 *
 * A resume is not instant. The server has to replay the session's whole JSONL
 * journal before it can answer, and a journal that has grown to a hundred-odd
 * megabytes takes seconds on an idle machine and tens of seconds on one that
 * is also running agents. Until this store existed the surface said nothing
 * about that: the tab appeared immediately (the client opens the slot before
 * asking), the lane was empty, and an empty lane renders the welcome screen —
 * so a resume in progress was pixel-identical to a session with no messages in
 * it. The honest reading of that screen is "the transcript is gone", which is
 * what it was reported as.
 *
 * Deliberately NOT part of the chat lane. Lanes are persisted to localStorage,
 * and a "waiting" flag must not survive the reload that ended the wait — a
 * page that came back with a stale flag would spin forever. This is in-memory,
 * per-session, and every exit is covered: the `session.start` that answers,
 * the error frame that refuses, and a wall-clock ceiling for the answer that
 * never comes at all.
 */

import { create } from 'zustand';

/**
 * Upper bound on a single wait, after which the tab stops claiming to be
 * loading and falls back to whatever the lane holds.
 *
 * Generous on purpose: the point of the ceiling is that a dropped frame cannot
 * strand the pane forever, not to guess how long a resume "should" take.
 * Cutting a genuinely slow resume short would put the welcome screen back
 * under a user who is about to be handed their transcript.
 */
export const RESUME_PROGRESS_TIMEOUT_MS = 5 * 60_000;

export interface ResumeProgressDetail {
  stage: string;
  loadedBytes: number;
  totalBytes: number;
  updatedAt: number;
}

interface ResumeProgressState {
  /** sessionId -> ms epoch the resume request went out. */
  startedAt: Record<string, number>;
  /** sessionId -> latest server-reported journal load progress. */
  progress: Record<string, ResumeProgressDetail>;
  /** A resume request for this session is on the wire. */
  begin: (sessionId: string) => void;
  /** Update the visible progress for an in-flight resume. */
  update: (sessionId: string, progress: Omit<ResumeProgressDetail, 'updatedAt'>) => void;
  /** Its answer (or refusal) arrived. Safe to call for sessions never begun. */
  end: (sessionId: string) => void;
  /** Socket-level reset: nothing outstanding can still be answered. */
  clear: () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelTimer(sessionId: string): void {
  const handle = timers.get(sessionId);
  if (handle === undefined) return;
  clearTimeout(handle);
  timers.delete(sessionId);
}

export const useResumeProgressStore = create<ResumeProgressState>()((set) => ({
  startedAt: {},
  progress: {},

  begin: (sessionId) => {
    if (!sessionId) return;
    cancelTimer(sessionId);
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId);
        useResumeProgressStore.getState().end(sessionId);
      }, RESUME_PROGRESS_TIMEOUT_MS),
    );
    set((s) => ({ startedAt: { ...s.startedAt, [sessionId]: Date.now() } }));
  },

  update: (sessionId, progress) => {
    if (!sessionId) return;
    set((s) => ({
      progress: {
        ...s.progress,
        [sessionId]: {
          ...progress,
          loadedBytes: Math.max(0, progress.loadedBytes),
          totalBytes: Math.max(0, progress.totalBytes),
          updatedAt: Date.now(),
        },
      },
    }));
  },

  end: (sessionId) => {
    if (!sessionId) return;
    cancelTimer(sessionId);
    set((s) => {
      if (!(sessionId in s.startedAt) && !(sessionId in s.progress)) return s;
      const { [sessionId]: _done, ...rest } = s.startedAt;
      const { [sessionId]: _progress, ...remainingProgress } = s.progress;
      return { startedAt: rest, progress: remainingProgress };
    });
  },

  clear: () => {
    for (const sessionId of [...timers.keys()]) cancelTimer(sessionId);
    set({ startedAt: {}, progress: {} });
  },
}));

const STAGE_LABELS: Readonly<Record<string, string>> = {
  start: 'Starting',
  resolve_id: 'Resolving session id',
  reserve_ownership: 'Reserving ownership',
  open_journal: 'Reading journal',
  activate_ownership: 'Taking ownership',
  replay_history: 'Rebuilding timeline',
  read_sidecars: 'Reading todos and sidecars',
  swap_writer: 'Attaching session',
  flush_journal: 'Flushing journal',
  repoint_sidecars: 'Repointing sidecars',
  restore_model: 'Restoring provider and model',
  finalize_previous_session: 'Closing previous session',
  token_accounting: 'Restoring token accounting',
  complete: 'Finalizing',
};

export function resumeStageLabel(stage: string | undefined): string {
  if (!stage) return 'Reading journal';
  return STAGE_LABELS[stage] ?? stage.replaceAll('_', ' ');
}

export function resumeProgressPercent(progress: ResumeProgressDetail | undefined): number | null {
  if (!progress || progress.totalBytes <= 0) return null;
  const pct = Math.round((progress.loadedBytes / progress.totalBytes) * 100);
  return Math.max(0, Math.min(100, pct));
}

export function formatResumeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Selector-friendly read: is this tab still waiting for its transcript? */
export function isResuming(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return useResumeProgressStore.getState().startedAt[sessionId] !== undefined;
}
