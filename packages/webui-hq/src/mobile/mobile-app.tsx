import type { HqSessionSnapshotPayload } from '@wrongstack/core/hq';
import {
  ArrowDownToLine,
  Columns3,
  History,
  Inbox as InboxIcon,
  LogOut,
  MessageSquareText,
  MonitorSmartphone,
  OctagonX,
  Radio,
  Send,
  TriangleAlert,
} from 'lucide-react';
import type * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { VList } from 'virtua';
import { useShallow } from 'zustand/react/shallow';
import { EmptyState } from '../components/hq/primitives.js';
import { TokenGate } from '../components/hq/token-gate.js';
import { TranscriptExpansionProvider } from '../components/hq/transcript/expansion.js';
import { TranscriptTurn } from '../components/hq/transcript/turn.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Input, Select, Textarea } from '../components/ui/input.js';
import { authorizedFetch, postCommand, postMailboxSend } from '../data/api.js';
import { clearHqToken, resolveHqToken } from '../data/auth/index.js';
import { useHqLocalPrefs } from '../data/local-prefs.js';
import { attentionCount } from '../data/selectors.js';
import { useHqStore } from '../data/store/index.js';
import { resolveConsoleControlTarget } from '../domain/console-target.js';
import { usePendingApprovals } from '../domain/use-pending-approvals.js';
import { turnKey, useSessionTranscript } from '../domain/use-session-transcript.js';
import { applyPalette, applyTheme, watchSystemTheme } from '../lib/theme.js';
import { cn } from '../lib/utils.js';
import { MobileAttention } from './mobile-attention.js';
import { MobileInbox } from './mobile-inbox.js';
import { MobileKanban } from './mobile-kanban.js';

type DeliveryMode = 'steer' | 'btw' | 'queue';
type MobilePane = 'console' | 'inbox' | 'kanban' | 'attention';

function useMobileNotifications(attention: number): {
  permission: NotificationPermission | 'unsupported';
  enable: () => void;
} {
  const supported = typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    supported ? Notification.permission : 'unsupported',
  );
  const previousAttention = useRef(attention);

  useEffect(() => {
    const previous = previousAttention.current;
    previousAttention.current = attention;
    if (
      permission !== 'granted' ||
      attention <= previous ||
      !document.hidden ||
      !('serviceWorker' in navigator)
    ) {
      return;
    }
    void navigator.serviceWorker.ready
      .then((registration) =>
        registration.showNotification('WrongStack HQ needs attention', {
          body: `${attention} active signal${attention === 1 ? '' : 's'} in HQ Mobile`,
          icon: '/wrongstack.svg',
          badge: '/wrongstack.svg',
          tag: 'wrongstack-hq-attention',
        }),
      )
      .catch(() => undefined);
  }, [attention, permission]);

  return {
    permission,
    enable: () => {
      if (!supported || permission !== 'default') return;
      void Notification.requestPermission()
        .then(setPermission)
        .catch(() => undefined);
    },
  };
}

function useMobileAppearance(): void {
  const { theme, palette } = useHqLocalPrefs().appearance;
  useEffect(() => {
    const root = document.documentElement;
    applyTheme(root, theme);
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyTheme(root, theme));
  }, [theme]);
  useEffect(() => applyPalette(document.documentElement, palette), [palette]);
}

function sessionLabel(session: HqSessionSnapshotPayload): string {
  const host = session.hostname ?? session.machineId;
  return `${session.projectName} · ${host} · ${session.clientKind.toUpperCase()}`;
}

/**
 * Phone-first HQ surface. It shares the authenticated data/control plane with
 * desktop HQ, but deliberately exposes only conversational operations: live
 * transcript, durable messaging and an explicitly confirmed interrupt.
 */
