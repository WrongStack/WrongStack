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

function ToastItem({ entry }: { entry: ToastEntry }) {
  const { t } = useAppTranslation();
  const dismissToast = useNotificationStore((s) => s.dismissToast);
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(entry.id), entry.ttl);
    return () => clearTimeout(timer);
  }, [entry.id, entry.ttl, dismissToast]);

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border bg-popover shadow-lg px-3 py-2 text-sm max-w-sm',
        'animate-message',
        entry.variant === 'error' && 'border-destructive/40',
        entry.variant === 'warn' && 'border-warning/40',
        entry.variant === 'success' && 'border-success/40',
      )}
    >
      <Icon variant={entry.variant} />
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
        className="text-muted-foreground hover:text-foreground"
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
      className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-auto"
      aria-label={t('activity:toaster.notifications')}
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} />
      ))}
    </section>
  );
}
