import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { create } from 'zustand';
import { cn } from '@/lib/utils';
import { i18n, useAppTranslation } from '@/i18n';

/**
 * Browser-safe unique id. Uses the Web Crypto `crypto.randomUUID()` when
 * available (matches the pattern in `chat-store.ts` / `ws-client.ts`) and
 * falls back to a timestamp + Math.random tag for non-secure contexts or
 * older runtimes. A toast must never throw — this previously imported
 * `randomUUID` from `node:crypto`, which Vite bundles as an empty stub in
 * the browser, so every toast crashed with `…randomUUID is not a function`.
 */
function toastId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `toast_${rand}`;
}

/**
 * Tiny toast store + portal. We resisted pulling in shadcn-ui's full
 * toast/sonner since it brings a tree of providers — this is one store,
 * one component, ~80 lines total. The store is exposed via `toast.success(...)`
 * etc. so non-React modules (ws-client handlers) can fire toasts without
 * the hook.
 */

export type ToastVariant = 'success' | 'error' | 'warn' | 'info';

/**
 * Optional action button rendered inline on a toast. Used by the
 * "undo" pattern — clicking runs `onClick` and dismisses the toast.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastEntry {
  id: string;
  message: string;
  variant: ToastVariant;
  ttl: number;
  /** Optional inline action button (e.g. "Undo"). */
  action?: ToastAction | undefined;
}

/** Default TTL for action toasts — kept in sync with `toaster-helpers.ts`. */
const ACTION_TTL_MS = 8_000;

interface ToastState {
  toasts: ToastEntry[];
  push: (t: Omit<ToastEntry, 'id'>) => string;
  dismiss: (id: string) => void;
}

const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = toastId();
    set((state) => ({ toasts: [...state.toasts, { ...t, id }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((x) => x.id !== id) })),
}));

/** Imperative API. Pass plain strings or arrays of strings for multi-line. */
export const toast = {
  success: (msg: string, ttl = 3500) =>
    useToastStore.getState().push({ message: msg, variant: 'success', ttl }),
  error: (msg: string, ttl = 6000) =>
    useToastStore.getState().push({ message: msg, variant: 'error', ttl }),
  warn: (msg: string, ttl = 4500) =>
    useToastStore.getState().push({ message: msg, variant: 'warn', ttl }),
  info: (msg: string, ttl = 3500) =>
    useToastStore.getState().push({ message: msg, variant: 'info', ttl }),
  /**
   * Fire a toast carrying an "Undo" action button. The toast lingers
   * for {@link ACTION_TTL_MS} so the user has time to react; letting it
   * expire is the same as not undoing.
   */
  undoable: (msg: string, onUndo: () => void, label = i18n.t('common:action.undo'), ttl = ACTION_TTL_MS) =>
    useToastStore
      .getState()
      .push({ message: msg, variant: 'info', ttl, action: { label, onClick: onUndo } }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};

function Icon({ variant }: { variant: ToastVariant }) {
  if (variant === 'success') return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (variant === 'error') return <XCircle className="h-4 w-4 text-destructive" />;
  if (variant === 'warn') return <AlertTriangle className="h-4 w-4 text-warning" />;
  return <Info className="h-4 w-4 text-info" />;
}

function ToastItem({ entry }: { entry: ToastEntry }) {
  const { t } = useAppTranslation();
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    const t = setTimeout(() => dismiss(entry.id), entry.ttl);
    return () => clearTimeout(t);
  }, [entry.id, entry.ttl, dismiss]);
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
            dismiss(entry.id);
          }}
          className="shrink-0 font-medium text-primary hover:underline"
        >
          {entry.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismiss(entry.id)}
        className="text-muted-foreground hover:text-foreground"
        title={t('activity:toast.dismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-auto">
      {toasts.map((t) => (
        <ToastItem key={t.id} entry={t} />
      ))}
    </div>
  );
}
