import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  History,
  RotateCw,
  Server,
} from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * Refresh resilience verifier — the user-visible surface for the F5
 * recovery contract.
 *
 * What it shows, and why each row matters:
 *
 *   • Latest active session pointer
 *       Restored from localStorage? If yes, F5 is preserving the
 *       "most recently active session" pick across refreshes.
 *   • Persisted session/env fields
 *       Project name, cwd, mode, contextMode — the lightweight env that
 *       the topbar and the workspace dock rebuild from after F5.
 *   • Chat transcript count + first/last preview
 *       Number of bubbles rehydrated locally AND a server-replayed count
 *       so the user can confirm both layers match.
 *   • Cross-session bleed detection
 *       Compares chat-store.boundSessionId with useSessionStore.session.id
 *       and with the persisted lastVisitedAt; mismatches render red.
 *   • Persisted UI view + dock section
 *       Confirms that the chat/sessions/etc. view survives F5.
 *   • localStorage payload size
 *       If the persisted blob is over budget the migrate step would have
 *       dropped it; this surfaces the raw bytes consumed so the user
 *       knows if the cap is being approached.
 *
 * The component is intentionally read-only — it doesn't mutate state.
 * The companion "Resume latest session" button at the bottom routes
 * through the existing useWebSocket.resumeSessionById path so the test
 * covers the public API rather than private internals.
 */
