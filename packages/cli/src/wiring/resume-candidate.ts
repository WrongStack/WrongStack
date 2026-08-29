/**
 * Which session should `--resume` (no id) or `--recover` reopen?
 *
 * Two questions, one answer shape:
 *
 *   `--resume`   the most recent session in this project, however it ended.
 *   `--recover`  the most recent session whose journal has NO trailing
 *                `session_end` — the one a crash, a `kill`, or a closed
 *                terminal left hanging. This is what "recovery" means to a
 *                user: bring back the conversation that never got to finish.
 *
 * Both must skip sessions another live process is still writing to. Resuming
 * one opens a SECOND writer on the same JSONL: two append streams, two
 * `.summary.json` sidecars, and a transcript that interleaves two runtimes.
 * The cross-process {@link SessionRegistry} is the only thing that knows, so
 * the filter goes through it rather than a PID heuristic.
 *
 * Everything here is best-effort. A pick that comes back empty means "start a
 * new session", never an error: a boot that refuses to start because a scan
 * failed is worse than a boot that starts fresh.
 */
import { getSessionRegistry, SessionRecovery } from '@wrongstack/core/storage';
import type { SessionStore } from '@wrongstack/core/types';

/** How many unclosed candidates to examine before giving up on a free one. */
const MAX_CANDIDATES = 20;

export interface PickResumeCandidateOptions {
  /** `wpaths.projectSessions` — where this project's transcripts live. */
  sessionsDir: string;
  /** `wpaths.globalRoot` — the registry of sessions live in other processes. */
  globalRoot: string;
  sessionStore: Pick<SessionStore, 'list'>;
  /** true for `--recover` (unclosed only), false for a bare `--resume`. */
  unclosedOnly: boolean;
}

export async function pickResumeCandidate(
  options: PickResumeCandidateOptions,
): Promise<string | undefined> {
  const live = await liveSessionIds(options.globalRoot);
  const candidates = options.unclosedOnly
    ? await unclosedCandidates(options.sessionsDir)
    : await recentCandidates(options.sessionStore);
  for (const id of candidates) {
    if (!live.has(id)) return id;
  }
  return undefined;
}

async function unclosedCandidates(sessionsDir: string): Promise<string[]> {
  const recovery = new SessionRecovery(sessionsDir);
  const unclosed = await recovery.listUnclosed({ limit: MAX_CANDIDATES });
  return unclosed.map((entry) => entry.sessionId);
}

async function recentCandidates(sessionStore: Pick<SessionStore, 'list'>): Promise<string[]> {
  const list = await sessionStore.list(MAX_CANDIDATES);
  // `list` is newest-first, but it also reports sessions with nothing in them
  // (a launch that got a writer and no prompt). Resuming one of those looks
  // identical to starting fresh while costing a claim and a transcript read.
  return list.filter((summary) => (summary.messageCount ?? 0) > 0).map((summary) => summary.id);
}

async function liveSessionIds(globalRoot: string): Promise<Set<string>> {
  try {
    const registry = getSessionRegistry(globalRoot);
    const entries = await registry.list();
    return new Set(entries.map((entry) => entry.sessionId));
  } catch {
    // No registry (headless embedder, unreadable global root): fall back to
    // "nothing is live". The resume itself still goes through `claimSession`,
    // which refuses a session another process holds.
    return new Set();
  }
}

/** A hung session older than this is history, not something to interrupt for. */
const HINT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface AnnounceRecoverableOptions {
  sessionsDir: string;
  globalRoot: string;
  onHint: (message: string) => void;
}

/**
 * Mention the most recent unclosed session, once, at boot.
 *
 * A crash used to be indistinguishable from a normal start: the transcript sat
 * on disk and nothing ever said so, so the user retyped work that was already
 * recorded. This says it — and only says it. It never prompts, never blocks the
 * boot, and never resumes anything on its own, because a launch that stops to
 * ask a question is worse than one that starts fresh.
 */
export async function announceRecoverableSession(
  options: AnnounceRecoverableOptions,
): Promise<void> {
  const recovery = new SessionRecovery(options.sessionsDir);
  const unclosed = await recovery.listUnclosed({ limit: MAX_CANDIDATES });
  if (unclosed.length === 0) return;
  const live = await liveSessionIds(options.globalRoot);
  const candidate = unclosed.find(
    (entry) => !live.has(entry.sessionId) && Date.now() - entry.modifiedAt <= HINT_MAX_AGE_MS,
  );
  if (!candidate) return;
  const how = candidate.stale ? 'mid-iteration' : 'between turns';
  options.onHint(
    `Session ${candidate.sessionId} never closed its log (stopped ${how}). ` +
      `Reopen it with \`wstack --recover\`.`,
  );
}