export function MobileApp(): React.ReactElement {
  const {
    snapshot,
    connected,
    authRequired,
    selectedSessionId,
    selectedAgentId,
    alerts,
    commandStatuses,
  } = useHqStore(
    useShallow((state) => ({
      snapshot: state.snapshot,
      connected: state.connected,
      authRequired: state.authRequired,
      selectedSessionId: state.selectedSessionId,
      selectedAgentId: state.selectedAgentId,
      alerts: state.alerts,
      commandStatuses: state.commandStatuses,
    })),
  );
  const sessions = snapshot?.liveSessions ?? [];
  const [pane, setPane] = useState<MobilePane>('console');
  const [delivery, setDelivery] = useState<DeliveryMode>('steer');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [interruptOpen, setInterruptOpen] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useMobileAppearance();

  useEffect(() => {
    document.title = 'WrongStack HQ Mobile';
    if ('serviceWorker' in navigator && window.isSecureContext) {
      void navigator.serviceWorker.register('/mobile-sw.js', { scope: '/mobile' }).catch(() => {
        // Installation is an enhancement; live HQ must remain usable when a
        // browser or enterprise policy refuses service workers.
      });
    }
  }, []);

  // A phone should open on useful content immediately. Sticky selections are
  // preserved when a publisher reconnects; only a brand-new tab auto-selects.
  useEffect(() => {
    if (selectedSessionId === null && sessions[0] !== undefined) {
      useHqStore.getState().selectSession(sessions[0].sessionId);
    }
  }, [selectedSessionId, sessions]);

  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId);
  const target = useMemo(
    () => resolveConsoleControlTarget(snapshot, selectedSessionId, selectedAgentId),
    [selectedAgentId, selectedSessionId, snapshot],
  );
  const chat = useSessionTranscript(selectedSessionId, selectedAgentId);
  const recipient = target?.recipient ?? selectedAgentId ?? 'leader';
  const recipientLabel = target?.agent?.name ?? (recipient === 'leader' ? 'Leader' : recipient);
  const canControl = target?.controllable === true;
  const canUseMailbox = target?.mailboxServeActive === true;
  const canMessage = target !== null && (canControl || canUseMailbox);
  // Approvals are event-derived rather than part of the snapshot, so they are
  // added here instead of inside `attentionCount`. They belong in the
  // notification total above everything else: a prompt expires on a clock, so
  // a missed push means the decision was made without the operator.
  const { approvals } = usePendingApprovals();
  const attention = attentionCount(snapshot, alerts, commandStatuses) + approvals.length;
  const unread = snapshot?.totals.unreadMailboxMessages ?? 0;
  const notifications = useMobileNotifications(attention + Number(unread > 0));

  const sendMessage = async (): Promise<void> => {
    const text = body.trim();
    if (!canMessage || target === null || text.length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      if (canControl && target.client !== null) {
        await postCommand(target.client.clientId, delivery, {
          sessionId: target.session.sessionId,
          to: target.recipient,
          subject: subject.trim() || `HQ mobile ${delivery}`,
          body: text,
          priority: delivery === 'steer' ? 'high' : 'normal',
        });
      } else {
        await postMailboxSend({
          projectId: target.session.projectId,
          sessionId: target.session.sessionId,
          type: delivery,
          to: target.recipient,
          subject: subject.trim() || `HQ mobile ${delivery}`,
          body: text,
          priority: delivery === 'steer' ? 'high' : 'normal',
        });
      }
      setBody('');
      setStatus({
        tone: 'ok',
        text: canControl ? `${delivery} queued` : `${delivery} sent through mailbox`,
      });
    } catch (cause) {
      setStatus({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const interrupt = async (): Promise<void> => {
    if (!canControl || target?.client === null || target?.client === undefined) return;
    setBusy(true);
    setStatus(null);
    try {
      await postCommand(target.client.clientId, 'abort', {
        sessionId: target.session.sessionId,
        target: target.recipient,
      });
      setStatus({ tone: 'ok', text: `Interrupt queued for ${recipientLabel}` });
      setInterruptOpen(false);
    } catch (cause) {
      setStatus({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await authorizedFetch('/api/logout', { method: 'POST' });
    } finally {
      clearHqToken();
      window.location.reload();
    }
  };

  if (authRequired) return <TokenGate hadToken={resolveHqToken() !== null} passwordOnly />;

  return (
    <div
      data-testid="hq-mobile"
      className="mx-auto flex h-full w-full max-w-3xl flex-col bg-background"
    >
      <div className="brand-rule h-0.5 w-full shrink-0" />
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
        <img src="/wrongstack.svg" alt="" aria-hidden="true" className="size-5" />
        <div className="min-w-0 leading-tight">
          <h1 className="font-display text-sm font-semibold">HQ Mobile</h1>
          <p className="text-[10px] text-muted-foreground">secure live operations</p>
        </div>
        <Badge tone={connected ? 'active' : 'warn'} className="ml-auto">
          {connected ? <Radio className="animate-pulse" /> : <MonitorSmartphone />}
          {connected ? 'Live' : 'Reconnecting'}
        </Badge>
        <a href="/" className="px-1 text-[11px] text-muted-foreground underline underline-offset-2">
          Desktop
        </a>
        <Button variant="ghost" size="icon-sm" aria-label="Log out" onClick={() => void logout()}>
          <LogOut />
        </Button>
      </header>

      <nav
        aria-label="Mobile HQ sections"
        className="grid shrink-0 grid-cols-4 border-b border-border"
      >
        {(
          [
            ['console', MessageSquareText, 'Console', 0],
            ['inbox', InboxIcon, 'Inbox', unread],
            ['kanban', Columns3, 'Kanban', 0],
            ['attention', TriangleAlert, 'Attention', attention],
          ] as const
        ).map(([id, Icon, label, count]) => (
          <button
            key={id}
            type="button"
            data-testid="mobile-pane"
            data-selected={pane === id}
            onClick={() => setPane(id)}
            className={cn(
              'flex min-h-12 items-center justify-center gap-1.5 border-b-2 px-2 text-xs transition-colors',
              pane === id
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-transparent text-muted-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
            {count > 0 && <Badge tone={id === 'attention' ? 'warn' : 'info'}>{count}</Badge>}
          </button>
        ))}
      </nav>

      <div className={cn('min-h-0 flex-1 flex-col', pane === 'console' ? 'flex' : 'hidden')}>
        <section className="shrink-0 space-y-2 border-b border-border bg-card/60 p-3">
          <Select
            aria-label="Mobile session"
            value={selectedSessionId ?? ''}
            onChange={(event) => useHqStore.getState().selectSession(event.target.value)}
          >
            {sessions.length === 0 && selectedSessionId === null && (
              <option value="">No live sessions</option>
            )}
            {selectedSessionId !== null && selectedSession === undefined && (
              <option value={selectedSessionId}>Reconnecting · {selectedSessionId}</option>
            )}
            {sessions.map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {sessionLabel(session)}
              </option>
            ))}
          </Select>

          {selectedSession !== undefined && (
            <div className="flex gap-2">
              <Select
                aria-label="Mobile agent"
                value={selectedAgentId ?? ''}
                onChange={(event) =>
                  useHqStore
                    .getState()
                    .selectSession(selectedSession.sessionId, event.target.value || null)
                }
                className="min-w-0 flex-1"
              >
                <option value="">Leader / main session</option>
                {selectedSession.agents
                  .filter((agent) => agent.id !== 'leader')
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {agent.status}
                    </option>
                  ))}
              </Select>
              <Badge tone={canControl ? 'active' : canUseMailbox ? 'info' : 'idle'}>
                {canControl ? 'control' : canUseMailbox ? 'mailbox' : 'read only'}
              </Badge>
              {selectedAgentId === null && !chat.full && chat.meta.total > chat.entries.length && (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Load full mobile history"
                  onClick={() => chat.setFull(true)}
                >
                  <History />
                  All {chat.meta.total}
                </Button>
              )}
            </div>
          )}
        </section>

        <main className="relative min-h-0 flex-1">
          {selectedSessionId === null ? (
            <EmptyState
              icon={MonitorSmartphone}
              title="Waiting for a client"
              hint="Connect a CLI, TUI or WebUI client to this HQ server."
              className="m-4"
            />
          ) : chat.loading && chat.entries.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">Loading live transcript…</p>
          ) : chat.error !== null && chat.entries.length === 0 ? (
            <EmptyState title="Transcript unavailable" hint={chat.error} className="m-4" />
          ) : chat.entries.length === 0 ? (
            <EmptyState
              title="No messages yet"
              hint="This conversation is live and ready."
              className="m-4"
            />
          ) : (
            <TranscriptExpansionProvider>
              <VList ref={chat.listRef} onScroll={chat.onScroll} className="h-full px-2 py-2">
                {chat.entries.map((entry, index) => (
                  <div key={turnKey(entry, index)} className="pb-2">
                    <TranscriptTurn
                      entry={entry}
                      running={chat.isRunningAt(entry, index)}
                      turnKey={turnKey(entry, index)}
                    />
                  </div>
                ))}
              </VList>
            </TranscriptExpansionProvider>
          )}
          {!chat.pinned && chat.entries.length > 0 && (
            <Button
              size="icon"
              aria-label="Jump to latest"
              onClick={chat.jumpToLatest}
              className="absolute bottom-3 right-3 shadow-lg"
            >
              <ArrowDownToLine />
            </Button>
          )}
        </main>

        {selectedSessionId !== null && (
          <section
            className="shrink-0 space-y-2 border-t border-border bg-card p-3"
            style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
          >
            <div className="flex gap-2">
              <Select
                aria-label="Mobile delivery mode"
                value={delivery}
                onChange={(event) => setDelivery(event.target.value as DeliveryMode)}
                className="w-32 shrink-0"
              >
                <option value="steer">Steer now</option>
                <option value="btw">BTW / FYI</option>
                <option value="queue">Queue next</option>
              </Select>
              <Input
                aria-label="Mobile message subject"
                placeholder="Subject (optional)"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </div>
            <div className="flex items-stretch gap-2">
              <Textarea
                aria-label={`Message ${recipientLabel}`}
                rows={2}
                placeholder={
                  canMessage ? `Message ${recipientLabel}…` : 'Waiting for a writable endpoint…'
                }
                value={body}
                onChange={(event) => setBody(event.target.value)}
                className="min-h-16 flex-1 resize-none"
              />
              <div className="flex w-12 shrink-0 flex-col gap-1.5">
                <Button
                  aria-label="Send message"
                  disabled={busy || body.trim().length === 0 || !canMessage}
                  onClick={() => void sendMessage()}
                  className="min-h-9 flex-1"
                >
                  <Send />
                </Button>
                <Button
                  variant="destructive"
                  size="icon"
                  aria-label={`Interrupt ${recipientLabel}`}
                  disabled={busy || !canControl}
                  onClick={() => setInterruptOpen(true)}
                >
                  <OctagonX />
                </Button>
              </div>
            </div>
            {status !== null && (
              <p
                role="status"
                className={cn(
                  'text-[11px]',
                  status.tone === 'error' ? 'text-destructive' : 'text-success',
                )}
              >
                {status.text}
              </p>
            )}
          </section>
        )}
      </div>

      {pane === 'inbox' && <MobileInbox />}
      {pane === 'kanban' && <MobileKanban />}
      {pane === 'attention' && (
        <MobileAttention
          onOpenConsole={(sessionId, agentId) => {
            useHqStore.getState().selectAgent(sessionId, agentId);
            setPane('console');
          }}
          onOpenInbox={() => setPane('inbox')}
          notificationPermission={notifications.permission}
          onEnableNotifications={notifications.enable}
        />
      )}

      <AlertDialog open={interruptOpen} onOpenChange={setInterruptOpen}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>Interrupt {recipientLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              The active run will stop at its next cancellation boundary.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void interrupt()}>
              Confirm interrupt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
