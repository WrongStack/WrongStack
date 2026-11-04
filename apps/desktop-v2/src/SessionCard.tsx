import { ArrowRight, ArrowUpRight, Pin, PinOff, Terminal, Workflow } from 'lucide-react';
import { age, isLive, type Session, statusLabel } from './model';

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
  const live = isLive(s);
  return (
    <article className={`session-card ${selected ? 'selected' : ''} ${pinned ? 'pinned' : ''}`}>
      {/* Cards sit under their project's heading; the folder stays in the tooltip. */}
      <button
        type="button"
        className="session-card-main"
        title={`${name} · ${s.workdir.replace(/^\\\\\?\\/, '')}`}
        onClick={onOpen}
      >
        <div className="card-top">
          <span className="card-kind">{s.kind === 'agent' ? 'WrongStack' : 'Terminal'}</span>
          <span className={`status-pill ${s.status}`}>
            <span className={`status-dot ${s.status}`} />
            {statusLabel(s)}
          </span>
        </div>
        <div className="session-card-title">
          <span className="session-icon">
            {s.kind === 'agent' ? <Workflow size={20} /> : <Terminal size={20} />}
          </span>
          <h3>{s.title}</h3>
        </div>
      </button>
      <footer>
        <button
          type="button"
          className={`card-pin ${pinned ? 'is-pinned' : ''}`}
          aria-pressed={pinned}
          title={pinned ? 'Unpin this session' : 'Pin this session to the top'}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
          {pinned ? 'Unpin' : 'Pin'}
        </button>
        <span className="card-age">{age(s.updatedAt)}</span>
        {s.kind === 'agent' && live ? (
          <button type="button" className="card-footer-action" onClick={onLaunch}>
            Open workspace
            <ArrowUpRight size={14} />
          </button>
        ) : (
          <button type="button" className="card-footer-action" onClick={onOpen}>
            {isLive(s) ? 'Attach session' : 'View transcript'}
            <ArrowRight size={14} />
          </button>
        )}
      </footer>
    </article>
  );
}
