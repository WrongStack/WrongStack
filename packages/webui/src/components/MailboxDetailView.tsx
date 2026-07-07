/**
 * MailboxDetailView — displays the selected mailbox message in the main content area.
 * Shown when currentView === 'mailbox'.
 */

import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Mail,
  Tag,
  User,
  AlertCircle,
  FileText,
  HelpCircle,
  Send,
  RotateCw,
  Bell,
  Circle,
  MessageSquare,
  Reply,
  X,
} from 'lucide-react';
import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { useAppTranslation, i18n } from '@/i18n';
import { showPanel } from '@/lib/view-navigation';
import { useUIStore } from '@/stores/ui-store';
import { markdownComponents } from './MessageBubble/utils';

// ── Helpers ───────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, typeof MessageSquare> = {
  note: FileText,
  ask: HelpCircle,
  assign: Send,
  steer: RotateCw,
  btw: Bell,
  broadcast: Send,
  status: Circle,
  result: CheckCircle2,
};

const PRIORITY_COLORS: Record<string, string> = {
  high: 'border-destructive/25 bg-destructive/10 text-destructive',
  normal: 'border-border bg-muted text-muted-foreground',
  low: 'border-primary/20 bg-primary/10 text-primary',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return i18n.t('common:time.justNow');
  if (diff < 3600_000) return i18n.t('common:time.minutesAgo', { count: Math.round(diff / 60_000) });
  if (diff < 86400_000) return i18n.t('common:time.hoursAgo', { count: Math.round(diff / 3600_000) });
  if (diff < 604800_000) return i18n.t('common:time.daysAgo', { count: Math.round(diff / 86400_000) });
  return d.toLocaleDateString();
}

// ── Component ─────────────────────────────────────────────────────────

function EmptyState() {
  const { t } = useAppTranslation();
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-[hsl(var(--surface-2)/0.45)] p-4">
      <div className="ws-surface flex max-w-md flex-col items-center gap-3 rounded-xl p-6 text-center text-muted-foreground">
        <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Mail className="h-6 w-6" />
        </span>
        <div>
          <div className="text-sm font-semibold text-foreground">{t('activity:mailbox.emptyDetail')}</div>
          <div className="mt-1 text-xs">
            {t('activity:mailbox.emptyDetailHint')}
          </div>
        </div>
      </div>
    </div>
  );
}

function _MessageNotFound() {
  const { t } = useAppTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-muted-foreground">
      <AlertCircle className="h-10 w-10 opacity-30" />
      <div className="text-sm font-medium">{t('activity:mailbox.messageNotFound')}</div>
      <div className="text-xs opacity-60">{t('activity:mailbox.messageNotFoundHint')}</div>
    </div>
  );
}

function ReadByList({ readBy }: { readBy: Record<string, string> }) {
  const { t } = useAppTranslation();
  const entries = Object.entries(readBy);
  if (entries.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{t('activity:mailbox.readBy')}</div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([agentId, timestamp]) => (
          <span
            key={agentId}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-success/10 text-success"
            title={fmtTime(timestamp)}
          >
            <CheckCircle2 className="h-2.5 w-2.5" />
            {agentId}
          </span>
        ))}
      </div>
    </div>
  );
}

