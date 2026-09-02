/**
 * SessionWatchPanel — read-only live view of another process's session.
 *
 * Given a sessionId (a TUI / REPL / WebUI running in the same project), it polls
 * `GET /api/sessions/:id/events` and renders that session's conversation + tool
 * stream, so you can *watch* what another client is doing from the Fleet HQ map
 * without attaching to it. Auto-scrolls while pinned to the bottom; re-fetches
 * every few seconds to tail new activity.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppTranslation, i18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useMonitorStore } from '@/stores/monitor-store';
import { WatchMessageBubble } from './WatchMessageBubble.js';
import { Bot } from 'lucide-react';

interface WatchEntry {
  ts: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  text: string;
  tool?: string;
  /** Structured tool input (object — rendered by ToolInputView). */
  input?: unknown;
  /** Structured tool output (rendered as full text / markdown). */
  output?: unknown;
  /** Wall-clock duration in ms. */
  durationMs?: number;
  /** Whether the tool/response had an error. */
  isError?: boolean;
  /** Tool use correlation id. */
  toolUseId?: string;
}

interface WatchResponse {
  sessionId: string;
  status: string;
  clientType?: string;
  projectName?: string;
  total: number;
  entries: WatchEntry[];
}

/** A message in the human↔leader mailbox thread (read-receipts + replies). */
interface ThreadMsg {
  id: string;
  from: string;
  to: string;
  type: string;
  subject: string;
  body: string;
  priority: string;
  readByLeader: string | null;
  readByCount: number;
  completed: boolean;
  outcome: string | null;
  timestamp: string;
  fromLeader: boolean;
}

type MsgType = 'steer' | 'ask' | 'assign' | 'note';
const MSG_TYPES: MsgType[] = ['steer', 'ask', 'assign', 'note'];

const POLL_MS = 2500;

