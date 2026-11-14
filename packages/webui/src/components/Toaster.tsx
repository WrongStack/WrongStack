import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  ACTION_TTL_MS,
  type ToastAction,
  type ToastEntry,
  type ToastVariant,
  toast,
  useNotificationStore,
  useToastStore,
} from '@/stores/notification-store';

export type { ToastAction, ToastEntry, ToastVariant };
export { ACTION_TTL_MS, toast, useToastStore };

function Icon({ variant }: { variant: ToastVariant }) {
  if (variant === 'success') return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (variant === 'error') return <XCircle className="h-4 w-4 text-destructive" />;
  if (variant === 'warn') return <AlertTriangle className="h-4 w-4 text-warning" />;
  return <Info className="h-4 w-4 text-info" />;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

function ToastItem({ entry }: { entry: ToastEntry }) {
  const { t } = useAppTranslation();
  const dismissToast = useNotificationStore((s) => s.dismissToast);
  useEffect(() => {
    if (!Number.isFinite(entry.ttl) || entry.ttl <= 0) return;
    let remainingMs = entry.ttl;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const chunk = Math.min(remainingMs, MAX_TIMEOUT_MS);
      remainingMs -= chunk;
      timer = setTimeout(() => {
        if (cancelled) return;
        if (remainingMs > 0) {
          schedule();
          return;
        }
        dismissToast(entry.id);
      }, chunk);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [entry.id, entry.ttl, dismissToast]);

  return (
    <div
      data-variant={entry.variant}
      className={cn(
        'ws-toast flex items-start gap-2 border text-sm',
        entry.variant === 'error' && 'border-destructive/40',
        entry.variant === 'warn' && 'border-warning/40',
        entry.variant === 'success' && 'border-success/40',
      )}
    >
      <span className="ws-toast-icon">
        <Icon variant={entry.variant} />
      </span>
      {Number.isFinite(entry.ttl) && entry.ttl > 0 && (
        <span
          className="ws-toast-timer"
          style={{ animationDuration: `${entry.ttl}ms` }}
          aria-hidden="true"
        />
      )}
      <div className="flex-1 min-w-0 whitespace-pre-wrap break-words leading-snug">
        {entry.message}
      </div>
      {entry.action && (
        <button
          type="button"
          onClick={() => {
            entry.action?.onClick();
            dismissToast(entry.id);
          }}
          className="shrink-0 font-medium text-primary hover:underline"
        >
          {entry.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismissToast(entry.id)}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={t('activity:toast.dismiss')}
        aria-label={t('activity:toast.dismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Toaster() {
  const { t } = useAppTranslation();
  const toasts = useNotificationStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <section
      className="fixed bottom-4 right-4 z-[60] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2 pointer-events-auto"
      aria-label={t('activity:toaster.notifications')}
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} />
      ))}
    </section>
  );
}
