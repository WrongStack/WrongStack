import {
  Bell,
  CheckCircle2,
  Circle,
  FileText,
  HelpCircle,
  Lock,
  Mail,
  MailOpen,
  MailPlus,
  MessageSquare,
  RotateCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  UserCheck,
  Users,
  Zap,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pagination } from '@/components/ui/pagination';
import { usePagination } from '@/hooks/usePagination';
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { useActiveSessionId, useMailboxStore, useUIStore } from '@/stores';
import { onLaneDisposed } from '@/stores/chat-lanes';
import { classifyMailboxRecipient, type MailboxMessage } from '@/stores/mailbox-store';
import { confirmModal } from './ConfirmModal';

type MailboxComposeType =
  | 'note'
  | 'ask'
  | 'assign'
  | 'steer'
  | 'btw'
  | 'broadcast'
  | 'status'
  | 'result'
  | 'review';

type MailboxSendState =
  | { phase: 'idle' }
  | { phase: 'sending'; requestId: string }
  | { phase: 'sent'; messageId?: string | undefined }
  | { phase: 'error'; message: string };

const COMPOSE_TYPES: MailboxComposeType[] = [
  'note',
  'ask',
  'assign',
  'steer',
  'btw',
  'broadcast',
  'status',
  'result',
  'review',
];

type MailboxPanelChrome = {
  collapsed: boolean;
  deleting: boolean;
  purging: boolean;
  compacting: boolean;
  composeOpen: boolean;
  composeTo: string;
  composeType: MailboxComposeType;
  composeAudience: 'all' | 'leaders';
  composePriority: 'low' | 'normal' | 'high';
  composeSubject: string;
  composeBody: string;
  sendState: MailboxSendState;
};

const MAILBOX_PANEL_NO_SESSION = '__no_session__';
const mailboxPanelChromeBySession = new Map<string, MailboxPanelChrome>();
const disposedMailboxPanelSessions = new Set<string>();

onLaneDisposed((sessionId) => {
  mailboxPanelChromeBySession.delete(sessionId);
  disposedMailboxPanelSessions.add(sessionId);
});

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
  review: Search,
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

function mailboxMessageBelongsToSession(
  message: MailboxMessage,
  sessionId: string | null,
): boolean {
  if (!sessionId) return true;
  if (message.senderSessionId === sessionId || message.recipientSessionId === sessionId)
    return true;
  if (
    message.to.includes(`@session:${sessionId}`) ||
    message.from.includes(`@session:${sessionId}`)
  ) {
    return true;
  }
  const classified = classifyMailboxRecipient(message.to);
  if (classified.scope === 'project') return true;
  return classified.recipientSessionId === sessionId;
}

// ── Component ─────────────────────────────────────────────────────────