export function SessionWatchPanel({
  sessionId,
  limit = 200,
}: {
  sessionId: string;
  /** How many trailing events to request. The compact node popover uses the
   *  default; the expanded drawer asks for the server max (500) to show the
   *  agent's full operation history. */
  limit?: number;
}) {
  const [data, setData] = useState<WatchResponse | null>(null);
  const { t } = useAppTranslation();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<MsgType>('steer');
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('high');
  const [thread, setThread] = useState<ThreadMsg[]>([]);
  const [interrupting, setInterrupting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const aliveRef = useRef(true);

  // Registry-derived activity fingerprint for THIS session. It changes only
  // when this session's status or its agents' tool/iteration counters move, so
  // we can refetch the stream the instant the watched process advances
  // (~150ms via the registry watch) instead of waiting on the fallback timer.
  const liveSessions = useMonitorStore((s) => s.liveSessions);
  const targetSession = useMemo(
    () => liveSessions.find((x) => x.sessionId === sessionId),
    [liveSessions, sessionId],
  );
  const activitySig = useMemo(() => {
    const s = targetSession;
    if (!s) return '';
    return `${s.status}|${s.agents
      .map((a) => `${a.id}:${a.status}:${a.toolCalls ?? 0}:${a.iterations ?? 0}`)
      .join(',')}`;
  }, [targetSession]);

  // Real-time "what is it doing right now", straight from the registry snapshot
  // — fresher than the JSONL (which only lands a line per completed step).
  const isRunning =
    targetSession?.status === 'active' ||
    (targetSession?.agents.some((a) => a.status === 'running' || a.status === 'streaming') ??
      false);
  const nowDoing = useMemo(() => {
    if (!targetSession) return null;
    const busy = targetSession.agents.find(
      (a) => a.status === 'running' || a.status === 'streaming',
    );
    if (busy?.currentTool) return `🔧 ${busy.currentTool}`;
    if (busy) return t('activity:sessionWatch.working', { name: busy.name ?? busy.id });
    return null;
  }, [targetSession, t]);

  // Live assistant text streaming in right now (the registry's throttled tail),
  // shown below the finished JSONL turns until the completed turn lands. Carries
  // the agent's name so a streaming subagent is distinguishable from the leader.
  const livePartial = useMemo(() => {
    if (!targetSession) return null;
    const a =
      targetSession.agents.find(
        (x) => x.partialText && (x.status === 'streaming' || x.status === 'running'),
      ) ?? targetSession.agents.find((x) => x.partialText);
    if (!a?.partialText) return null;
    const label = a.id === 'leader' ? t('activity:sessionWatch.claude') : a.name || a.id;
    return { label, text: a.partialText };
  }, [targetSession, t]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/events?limit=${limit}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as WatchResponse;
      if (aliveRef.current) {
        setData(json);
        setError(null);
      }
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, limit]);

  // Poll the human↔leader mailbox thread so read-receipts (✓ leader read it)
  // and the agent's replies surface — the visible half of two-way control.
  const loadThread = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/mailbox`);
      if (!res.ok) return;
      const json = (await res.json()) as { thread?: ThreadMsg[] };
      if (aliveRef.current && Array.isArray(json.thread)) setThread(json.thread);
    } catch {
      /* best-effort — thread is supplementary */
    }
  }, [sessionId]);

  // Reset on session change + a slow fallback poll (covers idle sessions and
  // any registry-write the activity fingerprint can't see).
  useEffect(() => {
    aliveRef.current = true;
    setData(null);
    setError(null);
    setThread([]);
    void load();
    void loadThread();
    // One shared interval (not two) and no polling while the tab is hidden —
    // a watch panel per watched session adds up fast in the office map.
    const iv = setInterval(() => {
      if (document.hidden) return;
      void load();
      void loadThread();
    }, POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(iv);
    };
  }, [load, loadThread]);

  // Event-driven: refetch the moment the watched session advances.
  useEffect(() => {
    if (activitySig) void load();
  }, [activitySig, load]);

  // Auto-scroll to the newest line while the user is pinned to the bottom.
  useEffect(() => {
    if (stickRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data, livePartial]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSent(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, type: msgType, priority }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDraft('');
      setSent(
        isRunning
          ? i18n.t('activity:sessionWatch.sentRunning')
          : i18n.t('activity:sessionWatch.sentIdle'),
      );
      void loadThread();
    } catch (e) {
      setSent(
        i18n.t('activity:sessionWatch.sentFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSending(false);
    }
  };

  // Cooperative interrupt — drops a control message; the target halts at its
  // next iteration boundary (not a process kill).
  const interrupt = async () => {
    if (interrupting) return;
    setInterrupting(true);
    setSent(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: i18n.t('activity:sessionWatch.interruptReason') }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSent(i18n.t('activity:sessionWatch.interruptSent'));
      void loadThread();
    } catch (e) {
      setSent(
        i18n.t('activity:sessionWatch.interruptFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setInterrupting(false);
    }
  };

  const entries = data?.entries ?? [];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between mb-1.5 shrink-0">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              isRunning ? 'bg-success animate-pulse' : 'bg-muted-foreground',
            )}
          />
          {t('activity:sessionWatch.liveStream')}
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <div className="text-[10px] text-muted-foreground">
              {t('activity:sessionWatch.events', { count: data.total })} · {data.status}
            </div>
          )}
          {isRunning && (
            <button
              type="button"
              onClick={() => void interrupt()}
              disabled={interrupting}
              title={t('activity:sessionWatch.interruptTitle')}
              className="rounded border border-destructive/40 bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/25 disabled:opacity-40 transition-colors"
            >
              {interrupting
                ? t('activity:sessionWatch.interrupting')
                : t('activity:sessionWatch.interrupt')}
            </button>
          )}
        </div>
      </div>
      {nowDoing && (
        <div className="mb-1.5 shrink-0 text-[10px] text-foreground truncate">▶ {nowDoing}</div>
      )}
      {error && <div className="text-[11px] text-destructive mb-1 shrink-0">· {error}</div>}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain space-y-1.5 pr-1"
      >
        {entries.length === 0 && !error && (
          <div className="text-[11px] text-muted-foreground italic">
            {t('activity:sessionWatch.loading')}
          </div>
        )}
        {entries.map((e, i) => (
          <WatchMessageBubble
            key={`${e.ts}-${i}`}
            entry={e}
            isContinuation={i > 0 && entries[i - 1].role === e.role}
          />
        ))}
        {livePartial && (
          <div className="flex gap-3 animate-message">
            <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-accent text-accent-foreground ring-2 ring-offset-2 ring-offset-background ring-accent/20">
              <Bot className="h-4 w-4 animate-pulse" />
            </div>
            <div className="flex flex-col gap-1.5 max-w-[85%] min-w-0">
              <span className="text-xs font-medium text-muted-foreground px-1">
                {livePartial.label}
              </span>
              <div className="rounded-2xl rounded-bl-md px-4 py-3 bg-card border border-border">
                <span className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                  {livePartial.text}
                  <span className="animate-pulse text-primary">▋</span>
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Thread — the two-way loop made visible: what you sent + read-receipts
          + the agent's replies. Last few only, oldest→newest. */}
      {thread.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border shrink-0 max-h-28 overflow-y-auto space-y-1">
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">
            {t('activity:mailbox.messages')}
          </div>
          {thread.slice(-6).map((m) => {
            const status = m.completed
              ? t('activity:sessionWatch.done')
              : m.readByLeader
                ? t('activity:sessionWatch.read')
                : t('activity:sessionWatch.delivered');
            return (
              <div key={m.id} className="text-[10px] leading-snug">
                <span
                  className={cn(
                    'font-semibold mr-1.5',
                    m.fromLeader ? 'text-accent' : 'text-primary',
                  )}
                >
                  {m.fromLeader ? t('activity:sessionWatch.agent') : t('activity:sessionWatch.you')}
                </span>
                <span className="text-foreground whitespace-pre-wrap break-words">{m.body}</span>
                {!m.fromLeader && (
                  <span
                    className={cn(
                      'ml-1.5 text-[9px]',
                      m.completed
                        ? 'text-success'
                        : m.readByLeader
                          ? 'text-primary'
                          : 'text-muted-foreground',
                    )}
                  >
                    {status}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Composer — steer this session from here (two-way). */}
      <div className="mt-2 pt-2 border-t border-border shrink-0">
        <div className="mb-1 flex items-center gap-1.5">
          <select
            value={msgType}
            onChange={(ev) => setMsgType(ev.target.value as MsgType)}
            title={t(`activity:sessionWatch.msgType.${msgType}Hint`)}
            className="rounded bg-muted border border-border px-1.5 py-0.5 text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {MSG_TYPES.map((mt) => (
              <option key={mt} value={mt}>
                {t(`activity:sessionWatch.msgType.${mt}Label`)}
              </option>
            ))}
          </select>
          <select
            value={priority}
            onChange={(ev) => setPriority(ev.target.value as 'low' | 'normal' | 'high')}
            title={t('activity:sessionWatch.priority')}
            className="rounded bg-muted border border-border px-1.5 py-0.5 text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="high">high</option>
            <option value="normal">normal</option>
            <option value="low">low</option>
          </select>
        </div>
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={t('activity:sessionWatch.placeholder', {
              label: t(`activity:sessionWatch.msgType.${msgType}Label`),
            })}
            className="flex-1 resize-none rounded-md bg-muted border border-border px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !draft.trim()}
            className="shrink-0 rounded-md bg-primary text-primary-foreground px-2.5 py-1.5 text-xs hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? '…' : t('activity:sessionWatch.send')}
          </button>
        </div>
        {sent && <div className="mt-1 text-[10px] text-muted-foreground">{sent}</div>}
        <div className="mt-0.5 text-[9px] text-muted-foreground">
          {t('activity:sessionWatch.sendHint')}
        </div>
      </div>
    </div>
  );
}
