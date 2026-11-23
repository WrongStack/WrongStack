import type { Message } from '@wrongstack/contracts/types';
import { type ProjectWatchSubscription, watchProjectTree } from '@wrongstack/core/utils';
import { useEffect, useRef, useState } from 'react';
import type { AppProps } from '../app-props.js';
import type { StatuslineItem } from '../components/statusline-picker.js';
import { type GitInfo, readGitInfo } from '../git-info.js';

interface GitSessionStatusOptions {
  agent: AppProps['agent'];
  getLiveSessions: AppProps['getLiveSessions'];
  setSessionCount: (count: number) => void;
  /**
   * Statusline hidden items. The 10s git poll is the only consumer of
   * `readGitInfo`, which spawns two `git` child processes per tick —
   * when the `git` chip is user-hidden, skip the poll entirely until it
   * is visible again.
   */
  hiddenItems?: readonly StatuslineItem[] | undefined;
}

function sameGitInfo(a: GitInfo | null, b: GitInfo | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.branch === b.branch &&
      a.added === b.added &&
      a.deleted === b.deleted &&
      a.untracked === b.untracked)
  );
}

/**
 * Paths whose changes can never move `readGitInfo`'s answer, so an event on
 * one must not re-arm the poll.
 *
 * Deliberately tiny and conservative. A broader ignore list (core's
 * `DEFAULT_WALK_IGNORE_SET`, say) would swallow `__snapshots__`, `dist`, and
 * `build` — all of which are tracked in some repo somewhere, and a missed
 * event freezes the chip on a stale count. Over-reporting is free: it costs
 * one poll we would have run anyway. Under-reporting is a bug.
 *
 * `.git` is the one directory worth filtering, because fetch/gc churn its
 * objects and refs constantly. Only `HEAD` (branch switch) and `index`
 * (staging, which `diff HEAD` counts) can change the answer.
 */
function gitPollNeedsRefresh(relative: string): boolean {
  const segments = relative.split(/[\\/]/);
  if (segments.includes('node_modules')) return false;
  const dotGit = segments.indexOf('.git');
  if (dotGit === -1) return true;
  const rest = segments.slice(dotGit + 1);
  return rest.length === 1 && (rest[0] === 'HEAD' || rest[0] === 'index');
}

/** Polls repository identity and the live-session count for status surfaces. */
export function useGitSessionStatus({
  agent,
  getLiveSessions,
  setSessionCount,
  hiddenItems = [],
}: GitSessionStatusOptions): GitInfo | null {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const previousBranchRef = useRef<{ branch: string; detached: boolean } | null>(null);

  const gitHidden = hiddenItems.includes('git');
  // `/project` switches in place: it reassigns `agent.ctx.cwd` without a new
  // `ctx` or a remount. Keying the poll on the cwd re-points the watcher, and
  // a branch seen in another repository is no baseline for a "switch".
  const cwd = agent.ctx.cwd;
  const baselineCwdRef = useRef(cwd);

  // Reset the branch baseline when the gate activates: a branch switch that
  // happened while the chip was hidden must not fire a stale notice on re-show.
  useEffect(() => {
    if (gitHidden) previousBranchRef.current = null;
  }, [gitHidden]);

  useEffect(() => {
    // Visibility gate: the git chip is the only consumer of `gitInfo`. When
    // the user hides it via /statusline, skip the poll entirely — no child
    // processes, no branch-switch notices — until it is visible again.
    if (gitHidden) return;
    if (baselineCwdRef.current !== cwd) {
      baselineCwdRef.current = cwd;
      previousBranchRef.current = null;
    }
    let cancelled = false;

    // Change gate. A tick that finds nothing changed still pays two process
    // spawns (~40-80ms each on Windows) to recompute a byte-identical answer,
    // forever, on every idle session. Subscribing to the SHARED recursive
    // project watcher costs no extra OS watcher — core's registry keeps one
    // per root per process and this is an additional subscriber — and tells
    // us exactly when a spawn could produce a different result.
    //
    // Gating on `.git` mtimes instead would be wrong: a working-tree edit
    // never touches `.git/index`, so the +/- counts would go stale. Only a
    // tree watcher covers both working-tree edits and `.git/HEAD` switches.
    //
    // `dirty` starts true so the first tick always paints.
    let dirty = true;
    let watcher: ProjectWatchSubscription | undefined;
    try {
      watcher = watchProjectTree(cwd, ({ filename }) => {
        // A null filename is a watcher-buffer overflow: the OS dropped events
        // and cannot say which. Assume the worst and refresh.
        if (filename === null || gitPollNeedsRefresh(filename)) dirty = true;
      });
    } catch {
      // No recursive watch here (Linux < 22, EPERM on a network share).
      // Degrade to the unconditional poll rather than freezing the chip.
      watcher = undefined;
    }

    const refresh = () => {
      readGitInfo(cwd)
        .then((info) => {
          if (cancelled) return;
          setGitInfo((previous) => (sameGitInfo(previous, info) ? previous : info));
          if (!info?.branch) return;
          const previous = previousBranchRef.current;
          // Detached on both sides is a commit or checkout by SHA (a rebase step), not a
          // branch switch: the short OID moved, no branch did (F1360).
          if (
            previous !== null &&
            previous.branch !== info.branch &&
            !(previous.detached && info.detached)
          ) {
            const message: Message = {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `[system] Git branch switched: ⎇ ${previous.branch} → ⎇ ${info.branch}. The working tree is now on branch "${info.branch}". Any file changes from the previous branch are no longer visible.`,
                },
              ],
            };
            // Via `state`, not `ctx.messages.push`: a direct push bypasses
            // both retention caps and the observer layer, so the notice would
            // be invisible to the session journal and would not count toward
            // the history budget.
            agent.ctx.state.appendMessage(message);
            void import('@wrongstack/core/storage')
              .then(({ getSessionRegistry }) => getSessionRegistry()?.updateAgents([]))
              .catch(() => undefined);
          }
          previousBranchRef.current = { branch: info.branch, detached: info.detached === true };
        })
        .catch(() => {
          if (!cancelled) setGitInfo(null);
        });
    };
    // Clearing `dirty` BEFORE the spawn (not after) means an event that lands
    // while git is still running re-arms the next tick instead of being lost.
    const maybeRefresh = () => {
      if (watcher && !dirty) return;
      dirty = false;
      refresh();
    };

    maybeRefresh();
    // Ten seconds keeps branch changes responsive. With the gate above, an
    // idle repository spawns nothing at all between ticks.
    const timer = setInterval(maybeRefresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      watcher?.close();
    };
    // `gitHidden` must be a dep: toggling the chip in /statusline has to
    // re-run this effect to start (or stop) the poll. Without it the gate
    // is evaluated once on mount and the chip toggle does nothing.
  }, [agent.ctx, cwd, gitHidden]);

  useEffect(() => {
    if (!getLiveSessions) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const sessions = await getLiveSessions();
        if (!cancelled) setSessionCount(sessions.length);
      } catch {
        // Status information is best-effort.
      }
    };
    void poll();
    const timer = setInterval(poll, 30_000);
    timer.unref?.();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [getLiveSessions, setSessionCount]);

  return gitInfo;
}