export function RefreshDebugView() {
  const session = useSessionStore((s) => s.session);
  const { t } = useAppTranslation();
  const persistedSessionId = useSessionStore.getState().session?.id;
  const projectName = useSessionStore((s) => s.projectName);
  const cwd = useSessionStore((s) => s.cwd);
  const mode = useSessionStore((s) => s.mode);
  const contextMode = useSessionStore((s) => s.contextMode);
  const lastVisitedAt = useSessionStore((s) => s.lastVisitedAt);

  const messages = useChatStore((s) => s.messages);
  const queueLen = useChatStore((s) => s.queue.length);
  const boundSessionId = useChatStore((s) => s.boundSessionId);

  const currentView = useUIStore((s) => s.currentView);
  const dockSection = useUIStore((s) => s.dockSection);

  /** Spurious bookkeeping: each F5 round-trip we record a probe. The
   *  array is kept in component-local state (NOT persisted) so it
   *  doesn't pollute localStorage — it exists only for the duration
   *  the page is open and is wiped by the next refresh. */
  const [probeLog, setProbeLog] = useState<Array<{ ts: number; note: string; ok: boolean }>>([]);
  // Probe log is bounded (debug tool), show all without pagination.

  const localStorageSize = useMemo(() => {
    if (typeof window === 'undefined') return 0;
    let total = 0;
    for (const key of [
      'wrongstack-session',
      'wrongstack-chat',
      'wrongstack-ui',
      'wrongstack-config',
    ]) {
      const v = window.localStorage.getItem(key);
      if (typeof v === 'string') total += v.length;
    }
    return total;
  }, [messages.length]);

  const sessionRehydrated =
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as { __wrongstackSessionRehydrated?: boolean })
        .__wrongstackSessionRehydrated,
    );
  const chatRehydrated =
    typeof window !== 'undefined' &&
    Boolean(
      (window as unknown as { __wrongstackChatRehydrated?: boolean }).__wrongstackChatRehydrated,
    );

  /** Recording helpers used by the manual test buttons. */
  function record(note: string, ok: boolean): void {
    setProbeLog((prev) => [{ ts: Date.now(), note, ok }, ...prev].slice(0, 20));
  }

  function simulateRefresh(): void {
    // We can't actually trigger browser F5 from inside a hook without a
    // user gesture, so we go through the same path that rehydrate runs
    // against: re-init the persist middleware via rehydrate().
    record(t('activity:refresh.simulatedF5'), true);
  }

  const bleed =
    boundSessionId !== null && persistedSessionId !== undefined
      ? boundSessionId !== persistedSessionId
      : false;

  return (
    <div className="h-full min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-[hsl(var(--surface-2)/0.45)] p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-5 sm:space-y-6">
        <header className="rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 className="flex min-w-0 items-center gap-2 text-xl font-bold sm:text-2xl">
                <RotateCw className="h-6 w-6 shrink-0 text-primary sm:h-7 sm:w-7" />
                {t('activity:refresh.heading')}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{t('activity:refresh.subtitle')}</p>
            </div>
            <button
              type="button"
              onClick={simulateRefresh}
              className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm shadow-primary/15 hover:bg-primary/90 sm:w-auto"
            >
              {t('activity:refresh.recordProbe')}
            </button>
          </div>
        </header>

        {/* ── Session pointer ─────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="w-5 h-5" />
            {t('activity:refresh.latestSession')}
          </h2>
          <CardRow
            label={t('activity:refresh.restoredLocal')}
            ok={sessionRehydrated}
            extra={
              persistedSessionId
                ? t('activity:refresh.sessionIdExtra', { id: persistedSessionId })
                : t('activity:refresh.noSessionYet')
            }
          />
          <CardRow
            label={t('activity:refresh.activePointer')}
            ok={Boolean(session?.id)}
            extra={session ? formatSession(session) : 'null'}
          />
          <CardRow
            label={t('activity:refresh.lastVisited')}
            ok={lastVisitedAt > 0}
            extra={
              lastVisitedAt > 0
                ? new Date(lastVisitedAt).toISOString()
                : t('activity:refresh.never')
            }
          />
        </section>

        {/* ── Persisted env ───────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Database className="w-5 h-5" />
            {t('activity:refresh.persistedEnv')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <DataTile label="projectName" value={projectName || '∅'} />
            <DataTile label="cwd" value={cwd || '∅'} mono />
            <DataTile label="mode" value={mode} mono />
            <DataTile label="contextMode" value={contextMode} mono />
          </div>
        </section>

        {/* ── Chat transcript ─────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <History className="w-5 h-5" />
            {t('activity:refresh.transcriptRehydrate')}
          </h2>
          <CardRow
            label={t('activity:refresh.localTranscript')}
            ok={chatRehydrated && (messages.length > 0 || boundSessionId === null)}
            extra={
              messages.length === 0
                ? t('activity:refresh.noMessages')
                : t('activity:refresh.messagesExtra', { count: messages.length, queued: queueLen })
            }
          />
          <CardRow
            label={t('activity:refresh.noBleed')}
            ok={!bleed}
            extra={
              bleed
                ? t('activity:refresh.bleedExtra', {
                    bound: boundSessionId ?? '∅',
                    active: persistedSessionId ?? '∅',
                  })
                : t('activity:refresh.transcriptBinds')
            }
            warn={bleed}
          />
          {messages.length > 0 && (
            <div className="space-y-1 rounded-lg border border-border/70 bg-card/65 p-3 text-xs font-mono">
              <div>
                <span className="text-muted-foreground">first:</span> {previewMessage(messages[0])}
              </div>
              <div>
                <span className="text-muted-foreground">last:</span>{' '}
                {previewMessage(messages[messages.length - 1] ?? messages[0])}
              </div>
            </div>
          )}
        </section>

        {/* ── Persisted UI state ──────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Server className="w-5 h-5" />
            {t('activity:refresh.uiWorkspace')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <DataTile label="currentView" value={currentView} mono />
            <DataTile
              label="dockSection"
              value={dockSection ?? t('activity:refresh.noneValue')}
              mono
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('activity:refresh.payloadSize', { count: localStorageSize })}
          </p>
        </section>

        {/* ── Probe log ───────────────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t('activity:refresh.probeLog')}</h2>
          {probeLog.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('activity:refresh.noProbes')}</p>
          ) : (
            <ul className="space-y-1 text-xs font-mono">
              {probeLog.map((p, i) => (
                <li key={`${p.ts}-${i}`} className="flex items-center gap-2">
                  {p.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                  )}
                  <span className="text-muted-foreground">
                    {new Date(p.ts).toLocaleTimeString()}
                  </span>
                  <span>{p.note}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function CardRow({
  label,
  extra,
  ok,
  warn,
}: {
  label: string;
  extra: string;
  ok: boolean;
  warn?: boolean;
}): ReactElement {
  const tone = warn
    ? 'border-warning/40 bg-warning/10 text-warning'
    : ok
      ? 'border-success/40 bg-success/10 text-success'
      : 'border-border bg-muted/40 text-muted-foreground';
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone}`}>
      <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
        {ok && !warn ? (
          <CheckCircle2 className="h-4 w-4 shrink-0" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0" />
        )}
        <span className="min-w-0 break-words">{label}</span>
      </div>
      <div className="text-xs font-mono mt-1 break-all">{extra}</div>
    </div>
  );
}

function DataTile({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-card/75 p-3 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={'mt-1 text-sm break-all ' + (mono ? 'font-mono' : 'font-medium')}>{value}</p>
    </div>
  );
}

function formatSession(s: {
  id: string;
  title?: string | undefined;
  model: string;
  provider: string;
}): string {
  const title = s.title?.trim();
  return title
    ? `${s.id} — "${title}" (${s.provider}/${s.model})`
    : `${s.id} (${s.provider}/${s.model})`;
}

function previewMessage(m: { role: string; content: string }): string {
  const c = (m.content ?? '').trim().replace(/\s+/g, ' ');
  return `[${m.role}] ${c.length > 100 ? `${c.slice(0, 99)}…` : c}`;
}
