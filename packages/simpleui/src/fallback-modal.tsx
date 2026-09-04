/**
 * Fallback modal for SimpleUI — shown when `provider.fallback_pending` fires.
 *
 * Displays the failed model, a candidate list with a live countdown,
 * and lets the user manually pick or wait for auto-switch. Always renders
 * on top regardless of what panel is active.
 */
import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import type { ServerMessage } from './types.js';

export interface FallbackCandidate {
  providerId: string;
  model: string;
}

export interface FallbackPendingInfo {
  requestId: string;
  from: { providerId: string; model: string };
  status: number;
  candidates: FallbackCandidate[];
  autoSwitchSeconds: number;
}

/**
 * Shared projection shape — used by the `useState<FallbackPendingProjection | null>`
 * site in `simple-ui-session.tsx`, the `setFallbackPending` prop type in
 * `lib/message-handler.ts`, and the `projectFallbackPending` return type
 * below. Single source of truth so a server-side field addition lands
 * in exactly one place.
 */
export type FallbackPendingProjection = FallbackPendingInfo;

export interface FallbackModalProps {
  info: FallbackPendingInfo | null;
  socketRef: {
    current: { send: (type: string, payload?: Record<string, unknown>) => void } | null;
  };
  onClose: () => void;
}

export function FallbackModal({ info, socketRef, onClose }: FallbackModalProps) {
  // Initialize from the first pending info: starting at 0 would make the
  // auto-resolve effect fire on the mount commit (before the reset's
  // setState lands), instantly auto-picking a candidate and never showing
  // the countdown.
  const [remaining, setRemaining] = useState(() =>
    info ? Math.max(1, info.autoSwitchSeconds) : 0,
  );
  const [selected, setSelected] = useState(0);
  // This component stays mounted for the whole app lifetime (info=null until
  // a frame arrives), so the initializer alone cannot cover later rounds.
  // A new pending round is folded in DURING RENDER (React's adjust-state-on-
  // prop-change pattern): effects for the new round — above all the
  // auto-resolve guard — then observe the fresh countdown, never a stale
  // expired `remaining` from the previous round.
  const [initRequestId, setInitRequestId] = useState<string | null>(info?.requestId ?? null);
  if ((info?.requestId ?? null) !== initRequestId) {
    setInitRequestId(info?.requestId ?? null);
    setSelected(0);
    setRemaining(info ? Math.max(1, info.autoSwitchSeconds) : 0);
  }
  const resolvedRef = useRef(false);
  const selectedRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Countdown. Keyed on the round — a new requestId restarts the interval.
  useEffect(() => {
    if (!info) return;
    resolvedRef.current = false;
    const id = setInterval(() => {
      setRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.requestId]);

  // Auto-resolve on countdown expiration.
  useEffect(() => {
    if (!info || remaining > 0 || resolvedRef.current) return;
    resolvedRef.current = true;
    const chosen = info.candidates[selectedRef.current] ?? null;
    sendChoice(socketRef, info.requestId, chosen);
    onClose();
  }, [remaining, info, socketRef, onClose]);

  // Keyboard navigation.
  useEffect(() => {
    if (!info) return;
    const onKey = (e: KeyboardEvent) => {
      if (resolvedRef.current) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => Math.min(info.candidates.length - 1, s + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolvedRef.current = true;
        const chosen = info.candidates[selectedRef.current] ?? null;
        sendChoice(socketRef, info.requestId, chosen);
        onClose();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        resolvedRef.current = true;
        sendChoice(socketRef, info.requestId, null);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.requestId]);

  if (!info) return null;

  const fromLabel = `${info.from.providerId}/${info.from.model}`;

  return (
    <div
      className="fallback-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Model fallback"
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="fallback-modal">
        <div className="fallback-modal-header">
          <span className="fallback-modal-title">
            <TriangleAlert size={13} aria-hidden="true" /> MODEL FALLBACK
          </span>
          <span className="fallback-modal-countdown">{remaining}s</span>
        </div>
        <p className="fallback-modal-from">
          <span className="mono">{fromLabel}</span> returned{' '}
          <span className="mono">{info.status}</span>
        </p>
        <p className="fallback-modal-hint">
          Select a fallback model (↑/↓ to move, Enter to pick, Esc for auto):
        </p>
        <div className="fallback-modal-list">
          {info.candidates.map((c, i) => {
            const isSel = i === selected;
            return (
              <button
                key={`sui-fb-${i}`}
                type="button"
                className={`fallback-modal-item ${isSel ? 'selected' : ''}`}
                onClick={() => {
                  if (resolvedRef.current) return;
                  resolvedRef.current = true;
                  sendChoice(socketRef, info.requestId, c);
                  onClose();
                }}
                onMouseEnter={() => setSelected(i)}
              >
                <span className="fallback-modal-marker">{isSel ? '▸' : '\u00a0'}</span>
                <span className="mono">
                  {c.providerId}/{c.model}
                </span>
              </button>
            );
          })}
        </div>
        <p className="fallback-modal-footer">
          Enter picks · Esc auto-switches · countdown picks highlighted entry
        </p>
      </div>
    </div>
  );
}

function sendChoice(
  socketRef: {
    current: { send: (type: string, payload?: Record<string, unknown>) => void } | null;
  },
  requestId: string,
  choice: { providerId: string; model: string } | null,
) {
  try {
    if (choice) {
      socketRef.current?.send('model.fallback_choice', {
        requestId,
        providerId: choice.providerId,
        model: choice.model,
      });
    } else {
      socketRef.current?.send('model.fallback_choice', {
        requestId,
        autoSwitch: true,
      });
    }
  } catch {
    // Best-effort — the countdown will auto-switch anyway.
  }
}

/**
 * Project a `provider.fallback_pending` server message into a
 * `FallbackPendingInfo` for the modal.
 */
export function projectFallbackPending(msg: ServerMessage): FallbackPendingInfo | null {
  const payload = msg.payload ?? {};
  const from =
    payload['from'] && typeof payload['from'] === 'object'
      ? (payload['from'] as Record<string, unknown>)
      : {};
  const candidates = Array.isArray(payload['candidates'])
    ? payload['candidates'].flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const item = entry as Record<string, unknown>;
        if (typeof item['providerId'] !== 'string' || typeof item['model'] !== 'string') return [];
        return [{ providerId: item['providerId'], model: item['model'] }];
      })
    : [];
  const requestId = typeof payload['requestId'] === 'string' ? payload['requestId'] : '';
  if (!requestId) return null;
  return {
    requestId,
    from: {
      providerId: typeof from['providerId'] === 'string' ? from['providerId'] : '',
      model: typeof from['model'] === 'string' ? from['model'] : '',
    },
    status: typeof payload['status'] === 'number' ? payload['status'] : 0,
    candidates,
    autoSwitchSeconds:
      typeof payload['autoSwitchSeconds'] === 'number' ? payload['autoSwitchSeconds'] : 7,
  };
}
