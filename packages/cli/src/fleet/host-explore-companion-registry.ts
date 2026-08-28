/**
 * One ExploreCompanion per live conversation.
 *
 * `MultiAgentHost` is built once, for the session the process booted with, and
 * the companion was built with it. That is exactly right for the CLI and the
 * TUI, which have one conversation. The WebUI runs up to four on the same host:
 * the companion filters every signal against its own `leaderSessionId`
 * (fail-closed, so nothing ever leaked into the wrong tab) and therefore simply
 * did nothing for tabs 2-4 — no probes, no findings, silently.
 *
 * A companion is cheap (two or three event listeners, plus one poll timer when
 * the mailbox-ask signal is on) and its resident worker is spawned lazily on
 * the first probe, so a tab that never triggers one pays nothing. What is not
 * free is keeping companions for conversations that are gone: a closed tab
 * would leave its poll timer running. Hence the two bounds below.
 *
 * Bounds, both mirroring conventions already in the codebase:
 *   - `max` live companions (4 — the WebUI's tab-slot count), least-recently
 *     active evicted first, the way `auto-submit-streak` bounds its per-session
 *     map;
 *   - companions with no run for `idleMs` are swept, the way BrainMonitor
 *     prunes its idle `bySession` entries.
 *
 * Neither bound loses work: a swept session gets a fresh companion on its next
 * run, and probe cooldowns are per-companion advisory state, not results.
 *
 * @module host-explore-companion-registry
 */

import type { ExploreCompanion } from '@wrongstack/core/coordination';

/** Four live conversations is the WebUI's tab-slot ceiling. */
const DEFAULT_MAX_COMPANIONS = 4;
/** A conversation with no run for this long is not being worked on. */
const DEFAULT_IDLE_MS = 15 * 60_000;

interface ExploreCompanionRegistryInput {
  /**
   * Build a companion for one session. Returns null when the feature is off
   * for this host, in which case the registry stays permanently empty and
   * `ensure` is a no-op — no negative caching needed, the builder is cheap and
   * its own `enabled === false` check is the authority.
   */
  create: (sessionId: string) => ExploreCompanion | null;
  max?: number | undefined;
  idleMs?: number | undefined;
  now?: (() => number) | undefined;
}

export interface ExploreCompanionRegistry {
  /**
   * Make sure this session has a companion, and mark it active.
   *
   * Safe to call on every run start: an existing entry is only touched.
   */
  ensure: (sessionId: string) => void;
  /** Live companion for a session, for tests and status surfaces. */
  peek: (sessionId: string) => ExploreCompanion | undefined;
  /** Session ids holding a live companion, most recently active last. */
  ids: () => string[];
  /** Stop and forget one session's companion. */
  release: (sessionId: string) => void;
  /** Stop and forget everything — host teardown. */
  disposeAll: () => void;
}

export function createExploreCompanionRegistry(
  input: ExploreCompanionRegistryInput,
): ExploreCompanionRegistry {
  const max = Math.max(1, input.max ?? DEFAULT_MAX_COMPANIONS);
  const idleMs = input.idleMs ?? DEFAULT_IDLE_MS;
  const now = input.now ?? Date.now;
  /** Insertion order IS recency: `touch` deletes and re-sets. */
  const live = new Map<string, { companion: ExploreCompanion; lastActiveAt: number }>();

  const stop = (sessionId: string): void => {
    const entry = live.get(sessionId);
    if (!entry) return;
    live.delete(sessionId);
    try {
      entry.companion.stop();
    } catch {
      // Teardown of a background helper must never surface to the fleet.
    }
  };

  const sweepIdle = (keep: string): void => {
    const cutoff = now() - idleMs;
    for (const [sessionId, entry] of [...live]) {
      if (sessionId === keep) continue;
      if (entry.lastActiveAt > cutoff) continue;
      stop(sessionId);
    }
  };

  const evictOldest = (keep: string): void => {
    for (const sessionId of live.keys()) {
      if (sessionId === keep) continue;
      stop(sessionId);
      return;
    }
  };

  return {
    ensure(sessionId: string): void {
      if (!sessionId) return;
      const existing = live.get(sessionId);
      if (existing) {
        // Re-set to move to the end: this session is the most recently active.
        live.delete(sessionId);
        existing.lastActiveAt = now();
        live.set(sessionId, existing);
        return;
      }
      sweepIdle(sessionId);
      while (live.size >= max) {
        const before = live.size;
        evictOldest(sessionId);
        // Nothing evictable (every entry is `keep`, which cannot happen since
        // `keep` is absent here) — refuse rather than spin.
        if (live.size === before) return;
      }
      const companion = input.create(sessionId);
      if (!companion) return;
      live.set(sessionId, { companion, lastActiveAt: now() });
    },
    peek: (sessionId) => live.get(sessionId)?.companion,
    ids: () => [...live.keys()],
    release: stop,
    disposeAll(): void {
      for (const sessionId of [...live.keys()]) stop(sessionId);
    },
  };
}
