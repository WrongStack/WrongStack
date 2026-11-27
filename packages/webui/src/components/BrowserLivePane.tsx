/**
 * BrowserLivePane — watch the agent's browser (WorkspaceDock → Browser).
 *
 * The picture is the page's CDP screencast, which updates when the page
 * changes; beside it the URL, title, and the session's recent console and
 * network entries. Picking reads element context without sending page input. Watching starts
 * when the pane opens and stops when it closes.
 */

import type { BrowserElementSelection as Selection } from '@wrongstack/webui-protocol';
import { Globe, MonitorPlay } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type LiveBrowserSession, useLiveBrowserSessions } from '@/hooks/use-live-browser';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { agentBelongsToSession } from '@/lib/agent-session';
import { presentedBrowserId } from '@/lib/artifact-presentation';
import { cn, safeId } from '@/lib/utils';
import { useActiveSessionId, useConfigStore } from '@/stores';
import { BrowserElementSelection } from './BrowserElementSelection.js';

interface Frame {
  id: string;
  data: string;
  width: number;
  height: number;
}

interface Details {
  id: string;
  url?: string | undefined;
  title?: string | undefined;
  console?: Array<{ level: string; text: string; at: string }> | undefined;
  network?:
    | Array<{ method: string; url: string; status?: number; failed?: boolean; at: string }>
    | undefined;
  gone?: boolean | undefined;
}

/** ARIA tablist keyboard map: arrows wrap, Home/End jump, focus follows selection. */
function handleTabKeyDown(
  event: React.KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  onSelect: (index: number) => void,
): void {
  let next: number | undefined;
  if (event.key === 'ArrowRight') next = (index + 1) % count;
  if (event.key === 'ArrowLeft') next = (index - 1 + count) % count;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = count - 1;
  if (next === undefined) return;

  event.preventDefault();
  onSelect(next);
  event.currentTarget.parentElement
    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    [next]?.focus();
}

export function BrowserLivePane(): React.ReactElement {
  const { t } = useAppTranslation();
  const sessions = useLiveBrowserSessions();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const sessionId = useActiveSessionId();
  useEffect(() => {
    setSelectedId(presentedBrowserId(sessionId));
    const select = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; id: string }>).detail;
      if (detail?.sessionId === sessionId) setSelectedId(detail.id);
    };
    window.addEventListener('wrongstack:present-browser', select);
    return () => window.removeEventListener('wrongstack:present-browser', select);
  }, [sessionId]);
  const selected: LiveBrowserSession | undefined =
    sessions.find((s) => s.id === selectedId) ?? sessions[0];

  if (!selected) {
    return (
      <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {t('activity:browserLive.none')}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {sessions.length > 1 ? (
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {sessions.map((s, index) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === selected.id}
              tabIndex={s.id === selected.id ? 0 : -1}
              onClick={() => setSelectedId(s.id)}
              onKeyDown={(event) =>
                handleTabKeyDown(event, index, sessions.length, (next) =>
                  setSelectedId(sessions[next]?.id),
                )
              }
              className={cn(
                'max-w-[14rem] truncate rounded-md border px-2 py-0.5 text-[11px]',
                s.id === selected.id
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {s.title || s.url}
            </button>
          ))}
        </div>
      ) : null}
      <LiveView key={`${sessionId ?? 'none'}:${selected.id}`} session={selected} />
    </div>
  );
}

