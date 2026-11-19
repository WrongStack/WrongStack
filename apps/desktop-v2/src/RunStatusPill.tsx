import { useEffect, useState } from 'react';
import './chat-chrome.css';

/** "42 s", "12 min", "1 h 05 min": how long the turn has been running, at a glance. */
function elapsedShort(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/**
 * The conversation's state as a small pill: a dot in its colour (pulsing while it works), the
 * state, and, while a turn runs and its start is known, how long it has been running.
 */
export function RunStatusPill({
  tone,
  label,
  since,
}: {
  tone: 'working' | 'waiting' | 'ready' | 'stopped' | 'connecting';
  label: string;
  /** When the running turn started; null when unknown or not running. */
  since: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return (
    <span className={`run-status-pill ${tone}`}>
      <i aria-hidden="true" />
      {label}
      {since !== null ? <small> · {elapsedShort(now - since)}</small> : null}
    </span>
  );
}