export function MailboxPanel({ className }: { className?: string }) {
  const sessionId = useActiveSessionId();
  // Messages/agents live in the central mailbox store — populated by the
  // ws-handlers registry, refreshed on every mailbox.event. This panel
  // only triggers an extra refresh when (re)mounted.
  const messages = useMailboxStore((s) => s.messages);
  const agents = useMailboxStore((s) => s.agents);
  const lastCompaction = useMailboxStore((s) => s.lastCompaction);
  const [collapsed, setCollapsed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState('leader');
  const [composeType, setComposeType] = useState<MailboxComposeType>('note');
  const [composeAudience, setComposeAudience] = useState<'all' | 'leaders'>('all');
  const [composePriority, setComposePriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');
  const [sendState, setSendState] = useState<MailboxSendState>({ phase: 'idle' });
  const chromeSessionRef = useRef<string>(sessionId ?? MAILBOX_PANEL_NO_SESSION);
  const { client } = useWebSocket();
  const { t } = useAppTranslation();

  useLayoutEffect(() => {
    if (!disposedMailboxPanelSessions.has(chromeSessionRef.current)) {
      mailboxPanelChromeBySession.set(chromeSessionRef.current, {
        collapsed,
        deleting,
        purging,
        compacting,
        composeOpen,
        composeTo,
        composeType,
        composeAudience,
        composePriority,
        composeSubject,
        composeBody,
        sendState,
      });
    }

    const next = sessionId ?? MAILBOX_PANEL_NO_SESSION;
    const parked = mailboxPanelChromeBySession.get(next);
    disposedMailboxPanelSessions.delete(next);
    setCollapsed(parked?.collapsed ?? false);
    setDeleting(parked?.deleting ?? false);
    setPurging(parked?.purging ?? false);
    setCompacting(parked?.compacting ?? false);
    setComposeOpen(parked?.composeOpen ?? false);
    setComposeTo(parked?.composeTo ?? 'leader');
    setComposeType(parked?.composeType ?? 'note');
    setComposeAudience(parked?.composeAudience ?? 'all');
    setComposePriority(parked?.composePriority ?? 'normal');
    setComposeSubject(parked?.composeSubject ?? '');
    setComposeBody(parked?.composeBody ?? '');
    setSendState(parked?.sendState ?? { phase: 'idle' });
    chromeSessionRef.current = next;
  }, [sessionId]);
  // Track the socket lifecycle so the initial queries fire once the
  // connection is actually open (client.send drops messages otherwise).
  const [ready, setReady] = useState(client.status.state === 'open');
  useEffect(() => {
    const off = client.onStatus((s) => setReady(s.state === 'open'));
    return () => off();
  }, [client]);

  useEffect(() => {
    return client.on('mailbox.sent', (message) => {
      const payload = message.payload as {
        requestId?: string;
        success?: boolean;
        messageId?: string;
        error?: string;
      };
      setSendState((current) => {
        if (current.phase !== 'sending' || payload.requestId !== current.requestId) return current;
        if (payload.success === true) {
          setComposeBody('');
          return { phase: 'sent', messageId: payload.messageId };
        }
        return { phase: 'error', message: payload.error ?? t('activity:mailbox.sendFailed') };
      });
    });
  }, [client, t]);

  // Query mailbox on mount and when WS becomes ready
  useEffect(() => {
    if (!ready) return;
    client.send({ type: 'mailbox.messages', payload: { limit: 30 } });
    client.send({ type: 'mailbox.agents', payload: {} });
  }, [ready, client]);

  const selectedMailMessage = useUIStore((s) => s.selectedMailMessage);
  const setSelectedMailMessage = useUIStore((s) => s.setSelectedMailMessage);

  function handleMessageClick(m: (typeof messages)[number]) {
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

  const scopedMessages = messages.filter((message) =>
    mailboxMessageBelongsToSession(message, sessionId),
  );
  const scopedAgents = sessionId ? agents.filter((agent) => agent.sessionId === sessionId) : agents;
  const unreadCount = scopedMessages.filter((m) => !m.completed).length;
  const onlineCount = scopedAgents.filter((a) => a.online).length;
  const messagePage = usePagination(scopedMessages, 8);
  const onlineAgents = scopedAgents.filter((agent) => agent.online);
  const agentPage = usePagination(onlineAgents, 5);

  async function handleDeleteAll() {
    if (scopedMessages.length === 0) return;
    const ok = await confirmModal({
      title: t('activity:mailbox.deleteAllConfirmTitle', { count: scopedMessages.length }),
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
    if (deleting && scopedMessages.length === 0) setDeleting(false);
  }, [deleting, scopedMessages.length]);
  // Timeout fallback like the purge/compact siblings below: if the clear
  // fails server-side (or a new message lands before the confirm), the
  // success condition above never fires and the button stayed disabled
  // with its spinner forever.
  useEffect(() => {
    if (deleting) {
      const t = setTimeout(() => setDeleting(false), 3000);
      return () => clearTimeout(t);
    }
  }, [deleting]);

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

  async function handleCompact() {
    setCompacting(true);
    client.send({ type: 'mailbox.compact' });
  }

  // Reset compacting state after server confirms.
  useEffect(() => {
    if (compacting) {
      const t = setTimeout(() => setCompacting(false), 3000);
      return () => clearTimeout(t);
    }
  }, [compacting]);

  function handleSendMail() {
    const body = composeBody.trim();
    const to = composeType === 'broadcast' ? '*' : composeTo.trim();
    if (!ready || body.length === 0 || to.length === 0 || sendState.phase === 'sending') return;
    const requestId = `webui-mail-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setSendState({ phase: 'sending', requestId });
    client.send({
      type: 'mailbox.send',
      payload: {
        requestId,
        to,
        type: composeType,
        audience: composeAudience,
        subject: composeSubject.trim() || t('activity:mailbox.defaultSubject'),
        body,
        priority: composePriority,
        ...(sessionId ? { sessionId } : {}),
      },
    });
  }

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
          <div className="border-b border-border pb-2">
            <button
              type="button"
              onClick={() => setComposeOpen((value) => !value)}
              className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-[10px] font-semibold text-primary hover:bg-primary/5"
              aria-expanded={composeOpen}
            >
              <MailPlus className="h-3.5 w-3.5" />
              {t('activity:mailbox.compose')}
              <span className="ml-auto text-muted-foreground">{composeOpen ? '−' : '+'}</span>
            </button>
            {composeOpen && (
              <div className="mt-2 space-y-2 rounded-md border border-border bg-background/60 p-2">
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-[10px] text-muted-foreground">
                    <span>{t('activity:mailbox.recipient')}</span>
                    <input
                      className="h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground disabled:opacity-50"
                      value={composeType === 'broadcast' ? '*' : composeTo}
                      list="mailbox-agent-recipients"
                      disabled={composeType === 'broadcast'}
                      placeholder="leader"
                      onChange={(event) => setComposeTo(event.target.value)}
                    />
                    <datalist id="mailbox-agent-recipients">
                      <option value="leader" />
                      <option value="*" />
                      {scopedAgents.map((agent) => (
                        <option key={agent.agentId} value={agent.agentId} />
                      ))}
                    </datalist>
                  </label>
                  <label className="space-y-1 text-[10px] text-muted-foreground">
                    <span>{t('activity:mailbox.messageType')}</span>
                    <select
                      className="h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground"
                      value={composeType}
                      onChange={(event) => setComposeType(event.target.value as MailboxComposeType)}
                    >
                      {COMPOSE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(`activity:mailbox.type.${type}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-[10px] text-muted-foreground">
                    <span>{t('activity:mailbox.audience')}</span>
                    <select
                      className="h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground"
                      value={composeAudience}
                      onChange={(event) =>
                        setComposeAudience(event.target.value as 'all' | 'leaders')
                      }
                    >
                      <option value="all">{t('activity:mailbox.audienceAll')}</option>
                      <option value="leaders">{t('activity:mailbox.audienceLeaders')}</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-[10px] text-muted-foreground">
                    <span>{t('activity:mailbox.priority')}</span>
                    <select
                      className="h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground"
                      value={composePriority}
                      onChange={(event) =>
                        setComposePriority(event.target.value as 'low' | 'normal' | 'high')
                      }
                    >
                      <option value="low">{t('activity:mailbox.priorityLow')}</option>
                      <option value="normal">{t('activity:mailbox.priorityNormal')}</option>
                      <option value="high">{t('activity:mailbox.priorityHigh')}</option>
                    </select>
                  </label>
                </div>
                <input
                  className="h-7 w-full rounded border border-border bg-background px-2 text-xs text-foreground"
                  value={composeSubject}
                  placeholder={t('activity:mailbox.subjectPlaceholder')}
                  onChange={(event) => setComposeSubject(event.target.value)}
                />
                <textarea
                  className="min-h-16 w-full resize-y rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                  value={composeBody}
                  placeholder={t('activity:mailbox.bodyPlaceholder')}
                  onChange={(event) => setComposeBody(event.target.value)}
                />
                {composeAudience === 'leaders' && (
                  <div className="flex items-center gap-1 text-[10px] text-primary">
                    <Lock className="h-3 w-3" />
                    {t('activity:mailbox.leadersOnlyHint')}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2 text-[10px] font-semibold text-primary-foreground disabled:opacity-40"
                    disabled={
                      !ready ||
                      composeBody.trim().length === 0 ||
                      (composeType !== 'broadcast' && composeTo.trim().length === 0) ||
                      sendState.phase === 'sending'
                    }
                    onClick={handleSendMail}
                  >
                    <Send className="h-3 w-3" />
                    {sendState.phase === 'sending'
                      ? t('activity:mailbox.sending')
                      : t('activity:mailbox.send')}
                  </button>
                  {sendState.phase === 'sent' && (
                    <span className="text-[10px] text-success">
                      {t('activity:mailbox.sent')}
                      {sendState.messageId ? ` · ${sendState.messageId.slice(0, 8)}` : ''}
                    </span>
                  )}
                  {sendState.phase === 'error' && (
                    <span
                      className="truncate text-[10px] text-destructive"
                      title={sendState.message}
                    >
                      {sendState.message}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Messages */}
          {scopedMessages.length > 0 ? (
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
                <button
                  type="button"
                  onClick={handleCompact}
                  disabled={compacting}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary disabled:opacity-40 transition-colors"
                  title={t('activity:mailbox.compactTitle')}
                >
                  <Zap className="h-3 w-3" />
                  {compacting ? t('activity:mailbox.compacting') : t('activity:mailbox.compact')}
                </button>
              </div>
              {/* Compaction result badge */}
              {lastCompaction && lastCompaction.totalRemoved > 0 && (
                <div className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] bg-primary/5 text-primary/70 border border-primary/10">
                  <Zap className="h-3 w-3 shrink-0" />
                  <span>
                    {t('activity:mailbox.compactRemoved', { count: lastCompaction.totalRemoved })}
                    {lastCompaction.expiredRemoved > 0 &&
                      ` (${t('activity:mailbox.compactExpired', { count: lastCompaction.expiredRemoved })})`}
                    {lastCompaction.readByAllRemoved > 0 &&
                      ` (${t('activity:mailbox.compactReadByAll', { count: lastCompaction.readByAllRemoved })})`}
                    {lastCompaction.stalePurged > 0 &&
                      ` (${t('activity:mailbox.compactStale', { count: lastCompaction.stalePurged })})`}
                    {' — '}
                    {t('activity:mailbox.compactRemaining', { count: lastCompaction.remaining })}
                  </span>
                </div>
              )}
              {messagePage.pageItems.map((m) => {
                const Icon = TYPE_ICONS[m.type] ?? MessageSquare;
                const isRead = m.readByCount > 0;
                const isSelected = selectedMailMessage?.id === m.id;
                const recipient = m.scope
                  ? { scope: m.scope, recipientSessionId: m.recipientSessionId }
                  : classifyMailboxRecipient(m.to);
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
                    <Icon
                      className={cn(
                        'h-3.5 w-3.5 mt-0.5 shrink-0',
                        isRead ? 'text-muted-foreground' : 'text-warning',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={cn('font-medium truncate', !isRead && 'text-warning')}>
                          {m.from}
                        </span>
                        {m.completed && <CheckCircle2 className="h-3 w-3 text-success shrink-0" />}
                        {m.audience === 'leaders' && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 text-[9px] font-semibold text-primary">
                            <Lock className="h-2.5 w-2.5" />
                            {t('activity:mailbox.leadersLabel')}
                          </span>
                        )}
                        {!isRead && (
                          <span className="text-[9px] text-warning font-bold">
                            {t('activity:mailbox.newLabel')}
                          </span>
                        )}
                        {recipient.scope === 'session' && (
                          <span
                            className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-warning/12 text-warning"
                            title={t('activity:mailbox.sessionScopeTitle', {
                              sid: recipient.recipientSessionId ?? '',
                            })}
                          >
                            <Lock className="h-2.5 w-2.5" />
                            {t('activity:mailbox.sessionLabel')}
                          </span>
                        )}
                        {recipient.scope === 'project' && (
                          <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-semibold bg-primary/12 text-primary">
                            {t('activity:mailbox.projectLabel')}
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground truncate">{m.subject}</div>
                      <div className="text-[10px] text-muted-foreground/70 truncate">
                        {m.body.slice(0, 60)}
                        {m.body.length > 60 ? '…' : ''}
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
              <Pagination
                page={messagePage.page}
                pageSize={messagePage.pageSize}
                totalItems={messagePage.totalItems}
                onPageChange={messagePage.setPage}
                compact
                itemLabel="messages"
              />
            </div>
          ) : (
            <div className="text-xs text-muted-foreground py-2 text-center">
              <MailOpen className="h-4 w-4 mx-auto mb-1 opacity-40" />
              {t('activity:mailbox.empty')}
            </div>
          )}

          {/* Online agents */}
          {scopedAgents.length > 0 && (
            <div className="border-t border-border pt-2">
              <div className="text-[10px] font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                <Users className="h-3 w-3" /> {t('activity:nav.agents')}
              </div>
              {agentPage.pageItems.map((a) => (
                <div
                  key={a.agentId}
                  className="flex items-center gap-1.5 text-[10px] text-muted-foreground py-0.5"
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      a.online ? 'bg-success' : 'bg-muted-foreground/30',
                    )}
                  />
                  <span className="font-medium text-foreground/80">{a.name}</span>
                  {a.role && <span className="opacity-60">({a.role})</span>}
                  <span className="opacity-50">{a.status}</span>
                  {a.currentTool && <span className="text-primary">{a.currentTool}</span>}
                  <span className="ml-auto opacity-50">{fmtTime(a.lastSeenAt)}</span>
                </div>
              ))}
              <Pagination
                page={agentPage.page}
                pageSize={agentPage.pageSize}
                totalItems={agentPage.totalItems}
                onPageChange={agentPage.setPage}
                compact
                itemLabel="online agents"
              />
              {scopedAgents.filter((a) => !a.online).length > 0 && (
                <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {t('activity:mailbox.offlineCount', {
                    count: scopedAgents.filter((a) => !a.online).length,
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