function LiveView({ session }: { session: LiveBrowserSession }): React.ReactElement {
  const { t } = useAppTranslation();
  const ws = useWebSocket();
  const sessionId = useActiveSessionId();
  const connected = useConfigStore((state) => state.wsConnected);
  const [frame, setFrame] = useState<Frame | undefined>();
  const [details, setDetails] = useState<Details | undefined>();
  const [tab, setTab] = useState<'console' | 'network'>('console');
  const [picking, setPicking] = useState(false);
  const [pending, setPending] = useState(false);
  const [selection, setSelection] = useState<Selection>();
  const [pickError, setPickError] = useState('');
  const requestId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (connected) return;
    requestId.current = undefined;
    setFrame(undefined);
    setDetails(undefined);
    setSelection(undefined);
    setPending(false);
    setPicking(false);
  }, [connected]);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      requestId.current = undefined;
      setPending(false);
      setPickError(t('activity:browserLive.inspectionTimeout'));
    }, 90_000);
    return () => clearTimeout(timer);
  }, [pending, t]);

  useEffect(() => {
    setFrame(undefined);
    setDetails(undefined);
    setSelection(undefined);
    setPending(false);
    setPicking(false);
    if (!ws.client?.isConnected) return;
    const mine = (payload: { id?: string; sessionId?: string } | undefined) =>
      payload?.id === session.id && agentBelongsToSession(payload.sessionId, sessionId);
    const offFrame = ws.client.on?.('browser.live.frame', (msg: unknown) => {
      const payload = (msg as { payload?: Frame & { sessionId?: string } }).payload;
      if (payload && mine(payload)) setFrame(payload);
    });
    const offDetails = ws.client.on?.('browser.live.details', (msg: unknown) => {
      const payload = (msg as { payload?: Details & { sessionId?: string } }).payload;
      if (payload && mine(payload)) setDetails(payload);
    });
    const offSelection = ws.client.on?.('browser.live.selection', (msg: unknown) => {
      const payload = (
        msg as {
          payload?: {
            id: string;
            sessionId?: string;
            requestId: string;
            selection?: Selection;
            error?: string;
          };
        }
      ).payload;
      if (!payload || !mine(payload) || payload.requestId !== requestId.current) return;
      requestId.current = undefined;
      setPending(false);
      setSelection(payload.selection);
      setPickError(payload.error ?? '');
    });
    const watch = { id: session.id };
    ws.client.send?.({
      type: 'browser.live.watch',
      payload: ws.client.withSession?.(watch) ?? (sessionId ? { ...watch, sessionId } : watch),
    });
    return () => {
      offFrame?.();
      offDetails?.();
      offSelection?.();
      requestId.current = undefined;
      if (ws.client.isConnected)
        ws.client.send?.({
          type: 'browser.live.unwatch',
          payload: ws.client.withSession?.({}) ?? (sessionId ? { sessionId } : {}),
        });
    };
  }, [session.id, ws.client, sessionId]);

  const url = details?.url ?? session.url;
  const consoleEntries = details?.console ?? [];
  const networkEntries = details?.network ?? [];

  return (
    <div className="space-y-2" data-testid="browser-live-pane">
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs">
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono" title={url}>
          {url}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('activity:browserLive.readOnly')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          aria-pressed={picking}
          disabled={!connected || !sessionId || !frame || details?.gone || pending}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && picking) {
              event.preventDefault();
              event.stopPropagation();
              setPicking(false);
            }
          }}
          className="rounded border border-border px-2 py-1 disabled:opacity-50"
          onClick={() => {
            setPicking(!picking);
            setPickError('');
          }}
        >
          {pending ? t('activity:browserLive.inspecting') : t('activity:browserLive.pickElement')}
        </button>
        {picking && (
          <span className="text-muted-foreground">{t('activity:browserLive.pickHint')}</span>
        )}
      </div>
      <div className="relative overflow-hidden rounded-md border border-border/60 bg-black/80">
        {picking && frame && !details?.gone && (
          <button
            type="button"
            aria-label={t('activity:browserLive.pickPoint')}
            className="absolute inset-0 z-10 cursor-crosshair outline-2 outline-primary focus:outline"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setPicking(false);
              }
            }}
            onClick={(event) => {
              if (!sessionId) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const x = event.detail === 0 ? 0.5 : (event.clientX - bounds.left) / bounds.width;
              const y = event.detail === 0 ? 0.5 : (event.clientY - bounds.top) / bounds.height;
              const token = safeId();
              requestId.current = token;
              setPicking(false);
              setPending(true);
              setSelection(undefined);
              const payload = {
                id: session.id,
                requestId: token,
                x: Math.max(0, Math.min(1, x)),
                y: Math.max(0, Math.min(1, y)),
                url,
              };
              if (
                ws.client?.send?.({
                  type: 'browser.live.pick',
                  payload: { ...payload, sessionId },
                }) === false
              ) {
                requestId.current = undefined;
                setPending(false);
                setPickError(t('activity:browserLive.inspectionTimeout'));
              }
            }}
          />
        )}
        {details?.gone ? (
          <div className="flex aspect-[16/10] items-center justify-center text-xs text-muted-foreground">
            {t('activity:browserLive.closed')}
          </div>
        ) : frame ? (
          <img
            src={`data:image/jpeg;base64,${frame.data}`}
            width={frame.width}
            height={frame.height}
            alt={details?.title || session.title || url}
            className="block h-auto w-full"
          />
        ) : (
          <div className="flex aspect-[16/10] items-center justify-center gap-2 text-xs text-muted-foreground">
            <MonitorPlay className="h-4 w-4 animate-pulse" />
            {t('activity:browserLive.waiting')}
          </div>
        )}
      </div>
      {pickError && (
        <p role="alert" className="text-xs text-destructive">
          {pickError}
        </p>
      )}
      {selection && selection.url === url && <BrowserElementSelection selection={selection} />}
      <div className="rounded-md border border-border/60 text-xs">
        <div className="flex gap-1 border-b border-border/40 px-1.5 py-1" role="tablist">
          {(['console', 'network'] as const).map((name, index) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => setTab(name)}
              onKeyDown={(event) =>
                handleTabKeyDown(event, index, 2, (next) =>
                  setTab(next === 0 ? 'console' : 'network'),
                )
              }
              className={cn(
                'rounded px-2 py-0.5',
                tab === name ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
              )}
            >
              {t(`activity:browserLive.${name}`)}{' '}
              <span className="tabular-nums opacity-70">
                {name === 'console' ? consoleEntries.length : networkEntries.length}
              </span>
            </button>
          ))}
        </div>
        <ul className="max-h-48 overflow-auto px-2 py-1 font-mono text-[11px] leading-snug">
          {tab === 'console' ? (
            consoleEntries.length === 0 ? (
              <li className="text-muted-foreground">{t('activity:browserLive.noConsole')}</li>
            ) : (
              consoleEntries.map((entry, i) => (
                <li
                  key={i}
                  className={cn(
                    'whitespace-pre-wrap break-all',
                    entry.level === 'error' && 'text-destructive',
                    entry.level === 'warning' && 'text-warning',
                  )}
                >
                  <span className="text-muted-foreground">{entry.level} </span>
                  {entry.text}
                </li>
              ))
            )
          ) : networkEntries.length === 0 ? (
            <li className="text-muted-foreground">{t('activity:browserLive.noNetwork')}</li>
          ) : (
            networkEntries.map((entry, i) => (
              <li
                key={i}
                className={cn('truncate', entry.failed && 'text-destructive')}
                title={entry.url}
              >
                <span className="text-muted-foreground">{entry.method} </span>
                <span className="tabular-nums">{entry.failed ? '✕' : entry.status}</span>{' '}
                {entry.url}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
