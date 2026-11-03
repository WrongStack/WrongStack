import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { entries } from './engine-values';
import { SddTaskDetails } from './SddTaskDetails';

const FEED_WORDS: Record<string, string> = {
  started: 'Started',
  completed: 'Completed',
  failed: 'Failed',
  retrying: 'Retrying',
  wave: 'Wave',
  deadlock: 'Deadlock',
  verification_failed: 'Verification failed',
  conflict: 'Conflict',
  split: 'Split',
  supervisor: 'Supervisor',
  tool: 'Tool',
  file: 'File',
};

function ago(ts: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

/**
 * The board's live "what just happened" ticker, as the WebUI's SDD activity feed: each task
 * pickup, completion, failure, retry, wave and deadlock as a timed line, newest first.
 */
function SddBoardFeed({ board }: { board: Record<string, unknown> }) {
  const feed = entries(board['feed']).filter((item) => typeof item['ts'] === 'number');
  const [now, setNow] = useState(() => Date.now());
  const live = feed.length > 0;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return (
    <section className="sdd-task-history sdd-board-feed" aria-label="Board activity">
      <h4>
        <Activity size={13} /> Board activity
      </h4>
      {feed.length ? (
        feed.map((item, index) => (
          <article key={`${String(item['ts'])}-${index}`}>
            <strong>{FEED_WORDS[String(item['kind'])] ?? String(item['kind'] ?? 'Event')}</strong>
            <span>{ago(item['ts'] as number, now)}</span>
            <p>{typeof item['text'] === 'string' ? item['text'] : 'No details recorded'}</p>
          </article>
        ))
      ) : (
        <p className="sdd-board-feed-empty">
          Task pickups, completions, failures and retries appear here as the run works.
        </p>
      )}
    </section>
  );
}

/** Beside the board's tasks: the selected task's details, or the board's activity feed. */
export function SddBoardDetail({
  task,
  ...props
}: Omit<Parameters<typeof SddTaskDetails>[0], 'task'> & {
  task: Record<string, unknown> | undefined;
}) {
  return task ? (
    <SddTaskDetails
      key={`${String(props.board['runId'])}:${String(task['id'])}`}
      task={task}
      {...props}
    />
  ) : (
    <SddBoardFeed board={props.board} />
  );
}
