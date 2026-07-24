/**
 * Toast notification overlay — fixed-position stack that renders transient
 * error/warning/info/success messages from the toast store.
 *
 * Rendered as a React portal at the app shell level so it overlays all views
 * without any view having to mount it.
 */

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type React from 'react';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useToastStore, type ToastSeverity } from './toast-store.js';

const ICON_MAP: Record<ToastSeverity, React.ReactNode> = {
  error: <XCircle size={16} aria-hidden="true" />,
  warning: <AlertTriangle size={16} aria-hidden="true" />,
  info: <Info size={16} aria-hidden="true" />,
  success: <CheckCircle2 size={16} aria-hidden="true" />,
};

export function ToastOverlay(): React.ReactElement {
  const { toasts, removeToast } = useToastStore(
    useShallow((s) => ({ toasts: s.toasts, removeToast: s.removeToast })),
  );

  if (toasts.length === 0) return <></>;

  return (
    <div className="hq-toast-container" role="status" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`hq-toast hq-toast--${toast.severity}`}
          data-severity={toast.severity}
        >
          <span className="hq-toast-icon">{ICON_MAP[toast.severity]}</span>
          <span className="hq-toast-message">{toast.message}</span>
          {toast.action ? <span className="hq-toast-action">{toast.action}</span> : null}
          <button
            type="button"
            className="hq-toast-close"
            aria-label="Dismiss notification"
            onClick={() => removeToast(toast.id)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
