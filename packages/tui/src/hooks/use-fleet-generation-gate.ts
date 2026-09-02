import { useCallback, useMemo, useRef } from 'react';

/**
 * Session-generation gate for fleet event bridges.
 *
 * Fleet event bridges must discard events from subagents that were spawned
 * before the last `/clear`. This shared hook encapsulates that logic so any
 * bridge can apply it consistently. Currently consumed by
 * `useDirectorFleetBridge` (Director FleetBus streaming); `useSubagentEvents`
 * (EventBus lifecycle) does not gate on generation today.
 *
 * Usage:
 * ```ts
 * const gate = useFleetGenerationGate(sessionGenerationRef);
 * // On subagent spawn / first-seen:
 * gate.track(id);
 * // Before processing any event:
 * if (!gate.isLive(id)) return;
 * // On subagent removal:
 * gate.forget(id);
 * ```
 *
 * When `sessionGenerationRef` is absent (no /clear support wired), `isLive`
 * always returns `true` — backward-compatible no-op.
 */
interface FleetGenerationGate {
  /** Record that a subagent was first seen at the current generation.
   *  Call on spawn or first event. No-op when no sessionGenerationRef. */
  track: (subagentId: string) => void;
  /** Returns true if the subagent's events should be processed.
   *  Returns false after /clear bumps the generation. */
  isLive: (subagentId: string) => boolean;
  /** Clean up tracking for a removed subagent. */
  forget: (subagentId: string) => void;
  /** Drop tracking entries older than the previous generation (bounds the map). */
  sweep: () => void;
}

export function useFleetGenerationGate(
  sessionGenerationRef?: { current: number } | undefined,
): FleetGenerationGate {
  const spawnGenRef = useRef<Map<string, number>>(new Map());
  const sweptGenRef = useRef<number | undefined>(undefined);

  // Bound the spawn-generation map. Without this it grows one entry per subagent
  // for the whole session: `forget()` only fires on `subagent.removed`, so any
  // agent alive across a /clear (or whose removal event is gated out) leaks its
  // entry forever. We keep the current AND immediately-previous generation so
  // `isLive()` can still gate out just-cleared agents by their stale gen; entries
  // two-or-more generations old belong to long-dead agents and are dropped.
  const sweep = useCallback((): void => {
    if (!sessionGenerationRef) return;
    const cur = sessionGenerationRef.current;
    if (sweptGenRef.current === cur) return; // already swept for this generation
    sweptGenRef.current = cur;
    for (const [id, gen] of spawnGenRef.current) {
      if (gen < cur - 1) spawnGenRef.current.delete(id);
    }
  }, [sessionGenerationRef]);

  const track = useCallback(
    (subagentId: string): void => {
      if (sessionGenerationRef) {
        sweep();
        spawnGenRef.current.set(subagentId, sessionGenerationRef.current);
      }
    },
    [sessionGenerationRef, sweep],
  );

  const isLive = useCallback(
    (subagentId: string): boolean => {
      if (!sessionGenerationRef) return true;
      const gen = spawnGenRef.current.get(subagentId);
      if (gen === undefined) return true; // unknown agent — allow
      return gen === sessionGenerationRef.current;
    },
    [sessionGenerationRef],
  );

  const forget = useCallback((subagentId: string): void => {
    spawnGenRef.current.delete(subagentId);
  }, []);

  // Consumers use this object in effect dependency lists. Keep the container
  // stable as well as its callbacks; a fresh object here would tear down and
  // recreate the fleet bridge after every unrelated TUI render.
  return useMemo(() => ({ track, isLive, forget, sweep }), [track, isLive, forget, sweep]);
}
