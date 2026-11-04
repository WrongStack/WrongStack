import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
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

/** How long ago, as the catalog key of its unit and the count in that unit. */
function ago(ts: number, now: number): ['secondsAgo' | 'minutesAgo' | 'hoursAgo', number] {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return ['secondsAgo', seconds];
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? ['minutesAgo', minutes] : ['hoursAgo', Math.floor(minutes / 60)];
}

/**
 * The board's live "what just happened" ticker, as the WebUI's SDD activity feed: each task
 * pickup, completion, failure, retry, wave and deadlock as a timed line, newest first.
 */
function SddBoardFeed({ board }: { board: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const feed = entries(board['feed']).filter((item) => typeof item['ts'] === 'number');
  const [now, setNow] = useState(() => Date.now());
  const live = feed.length > 0;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [live]);
  return (
    <section className="sdd-task-history sdd-board-feed" aria-label={t('sddView.feed.label')}>
      <h4>
        <Activity size={13} /> {t('sddView.feed.label')}
      </h4>
      {feed.length ? (
        feed.map((item, index) => {
          const kind = String(item['kind'] ?? '');
          const [unit, count] = ago(item['ts'] as number, now);
          return (
            <article key={`${String(item['ts'])}-${index}`}>
              <strong>
                {kind
                  ? t(`sddView.feed.kind.${kind}`, { defaultValue: FEED_WORDS[kind] ?? kind })
                  : t('sddView.feed.event')}
              </strong>
              <span>{t(`sddView.feed.${unit}`, { n: count })}</span>
              <p>{typeof item['text'] === 'string' ? item['text'] : t('sddView.feed.noDetails')}</p>
            </article>
          );
        })
      ) : (
        <p className="sdd-board-feed-empty">{t('sddView.feed.empty')}</p>
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
