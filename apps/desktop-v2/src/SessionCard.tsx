import { ArrowRight, ArrowUpRight, Pin, PinOff, Terminal, Workflow } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import './stat-tiles.css';
import { ageParts, isLive, type Session, sessionStatus, sessionTitle } from './model';

/** A segment of a stat tile's bar: how much of the whole one kind is. */
export interface MetricSegment {
  value: number;
  tone: MetricTone;
  label: string;
}
export type MetricTone = 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'violet' | 'muted';

/**
 * A stat tile: a tinted icon, the number, and one short note. An optional bar splits the whole
 * into its kinds (running, paused, failed…), so the tile shows the shape and not only the sum.
 * With `onOpen` the tile is the way into the page it counts.
 */
export function Metric({
  icon,
  label,
  value,
  note,
  live = false,
  tone = 'accent',
  segments,
  onOpen,
  description,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  note: string;
  live?: boolean;
  tone?: MetricTone;
  segments?: readonly MetricSegment[] | undefined;
  onOpen?: (() => void) | undefined;
  /** What the page it opens is for, as the tile's tooltip. */
  description?: string | undefined;
}) {
  const total = segments?.reduce((sum, segment) => sum + Math.max(0, segment.value), 0) ?? 0;
  const body = (
    <>
      <div className="metric-label">
        <span className="metric-icon" aria-hidden="true">
          {icon}
        </span>
        <span>{label}</span>
      </div>
      <strong>
        {value}
        {live && <span className="metric-live-dot" />}
      </strong>
      {segments && (
        <span
          className="metric-bar"
          role="img"
          aria-label={segments.map((segment) => `${segment.label}: ${segment.value}`).join(', ')}
        >
          {total > 0 &&
            segments
              .filter((segment) => segment.value > 0)
              .map((segment) => (
                <span
                  key={segment.label}
                  className={`tone-${segment.tone}`}
                  style={{ flexGrow: segment.value }}
                  title={`${segment.label}: ${segment.value}`}
                />
              ))}
        </span>
      )}
      <p>{note}</p>
      {onOpen && <ArrowUpRight size={14} className="metric-open" aria-hidden="true" />}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className={`metric metric-link tone-${tone}`}
      title={description}
      onClick={onOpen}
    >
      {body}
    </button>
  ) : (
    <div className={`metric tone-${tone}`}>{body}</div>
  );
}
export function SessionCard({
  session: s,
  name,
  selected,
  pinned = false,
  onOpen,
  onLaunch,
  onTogglePin,
}: {
  session: Session;
  name: string;
  selected: boolean;
  pinned?: boolean;
  onOpen: () => void;
  onLaunch: () => void;
  onTogglePin: () => void;
}) {
  const { t } = useDesktopText();
  const live = isLive(s);
  const ago = ageParts(s.updatedAt);
  const title = sessionTitle(s, t('workbench.untitled'));
  const actionLabel = t(
    s.kind === 'agent' && live
      ? 'fleetView.openWorkspace'
      : live
        ? 'fleetView.attachSession'
        : 'fleetView.viewTranscript',
  );
  return (
    <article className={`session-card ${selected ? 'selected' : ''} ${pinned ? 'pinned' : ''}`}>
      {/* Cards sit under their project's heading; the folder stays in the tooltip. */}
      <button
        type="button"
        className="session-card-main"
        aria-label={`${actionLabel}: ${title}`}
        aria-current={selected ? 'page' : undefined}
        title={`${s.title} · ${name} · ${s.workdir.replace(/^\\\\\?\\/, '')}`}
        onClick={s.kind === 'agent' && live ? onLaunch : onOpen}
      >
        {/* One row: the kind's icon, the title and the state. A kind line above it said
            "WrongStack" on every agent card and "Terminal" over a terminal titled Terminal; the
            icon already tells them apart, and the words stay for assistive technology. */}
        <div className="session-card-title">
          <span className="session-icon">
            {s.kind === 'agent' ? <Workflow size={20} /> : <Terminal size={20} />}
          </span>
          <span className="card-kind">
            {s.kind === 'agent' ? 'WrongStack' : t('fleetView.card.terminal')}
          </span>
          <h3>{title}</h3>
          <span className={`status-pill ${s.status}`}>
            <span className={`status-dot ${s.status}`} />
            {t(`fleetView.status.${sessionStatus(s)}`)}
          </span>
          <ArrowRight className="session-card-open" size={14} aria-hidden="true" />
        </div>
      </button>
      <footer>
        <button
          type="button"
          className={`card-pin ${pinned ? 'is-pinned' : ''}`}
          aria-pressed={pinned}
          title={pinned ? t('fleetView.unpinTitle') : t('fleetView.pinTitle')}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
          <span className="card-pin-label">
            {pinned ? t('fleetView.unpin') : t('fleetView.pin')}
          </span>
        </button>
        <span className="card-age">{t(`fleetView.age.${ago.unit}`, { n: ago.n })}</span>
      </footer>
    </article>
  );
}
