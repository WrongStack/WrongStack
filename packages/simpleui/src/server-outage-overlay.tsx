import { WifiOff } from 'lucide-react';
import { useRef } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import type { OutageKind } from './lib/server-health.js';

export interface ServerOutageOverlayProps {
  outage: OutageKind;
  onDismiss: () => void;
}

/**
 * Full-page banner shown when the server has been unreachable for longer
 * than the grace window. Distinguishes "nothing listens on this port"
 * (stopped instance, or a restart that auto-advanced to another port) from
 * "HTTP answers but the WebSocket keeps failing" (proxy / extension
 * interference) — the two cases need different user action, and the tiny
 * OFF dot in the top bar communicates neither.
 */
export function ServerOutageOverlay({ outage, onDismiss }: ServerOutageOverlayProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, outage !== 'none');
  if (outage === 'none') return null;
  const host = window.location.host;
  return (
    <div
      className="outage-overlay"
      role="alertdialog"
      aria-labelledby="outage-title"
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="outage-card">
        <div className="outage-icon">
          <WifiOff size={28} aria-hidden="true" />
        </div>
        {outage === 'server-gone' ? (
          <>
            <h2 id="outage-title">SimpleUI server is not reachable</h2>
            <p>
              Nothing is answering at <code>{host}</code>. The server was probably stopped — or it
              was relaunched while this port was busy, in which case it auto-advanced to the next
              free port and printed the new URL in its terminal banner.
            </p>
            <p className="outage-hint">
              Check the terminal that runs SimpleUI for the current address, then reload this page.
            </p>
          </>
        ) : (
          <>
            <h2 id="outage-title">WebSocket connection is failing</h2>
            <p>
              The server at <code>{host}</code> answers over HTTP, but the WebSocket connection
              keeps dropping. A proxy setting or browser extension may be blocking{' '}
              <code>ws://</code> traffic to this host.
            </p>
          </>
        )}
        <p className="outage-status">Retrying automatically…</p>
        <div className="outage-actions">
          <button type="button" className="outage-reload" onClick={() => window.location.reload()}>
            Reload page
          </button>
          <button type="button" className="outage-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