export function MailboxDetailView({ className }: { className?: string }) {
  const { t } = useAppTranslation();
  const msg = useUIStore((s) => s.selectedMailMessage);
  const setSelectedMailMessage = useUIStore((s) => s.setSelectedMailMessage);

  // Clear selectedMailMessage whenever the detail view unmounts (user navigates
  // away via panel switch, keyboard shortcut, command palette, etc.).
  useEffect(() => {
    return () => {
      setSelectedMailMessage(null);
    };
  }, [setSelectedMailMessage]);

  function handleClose() {
    setSelectedMailMessage(null);
    showPanel('chat');
  }

  if (!msg) return <EmptyState />;

  const Icon = TYPE_ICONS[msg.type] ?? MessageSquare;
  const typeLabel = t(`activity:mailbox.type.${msg.type}`, { defaultValue: msg.type });
  const priorityClass = PRIORITY_COLORS[msg.priority] ?? PRIORITY_COLORS.normal;

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[hsl(var(--surface-2)/0.45)] p-3',
        className,
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/75 shadow-sm">
      {/* ── Header bar ── */}
      <div className="flex items-center gap-3 border-b border-border/70 px-3 py-3 sm:px-4 shrink-0">
        <button
          type="button"
          onClick={handleClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t('activity:mailbox.backToChat')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', msg.completed ? 'bg-[hsl(var(--success)/0.1)]' : 'bg-primary/10')}>
          <Icon className={cn('h-4 w-4', msg.completed ? 'text-[hsl(var(--success))]' : 'text-primary')} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground truncate">{msg.subject}</h2>
            {msg.completed && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[hsl(var(--success)/0.25)] bg-[hsl(var(--success)/0.08)] px-1.5 py-0.5 text-[10px] font-semibold text-[hsl(var(--success))]">
                <CheckCircle2 className="h-3 w-3" />
                {t('activity:mailbox.completed')}
              </span>
            )}
            <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase', priorityClass)}>
              {msg.priority || 'normal'}
            </span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate font-medium text-foreground/80">{msg.from}</span>
            <span>→</span>
            <span className="min-w-0 truncate">{msg.to === '*' || msg.to === 'all' ? t('activity:mailbox.everyone') : msg.to}</span>
            <span className="opacity-40">•</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {fmtRelative(msg.timestamp)}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t('activity:mailbox.closeTitle')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ── Body ── */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-5">
          <div className="markdown-content prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
            <ReactMarkdown components={markdownComponents}>{msg.body}</ReactMarkdown>
          </div>
        </div>
      </div>

      {/* ── Metadata footer ── */}
      <div className="border-t border-border/70 bg-muted/20 px-4 py-3 shrink-0">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
          {/* Type */}
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Tag className="h-3 w-3 shrink-0" />
            <span>{typeLabel}</span>
          </div>

          {/* Priority */}
          <div className="flex items-center gap-1.5">
            <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase', priorityClass)}>
              {msg.priority || 'normal'}
            </span>
          </div>

          {/* From */}
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <User className="h-3 w-3 shrink-0" />
            <span className="truncate" title={msg.from}>{msg.from}</span>
          </div>

          {/* Timestamp */}
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="h-3 w-3 shrink-0" />
            <span>{fmtTime(msg.timestamp)}</span>
          </div>

          {/* Reply To */}
          {msg.replyTo && (
            <div className="flex items-center gap-1.5 text-muted-foreground col-span-2">
              <Reply className="h-3 w-3 shrink-0" />
              <span className="truncate">{t('activity:mailbox.replyTo', { id: msg.replyTo })}</span>
            </div>
          )}

          {/* Completed by */}
          {msg.completed && msg.completedBy && (
            <div className="flex items-center gap-1.5 text-muted-foreground col-span-2">
              <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
              <span>{msg.completedAt ? t('activity:mailbox.completedByAt', { name: msg.completedBy, time: fmtTime(msg.completedAt) }) : t('activity:mailbox.completedBy', { name: msg.completedBy })}</span>
            </div>
          )}

          {/* Outcome */}
          {msg.outcome && (
            <div className="flex items-start gap-1.5 text-muted-foreground col-span-2 sm:col-span-4">
              <span className="text-[10px] font-semibold uppercase tracking-wide shrink-0 mt-0.5">{t('activity:mailbox.outcome')}</span>
              <span>{msg.outcome}</span>
            </div>
          )}

          {/* Task Context */}
          {msg.taskContext && (
            <div className="flex items-start gap-1.5 text-muted-foreground col-span-2 sm:col-span-4">
              <span className="text-[10px] font-semibold uppercase tracking-wide shrink-0 mt-0.5">{t('activity:mailbox.task')}</span>
              <span>{msg.taskContext}</span>
            </div>
          )}
        </div>

        {/* Read by list */}
        {Object.keys(msg.readBy ?? {}).length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/50">
            <ReadByList readBy={msg.readBy} />
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
