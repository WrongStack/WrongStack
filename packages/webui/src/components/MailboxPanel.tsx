import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useAppTranslation, i18n } from '@/i18n';
import { showPanel } from '@/lib/view-navigation';
import { useMailboxStore, useUIStore } from '@/stores';
import {
  CheckCircle2,
  Mail,
  MailOpen,
  MessageSquare,
  Users,
  Circle,
  FileText,
  HelpCircle,
  Send,
  Bell,
  RotateCw,
  UserCheck,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { confirmModal } from './ConfirmModal';

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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return i18n.t('activity:mailbox.timeNow');
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h`;
  return d.toLocaleDateString();
}

// ── Component ─────────────────────────────────────────────────────────

export function MailboxPanel({ className }: { className?: string }) {
  // Messages/agents live in the central mailbox store — populated by the
  // ws-handlers registry, refreshed on every mailbox.event. This panel
  // only triggers an extra refresh when (re)mounted.
  const messages = useMailboxStore((s) => s.messages);
  const agents = useMailboxStore((s) => s.agents);
  const [collapsed, setCollapsed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [purging, setPurging] = useState(false);
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  // Track the socket lifecycle so the initial queries fire once the
  // connection is actually open (client.send drops messages otherwise).
  const [ready, setReady] = useState(client.status.state === 'open');
  useEffect(() => {
    const off = client.onStatus((s) => setReady(s.state === 'open'));
    return () => off();
  }, [client]);

  // Query mailbox on mount and when WS becomes ready
  useEffect(() => {
    if (!ready) return;
    client.send({ type: 'mailbox.messages', payload: { limit: 30 } });
    client.send({ type: 'mailbox.agents', payload: {} });
  }, [ready, client]);

  const selectedMailMessage = useUIStore((s) => s.selectedMailMessage);
  const setSelectedMailMessage = useUIStore((s) => s.setSelectedMailMessage);

  function handleMessageClick(m: typeof messages[number]) {
    // Re-clicking the same message deselects and goes back to chat
    if (selectedMailMessage?.id === m.id) {
      setSelectedMailMessage(null);
      showPanel('chat');
      return;
    }
    setSelectedMailMessage(m);
    // Ensure the mailbox panel is open and the main area shows the detail
    showPanel('mailbox');
  }

  const unreadCount = messages.filter((m) => !m.completed).length;
  const onlineCount = agents.filter((a) => a.online).length;

  async function handleDeleteAll() {
    if (messages.length === 0) return;
    const ok = await confirmModal({
      title: t('activity:mailbox.deleteAllConfirmTitle', { count: messages.length }),
      message: t('activity:mailbox.deleteAllConfirmBody'),
      confirmLabel: t('activity:mailbox.deleteAll'),
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    client.send({ type: 'mailbox.clear' });
  }

  // Reset deleting state once messages are cleared (after server confirms).
  useEffect(() => {
    if (deleting && messages.length === 0) setDeleting(false);
  }, [deleting, messages.length]);

  async function handlePurge() {
    const ok = await confirmModal({
      title: t('activity:mailbox.purgeConfirmTitle'),
      message: t('activity:mailbox.purgeConfirmBody'),
      confirmLabel: t('activity:mailbox.purge'),
      danger: false,
    });
    if (!ok) return;
    setPurging(true);
    client.send({ type: 'mailbox.purge' });
  }

  // Reset purging state after server confirms (ws-handlers re-queries mailbox).
  useEffect(() => {
    if (purging) {
      const t = setTimeout(() => setPurging(false), 3000);
      return () => clearTimeout(t);
    }
  }, [purging]);

  return (
    <div className={cn('rounded-lg border border-border bg-card/60 backdrop-blur-sm', className)}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/40 rounded-t-lg transition-colors"
      >
        <Mail className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold text-foreground flex-1 min-w-0 truncate">
          {t('activity:nav.mailbox')}
        </span>
        {unreadCount > 0 && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-warning/10 text-warning">
            {unreadCount}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          {t('activity:mailbox.onlineCount', { count: onlineCount })}
        </span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-2">
          {/* Messages */}
          {messages.length > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {t('activity:mailbox.messages')}
                </span>
                <button
                  type="button"
                  onClick={handleDeleteAll}
                  disabled={deleting}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-40 transition-colors"
                  title={t('activity:mailbox.deleteAllTitle')}
                >
                  <Trash2 className="h-3 w-3" />
                  {deleting ? t('activity:mailbox.deleting') : t('activity:mailbox.deleteAll')}
                </button>
                <button
                  type="button"
                  onClick={handlePurge}
                  disabled={purging}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary disabled:opacity-40 transition-colors"
                  title={t('activity:mailbox.purgeTitle')}
                >
                  <Sparkles className="h-3 w-3" />
                  {purging ? t('activity:mailbox.purging') : t('activity:mailbox.purge')}
                </button>
              </div>
              {messages.slice(0, 8).map((m) => {
                const Icon = TYPE_ICONS[m.type] ?? MessageSquare;
                const isRead = m.readByCount > 0;
                const isSelected = selectedMailMessage?.id === m.id;
                return (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => handleMessageClick(m)}
                    className={cn(
                      'flex items-start gap-2 px-2 py-1.5 rounded text-xs w-full text-left cursor-pointer transition-colors hover:bg-accent/60',
                      !isRead && 'bg-warning/8',
                      isSelected && 'ring-1 ring-primary bg-primary/5',
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', isRead ? 'text-muted-foreground' : 'text-warning')} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={cn('font-medium truncate', !isRead && 'text-warning')}>
                          {m.from}
                        </span>
                        {m.completed && <CheckCircle2 className="h-3 w-3 text-success shrink-0" />}
                        {!isRead && <span className="text-[9px] text-warning font-bold">{t('activity:mailbox.newLabel')}</span>}
                      </div>
                      <div className="text-muted-foreground truncate">{m.subject}</div>
                      <div className="text-[10px] text-muted-foreground/70 truncate">
                        {m.body.slice(0, 60)}{m.body.length > 60 ? '…' : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-[10px] text-muted-foreground flex flex-col items-end gap-0.5">
                      <span>{fmtTime(m.timestamp)}</span>
                      {isRead && (
                        <span className="flex items-center gap-0.5">
                          <UserCheck className="h-3 w-3" />
                          {m.readByCount}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground py-2 text-center">
              <MailOpen className="h-4 w-4 mx-auto mb-1 opacity-40" />
              {t('activity:mailbox.empty')}
            </div>
          )}

          {/* Online agents */}
          {agents.length > 0 && (
            <div className="border-t border-border pt-2">
              <div className="text-[10px] font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                <Users className="h-3 w-3" /> {t('activity:nav.agents')}
              </div>
              {agents.filter((a) => a.online).slice(0, 5).map((a) => (
                <div key={a.agentId} className="flex items-center gap-1.5 text-[10px] text-muted-foreground py-0.5">
                  <span className={cn('h-1.5 w-1.5 rounded-full', a.online ? 'bg-success' : 'bg-muted-foreground/30')} />
                  <span className="font-medium text-foreground/80">{a.name}</span>
                  {a.role && <span className="opacity-60">({a.role})</span>}
                  <span className="opacity-50">{a.status}</span>
                  {a.currentTool && <span className="text-primary">{a.currentTool}</span>}
                  <span className="ml-auto opacity-50">{fmtTime(a.lastSeenAt)}</span>
                </div>
              ))}
              {agents.filter((a) => !a.online).length > 0 && (
                <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                  {t('activity:mailbox.offlineCount', { count: agents.filter((a) => !a.online).length })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
