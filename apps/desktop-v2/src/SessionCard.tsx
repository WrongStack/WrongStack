import { ArrowRight, ArrowUpRight, Pin, PinOff, Terminal, Workflow } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import { ageParts, isLive, type Session, sessionStatus } from './model';

export function Metric({
  icon,
  label,
  value,
  note,
  live = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  note: string;
  live?: boolean;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {icon}
        <span>{label}</span>
        {live && <span className="live-label">LIVE</span>}
      </div>
      <strong>
        {value}
        {live && <span className="metric-live-dot" />}
      </strong>
      <p>{note}</p>
    </div>
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
  return (
    <article className={`session-card ${selected ? 'selected' : ''} ${pinned ? 'pinned' : ''}`}>
      {/* Cards sit under their project's heading; the folder stays in the tooltip. */}
      <button
        type="button"
        className="session-card-main"
        title={`${name} · ${s.workdir.replace(/^\\\\\?\\/, '')}`}
        onClick={onOpen}
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
          <h3>{s.title}</h3>
          <span className={`status-pill ${s.status}`}>
            <span className={`status-dot ${s.status}`} />
            {t(`fleetView.status.${sessionStatus(s)}`)}
          </span>
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
          {pinned ? t('fleetView.unpin') : t('fleetView.pin')}
        </button>
        <span className="card-age">{t(`fleetView.age.${ago.unit}`, { n: ago.n })}</span>
        {s.kind === 'agent' && live ? (
          <button type="button" className="card-footer-action" onClick={onLaunch}>
            {t('fleetView.openWorkspace')}
            <ArrowUpRight size={14} />
          </button>
        ) : (
          <button type="button" className="card-footer-action" onClick={onOpen}>
            {live ? t('fleetView.attachSession') : t('fleetView.viewTranscript')}
            <ArrowRight size={14} />
          </button>
        )}
      </footer>
    </article>
  );
}
