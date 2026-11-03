import { GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';

interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
  added: number;
  deleted: number;
  untracked: number;
}

const count = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0);

/** The engine's `git.info` reply, or null outside a repository (no branch). */
function gitInfo(reply: Record<string, unknown>): GitInfo | null {
  const branch = typeof reply['branch'] === 'string' ? reply['branch'] : '';
  if (!branch) return null;
  return {
    branch,
    ahead: count(reply['ahead']),
    behind: count(reply['behind']),
    added: count(reply['added']),
    deleted: count(reply['deleted']),
    untracked: count(reply['untracked']),
  };
}

/** The repository line of the WebUI's dock: branch, commits ahead/behind, changed lines, new files. */
function GitSummary({ info }: { info: GitInfo }) {
  return (
    <span className="git-chip" title={`Branch ${info.branch}`}>
      <GitBranch size={11} />
      <strong>{info.branch}</strong>
      {info.ahead > 0 && <span title={`${info.ahead} commits ahead`}>↑{info.ahead}</span>}
      {info.behind > 0 && <span title={`${info.behind} commits behind`}>↓{info.behind}</span>}
      {info.added > 0 && (
        <span className="git-added" title={`${info.added} lines added`}>
          +{info.added}
        </span>
      )}
      {info.deleted > 0 && (
        <span className="git-deleted" title={`${info.deleted} lines deleted`}>
          −{info.deleted}
        </span>
      )}
      {info.untracked > 0 && (
        <span title={`${info.untracked} untracked files`}>{info.untracked}?</span>
      )}
    </span>
  );
}

/**
 * Reads the conversation's repository state now and then every minute while the window is
 * visible. The WebUI polls every 30 seconds; here every reply is also written to the
 * conversation's journal, so the desktop asks half as often and not while hidden.
 */
export function GitChip({ command, connected }: { command: EngineCommand; connected: boolean }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const read = () =>
      void command('git.info', {}, ['git.info']).then(
        (reply) => live && setInfo(gitInfo(reply)),
        () => {
          // A failed read keeps the last known state; the next poll tries again.
        },
      );
    read();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') read();
    }, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [command, connected]);
  return info ? <GitSummary info={info} /> : null;
}
