import {
  Eye,
  LogIn,
  LogOut,
  MessageSquareWarning,
  Pause,
  Play,
  Syringe,
  UserPlus,
  Users,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { i18n, useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore } from '@/stores';
import type {
  CollabRole,
  WSCollabAnnotationAdded,
  WSCollabAnnotationResolved,
  WSCollabParticipantJoined,
  WSCollabParticipantLeft,
  WSCollabPauseGranted,
  WSCollabPauseReleased,
  WSCollabState,
  WSError,
  WSServerMessage,
} from '@/types';

export interface CollabPanelProps {
  /** Current session id — the panel joins this session on mount if the user opts in. */
  sessionId: string;
  /** Optional className for layout-level styling. */
  className?: string | undefined;
}

export interface CollabParticipant {
  participantId: string;
  role: CollabRole;
  joinedAt: string;
}

/**
 * CollabPanel — read-only live observer indicator + join/leave control.
 *
 * Phase 1 of idea #13: a second human can join an active agent run and
 * watch a live mirror of kernel events (tool calls, iterations, subagent
 * spawns). The observer cannot modify the agent. Annotation and control
 * hand-off land in Phase 2/3.
 *
 * UX:
 *   - 0 observers → muted "Join as observer" CTA
 *   - 1+ observers → live dot + count + role chips + "Leave" button
 *   - State stays in sync with the 2s server-side broadcast
 */
export function CollabPanel({ sessionId, className }: CollabPanelProps): React.ReactElement {
  const { t } = useAppTranslation();
  const [participants, setParticipants] = useState<CollabParticipant[]>([]);
  const [joined, setJoined] = useState(false);
  const [joinedRole, setJoinedRole] = useState<'observer' | 'annotator' | 'controller' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [openAnnotationCount, setOpenAnnotationCount] = useState(0);
  const [paused, setPaused] = useState(false);
  // Controller-only "inject tool result" form state (Phase 4).
  const [injectOpen, setInjectOpen] = useState(false);
  const [injectToolUseId, setInjectToolUseId] = useState('');
  const [injectContent, setInjectContent] = useState('');
  const [injectIsError, setInjectIsError] = useState(false);
  const [injectReason, setInjectReason] = useState('');
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const client = getWSClient(wsUrl);
  // In-flight tool calls (a `tool` message with no result yet) are the targets
  // a controller can inject a synthetic result for.
  const pendingTools = useChatStore((s) => s.messages).filter(
    (m) => m.role === 'tool' && m.toolResult === undefined && !!m.toolUseId,
  );

  useEffect(() => {
    const offs: Array<() => void> = [];

    // collab.state — full snapshot, sent on connect and every 2s.
    offs.push(
      client.on('collab.state', (msg: WSServerMessage) => {
        const p = msg.payload as WSCollabState['payload'];
        if (p.sessionId === sessionId) {
          setParticipants(p.participants ?? []);
        }
      }),
    );

    // collab.participant.joined — incremental add.
    offs.push(
      client.on('collab.participant.joined', (msg: WSServerMessage) => {
        const p = msg.payload as WSCollabParticipantJoined['payload'];
        if (p.sessionId !== sessionId) return;
        setParticipants((prev) => {
          if (prev.some((x) => x.participantId === p.participantId)) return prev;
          return [...prev, { participantId: p.participantId, role: p.role, joinedAt: p.joinedAt }];
        });
      }),
    );

    // collab.participant.left — incremental remove.
    offs.push(
      client.on('collab.participant.left', (msg: WSServerMessage) => {
        const p = msg.payload as WSCollabParticipantLeft['payload'];
        if (p.sessionId !== sessionId) return;
        const id = p.participantId;
        setParticipants((prev) => prev.filter((p) => p.participantId !== id));
      }),
    );

    // Surface collab-tagged server errors (e.g. role not available).
    offs.push(
      client.on('error', (msg: WSServerMessage) => {
        const p = msg.payload as WSError['payload'];
        if (p.phase === 'collab') {
          setError(p.message);
          // Optimistically mark as not joined so the user can retry.
          setJoined(false);
        }
      }),
    );

    // Annotation count. We just track the local count of
    // unresolved annotations for a quick "X notes" indicator. The
    // full annotation timeline UI is a follow-up; the count gives
    // immediate visibility ("are people reviewing this?").
    offs.push(
      client.on('collab.annotation.added', (msg: WSServerMessage) => {
        const p = msg.payload as WSCollabAnnotationAdded['payload'];
        if (p.sessionId !== sessionId) return;
        if (p.annotation?.resolved) return;
        setOpenAnnotationCount((c) => c + 1);
      }),
    );
    offs.push(
      client.on('collab.annotation.resolved', (msg: WSServerMessage) => {
        const p = msg.payload as WSCollabAnnotationResolved['payload'];
        if (p.sessionId !== sessionId) return;
        setOpenAnnotationCount((c) => Math.max(0, c - 1));
      }),
    );

    // Phase 3: pause state. We track the local view of the bus
    // state and surface a small "Paused" chip. The actual pause/
    // resume actions are gated to controller participants.
    offs.push(
      client.on('collab.pause.granted', (msg: WSServerMessage) => {
        const p = msg.payload as WSCollabPauseGranted['payload'];
        if (p.sessionId !== sessionId) return;
        setPaused(true);
      }),
    );
    offs.push(
      client.on('collab.pause.released', (msg: WSServerMessage) => {
        const p = msg.payload as WSCollabPauseReleased['payload'];
        if (p.sessionId !== sessionId) return;
        setPaused(false);
      }),
    );

    return () => {
      for (const off of offs) off();
    };
  }, [client, sessionId]);

  const handleJoin = (role: 'observer' | 'annotator' | 'controller' = 'observer'): void => {
    setError(null);
    client.send({ type: 'collab.join', payload: { sessionId, role } });
    setJoined(true);
    setJoinedRole(role);
  };

  const handleRequestPause = (): void => {
    client.send({ type: 'collab.request_pause', payload: { sessionId } });
  };

  const handleResume = (): void => {
    client.send({ type: 'collab.resume', payload: { sessionId } });
  };

  const handleLeave = (): void => {
    client.send({ type: 'collab.leave', payload: { sessionId } });
    setJoined(false);
    setParticipants([]);
  };

  // Phase 3: a controller promotes another participant to controller.
  const handleGrantControl = (toParticipant: string): void => {
    client.send({ type: 'collab.grant_control', payload: { sessionId, toParticipant } });
  };

  // Phase 4: a controller queues a synthetic result for an in-flight tool call.
  // The server-side collabInjectMiddleware splices it in when the agent makes
  // that tool call. Reason is required by the server; default if left blank.
  const handleInjectTool = (): void => {
    if (!injectToolUseId) return;
    client.send({
      type: 'collab.inject_tool',
      payload: {
        sessionId,
        toolUseId: injectToolUseId,
        content: injectContent,
        isError: injectIsError,
        reason: injectReason.trim() || i18n.t('activity:collab.controllerInjection'),
      },
    });
    setInjectOpen(false);
    setInjectToolUseId('');
    setInjectContent('');
    setInjectIsError(false);
    setInjectReason('');
  };

  const isController = joined && joinedRole === 'controller';

  // Empty state: nobody watching, no errors.
  if (participants.length === 0 && !error) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-md border border-dashed border-border bg-card/40',
          className,
        )}
      >
        <Users className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{t('activity:collab.noObservers')}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleJoin('observer')}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            title={t('activity:collab.observerTitle')}
          >
            <LogIn className="w-3 h-3" />
            {t('activity:collab.observerRole')}
          </button>
          <button
            type="button"
            onClick={() => handleJoin('annotator')}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20 transition-colors"
            title={t('activity:collab.annotatorTitle')}
          >
            <MessageSquareWarning className="w-3 h-3" />
            {t('activity:collab.annotatorRole')}
          </button>
          <button
            type="button"
            onClick={() => handleJoin('controller')}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
            title={t('activity:collab.controllerTitle')}
          >
            <Pause className="w-3 h-3" />
            {t('activity:collab.controllerRole')}
          </button>
        </div>
      </div>
    );
  }

  // Error state: surface server's reason and let user retry.
  if (error) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-md border border-destructive/50 bg-destructive/10',
          className,
        )}
        role="alert"
      >
        <span className="text-xs text-destructive">{t('activity:collab.errorPrefix', { error })}</span>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setJoined(false);
          }}
          className="ml-auto text-xs underline text-destructive"
        >
          {t('activity:collab.dismiss')}
        </button>
      </div>
    );
  }

  // Live state: at least one participant. Show count, live dot, role chips.
  return (
    <div
      className={cn(
        'relative flex items-center gap-2 px-3 py-2 rounded-md border border-success/40 bg-success/5',
        className,
      )}
    >
      <span className="relative flex h-2 w-2" aria-label={t('common:status.live')}>
        <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-75 animate-ping" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
      </span>
      <Users className="w-4 h-4 text-success" />
      <span className="text-xs font-medium text-success">
        {t('activity:collab.observers', { count: participants.length })}
      </span>
      {openAnnotationCount > 0 && (
        <span
          title={t('activity:collab.annotationsTitle', { count: openAnnotationCount })}
          className="ml-2 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30"
        >
          <MessageSquareWarning className="w-3 h-3" />
          {t('activity:collab.notes', { count: openAnnotationCount })}
        </span>
      )}
      {paused && (
        <span
          title={t('activity:collab.pausedTitle')}
          className="ml-2 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive border border-destructive/40"
        >
          <Pause className="w-3 h-3" />
          {t('activity:collab.paused')}
        </span>
      )}
      <div className="flex items-center gap-1 ml-2">
        {participants.slice(0, 3).map((p) => (
          <span
            key={p.participantId}
            title={t('activity:collab.joinedTitle', { time: new Date(p.joinedAt).toLocaleTimeString() })}
            className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success"
          >
            <Eye className="w-3 h-3" />
            {p.role}
            {/* A controller can promote any non-controller participant. */}
            {isController && p.role !== 'controller' && (
              <button
                type="button"
                onClick={() => handleGrantControl(p.participantId)}
                title={t('activity:collab.grantTitle')}
                className="ml-0.5 inline-flex items-center rounded hover:bg-success/20 transition-colors"
              >
                <UserPlus className="w-3 h-3" />
              </button>
            )}
          </span>
        ))}
        {participants.length > 3 && (
          <span className="text-[10px] text-muted-foreground">+{participants.length - 3}</span>
        )}
      </div>
      {isController && (
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setInjectOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-info/40 bg-info/10 text-info hover:bg-info/20 transition-colors"
            title={t('activity:collab.injectTitle')}
          >
            <Syringe className="w-3 h-3" />
            {t('activity:collab.inject')}
          </button>
          {paused ? (
            <button
              type="button"
              onClick={handleResume}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
              title={t('activity:collab.resumeTitle')}
            >
              <Play className="w-3 h-3" />
              {t('activity:collab.resume')}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRequestPause}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-warning/40 bg-warning/10 text-warning hover:bg-warning/20 transition-colors"
              title={t('activity:collab.pauseTitle')}
            >
              <Pause className="w-3 h-3" />
              {t('activity:collab.pauseAgent')}
            </button>
          )}
        </div>
      )}
      {joined && joinedRole !== 'controller' && (
        <button
          type="button"
          onClick={handleLeave}
          className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors"
          title={t('activity:collab.leaveTitle')}
        >
          <LogOut className="w-3 h-3" />
          {t('activity:collab.leave')}
        </button>
      )}

      {/* Phase 4 — controller-only inject-tool form (absolute popover below the bar). */}
      {isController && injectOpen && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50 flex flex-col gap-2 p-3 rounded-md border border-info/40 bg-card shadow-lg text-xs">
          <div className="flex items-center gap-2">
            <Syringe className="w-3.5 h-3.5 text-info" />
            <span className="font-medium">{t('activity:collab.injectToolResult')}</span>
            <button
              type="button"
              onClick={() => setInjectOpen(false)}
              className="ml-auto text-muted-foreground hover:text-foreground"
            >
              {t('activity:collab.close')}
            </button>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t('activity:collab.targetTool')}</span>
            {/* Input + datalist: autocompletes in-flight calls AND accepts any
                tool_use id (pre-queue an injection for a call not yet made). */}
            <input
              list="collab-inject-tools"
              value={injectToolUseId}
              onChange={(e) => setInjectToolUseId(e.target.value)}
              placeholder={t('activity:collab.targetPlaceholder')}
              className="px-2 py-1 rounded border border-border bg-background font-mono"
            />
            <datalist id="collab-inject-tools">
              {pendingTools.map((m) => {
                const snip =
                  m.toolInput === undefined ? '' : ` — ${JSON.stringify(m.toolInput).slice(0, 40)}`;
                return (
                  <option key={m.toolUseId} value={m.toolUseId}>
                    {m.toolName ?? t('activity:collab.toolFallback')}
                    {snip}
                  </option>
                );
              })}
            </datalist>
            {pendingTools.length === 0 && (
              <span className="text-[10px] text-muted-foreground">
                {t('activity:collab.noPendingTools')}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t('activity:collab.resultContent')}</span>
            <textarea
              value={injectContent}
              onChange={(e) => setInjectContent(e.target.value)}
              rows={3}
              placeholder={t('activity:collab.resultPlaceholder')}
              className="px-2 py-1 rounded border border-border bg-background font-mono"
            />
          </label>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={injectIsError}
                onChange={(e) => setInjectIsError(e.target.checked)}
              />
              <span>{t('activity:collab.markError')}</span>
            </label>
            <input
              type="text"
              value={injectReason}
              onChange={(e) => setInjectReason(e.target.value)}
              placeholder={t('activity:collab.reasonPlaceholder')}
              className="flex-1 px-2 py-1 rounded border border-border bg-background"
            />
          </div>
          <button
            type="button"
            onClick={handleInjectTool}
            disabled={!injectToolUseId}
            className="self-end inline-flex items-center gap-1 text-xs px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Syringe className="w-3 h-3" />
            {t('activity:collab.queueInjection')}
          </button>
        </div>
      )}
    </div>
  );
}
