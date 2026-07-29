import type { Message } from '@wrongstack/core/types';
import { useEffect, useRef, useState } from 'react';
import type { AppProps } from '../app-props.js';
import { type GitInfo, readGitInfo } from '../git-info.js';

interface GitSessionStatusOptions {
  agent: AppProps['agent'];
  getLiveSessions: AppProps['getLiveSessions'];
  setSessionCount: (count: number) => void;
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

/** Polls repository identity and the live-session count for status surfaces. */
export function useGitSessionStatus({
  agent,
  getLiveSessions,
  setSessionCount,
}: GitSessionStatusOptions): GitInfo | null {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const previousBranchRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      readGitInfo(agent.ctx.cwd)
        .then((info) => {
          if (cancelled) return;
          setGitInfo((previous) => (sameGitInfo(previous, info) ? previous : info));
          if (!info?.branch) return;
          const previous = previousBranchRef.current;
          if (previous !== null && previous !== info.branch) {
            const message: Message = {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `[system] Git branch switched: ⎇ ${previous} → ⎇ ${info.branch}. The working tree is now on branch "${info.branch}". Any file changes from the previous branch are no longer visible.`,
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
          previousBranchRef.current = info.branch;
        })
        .catch(() => {
          if (!cancelled) setGitInfo(null);
        });
    };
    refresh();
    // Git status spawns short-lived child processes. Ten seconds keeps branch
    // changes responsive without paying that process cost twelve times/minute.
    const timer = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agent.ctx]);

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
