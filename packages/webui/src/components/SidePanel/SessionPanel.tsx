/**
 * SessionPanel — the default side panel ("Session" activity).
 *
 * Single home for everything about the current run: quick actions, model,
 * context usage, live stats, the agent's plan, pinned answers, and the
 * handful of settings you actually flip mid-session (autonomy, YOLO,
 * refine, sound). Rarely-touched configuration stays in Settings.
 */

import {
  CheckCircle2,
  Circle,
  CircleDot,
  Cpu,
  Download,
  Eraser,
  History,
  ListTodo,
  Pin,
  Plus,
  Shrink,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pagination } from '@/components/ui/pagination';
import { usePagination } from '@/hooks/usePagination';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { playCompletionChime } from '@/lib/chime';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { getWSClient } from '@/lib/ws-client';
import {
  useChatStore,
  useConfigStore,
  useFleetStore,
  useHistoryStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useSystemPromptStore } from '@/stores/system-prompt-store';
import { fmtTok } from '../ChatView/utils';
import { downloadChatAsMarkdown } from '../CommandPalette';
import { confirmModal } from '../ConfirmModal';

// ── Formatting helpers ────────────────────────────────────────────────

function fmtCost(v: number): string {
  if (v <= 0) return '$0.000';
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function fmtElapsed(ms: number): string {
  if (ms <= 0) return '--';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function _shortSessionId(sessionId: string): string {
  const leaf = sessionId.split('/').pop() ?? sessionId;
  return leaf.length > 18 ? leaf.slice(0, 18) : leaf;
}

// ── Small building blocks ─────────────────────────────────────────────

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  tone,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean | undefined;
  tone?: 'primary' | 'danger' | undefined;
  title?: string | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={cn(
        'flex items-center justify-center gap-1.5 h-8 rounded-md border text-[11px] font-medium transition-colors',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        tone === 'primary'
          ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
          : tone === 'danger'
            ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
            : 'border-border bg-card hover:bg-accent text-foreground/80',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function StatBox({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border/60 bg-card/65 p-2 shadow-sm">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums truncate">{value}</span>
      {sub && <span className="text-[9px] text-muted-foreground/70 truncate">{sub}</span>}
    </div>
  );
}

function SectionHeading({
  icon,
  label,
  right,
}: {
  icon: React.ReactNode;
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-1.5 text-[10px] uppercase text-muted-foreground font-semibold">
        {icon}
        {label}
      </span>
      {right}
    </div>
  );
}

/** Compact switch row sized for the 300px panel. */
function QuickToggle({
  label,
  value,
  onChange,
  title,
}: {
  label: string;
  value: boolean;
  onChange: () => void;
  title?: string | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1" title={title}>
      <span className="text-xs text-foreground/80">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={onChange}
        className={cn(
          'shrink-0 relative inline-flex h-4 w-7 rounded-full border transition-colors',
          value ? 'bg-primary border-primary' : 'bg-muted border-input hover:bg-muted/80',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-2.5 w-2.5 rounded-full bg-background shadow transition-transform',
            value && 'translate-x-3',
          )}
        />
      </button>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────

export function SessionPanel() {
  const { updatePrefs, switchAutonomy } = useWebSocket();
  const { t } = useAppTranslation();
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const soundOnComplete = useConfigStore((s) => s.soundOnComplete);

  const session = useSessionStore((s) => s.session);
  const totalTokens = useSessionStore((s) => s.totalTokens);
  const cost = useSessionStore((s) => s.cost);
  const iteration = useSessionStore((s) => s.iteration);
  const todos = useSessionStore((s) => s.todos);

  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);
  const fleetAgents = useFleetStore((s) => s.agents);

  const pinnedIds = useUIStore((s) => s.pinnedIds);
  const unpinAll = useUIStore((s) => s.unpinAll);
  const historyEntries = useHistoryStore((s) => s.entries);

  const localPrefs = useLocalPrefs();
  // Tracks the last non-'off' autonomy mode so the binary toggle can
  // restore it after a kill-switch. Persisted in module scope so it
  // survives component remounts but resets on a hard page reload.
  const lastAutonomyRef = useRef<typeof localPrefs.autonomy>(
    localPrefs.autonomy === 'off' ? 'auto' : localPrefs.autonomy,
  );
  const syncPref = useCallback(
    (key: string, value: unknown) => {
      localPrefs.set({ [key]: value } as Parameters<typeof localPrefs.set>[0]);
      updatePrefs({ [key]: value });
    },
    [localPrefs, updatePrefs],
  );

  // Elapsed time ticks every second while a session exists — the old
  // sidebar computed Date.now() in render and showed a frozen value.
  const startedAt = session?.startedAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  const runningAgents = useMemo(
    () => Array.from(fleetAgents.values()).filter((a) => a.status === 'running').length,
    [fleetAgents],
  );

  const pinnedRows = pinnedIds
    .map((id) => messages.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m && m.content.length > 0);
  const todoPage = usePagination(todos, 12, session?.id);
  const pinnedPage = usePagination(pinnedRows, 8, session?.id);

  /**
   * Send, addressed at the tab this panel is describing.
   *
   * The panel is one surface over four sessions, so a bare `send` lands on
   * whichever session the server is currently pointing at: Stop aborted
   * another tab's run, Compact compacted another tab's conversation and Clear
   * emptied it.
   */
  const send = (msg: { type: string; payload?: Record<string, unknown> | undefined }) => {
    const client = getWSClient(wsUrl);
    if (!client?.send) return;
    client.send({ ...msg, payload: client.withSession({ ...(msg.payload ?? {}) }) } as Parameters<
      NonNullable<typeof client.send>
    >[0]);
  };

  // Fetch the session list when connected so the History section populates.
  useEffect(() => {
    if (!wsConnected) return;
    getWSClient(wsUrl)?.send?.({ type: 'sessions.list', payload: { limit: 8 } });
  }, [wsConnected, wsUrl]);

  const handleNewSession = useCallback(async () => {
    if (
      isLoading &&
      !(await confirmModal({
        title: t('activity:sessionPanel.actions.newSessionConfirm'),
        message: t('activity:sessionPanel.actions.newSessionConfirmMessage'),
        confirmLabel: t('activity:sessionPanel.actions.newSession'),
        danger: true,
      }))
    ) {
      return;
    }

    // The picker starts the session on confirm — see SystemPromptDialog.
    // Applying the variant first matters: `session.new` keeps the process
    // alive, so the new session inherits whatever prompt is live at that point.
    useSystemPromptStore.getState().openPicker({ startsSession: true });
    // Starting a conversation is a chat-surface action — bring it up.
    showPanel('chat');
  }, [isLoading, t, showPanel]);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-[hsl(var(--surface-2)/0.28)] [scrollbar-gutter:stable]">
      {/* ── Quick actions ── */}
      <div className="grid grid-cols-2 gap-1.5 border-b border-border/70 bg-card/55 px-3 py-2.5">
        {isLoading && (
          <ActionButton
            icon={<Square className="h-3 w-3" />}
            label={t('activity:sessionPanel.actions.abort')}
            tone="danger"
            onClick={() => send({ type: 'abort', payload: {} })}
            disabled={!wsConnected}
          />
        )}
        <ActionButton
          icon={<Plus className="h-3 w-3" />}
          label={t('activity:sessionPanel.actions.newSession')}
          tone="primary"
          onClick={() => void handleNewSession()}
          disabled={!wsConnected}
          title={t('activity:sessionPanel.actions.newSessionTitle')}
        />
        <ActionButton
          icon={<Download className="h-3 w-3" />}
          label={t('activity:sessionPanel.actions.export')}
          onClick={() => downloadChatAsMarkdown()}
          title={t('activity:sessionPanel.actions.exportTitle')}
        />
        <ActionButton
          icon={<Shrink className="h-3 w-3" />}
          label={t('activity:sessionPanel.actions.compact')}
          onClick={() => send({ type: 'context.compact', payload: { aggressive: false } })}
          disabled={!wsConnected}
          title={t('activity:sessionPanel.actions.compactTitle')}
        />
        <ActionButton
          icon={<Eraser className="h-3 w-3" />}
          label={t('common:action.clear')}
          onClick={() => send({ type: 'context.clear' })}
          disabled={!wsConnected}
          title={t('activity:sessionPanel.actions.clearTitle')}
        />
      </div>

      {/* ── Live stats ── */}
      <div className="space-y-1.5 border-b border-border/70 px-3 py-2.5">
        <SectionHeading
          icon={<Cpu className="h-3 w-3" />}
          label={t('activity:sessionPanel.sessionLabel')}
        />
        <div className="grid grid-cols-2 gap-1.5">
          <StatBox label={t('activity:sessionPanel.stats.messages')} value={messages.length} />
          <StatBox
            label={t('activity:sessionPanel.stats.elapsed')}
            value={startedAt ? fmtElapsed(now - startedAt) : '--'}
          />
          <StatBox
            label={t('activity:sessionPanel.stats.tokens')}
            value={fmtTok(totalTokens.input + totalTokens.output)}
            sub={t('activity:sessionPanel.stats.tokensSub', {
              in: fmtTok(totalTokens.input),
              out: fmtTok(totalTokens.output),
            })}
          />
          <StatBox label={t('activity:sessionPanel.stats.cost')} value={fmtCost(cost)} />
          {iteration && (
            <StatBox
              label={t('activity:sessionPanel.stats.iteration')}
              value={iteration.index}
              sub={
                iteration.max
                  ? t('activity:sessionPanel.stats.iterationOf', { max: iteration.max })
                  : undefined
              }
            />
          )}
          {fleetAgents.size > 0 && (
            <StatBox
              label={t('activity:sessionPanel.stats.agents')}
              value={fleetAgents.size}
              sub={
                runningAgents > 0
                  ? t('activity:sessionPanel.stats.agentsRunning', { count: runningAgents })
                  : undefined
              }
            />
          )}
        </div>
      </div>

      {/* ── Plan / todos ── */}
      {todos.length > 0 &&
        (() => {
          const done = todos.filter((t) => t.status === 'completed').length;
          const running = todos.filter((t) => t.status === 'in_progress').length;
          const pct = Math.round((done / todos.length) * 100);
          const allDone = done === todos.length;
          return (
            <div className="space-y-1.5 border-b border-border/70 px-3 py-2.5">
              <SectionHeading
                icon={<ListTodo className="h-3 w-3" />}
                label={t('activity:sessionPanel.plan')}
                right={
                  <span className="tabular-nums text-[10px] text-muted-foreground">
                    {done}/{todos.length}
                  </span>
                }
              />
              <div
                className={cn(
                  'relative h-1.5 w-full overflow-hidden rounded-full bg-muted',
                  running > 0 && 'bar-sweep',
                )}
                title={t('activity:sessionPanel.planComplete', { pct })}
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-500',
                    allDone ? 'bg-success' : 'bg-primary',
                  )}
                  style={{ width: `${Math.max(pct, running > 0 ? 4 : 0)}%` }}
                />
              </div>
              <ul className="space-y-0.5 max-h-56 overflow-y-auto pr-1 -mx-1">
                {todoPage.pageItems.map((t) => {
                  const Icon =
                    t.status === 'completed'
                      ? CheckCircle2
                      : t.status === 'in_progress'
                        ? CircleDot
                        : Circle;
                  const active = t.status === 'in_progress';
                  const tone =
                    t.status === 'completed'
                      ? 'text-success line-through opacity-60'
                      : active
                        ? 'text-foreground'
                        : 'text-muted-foreground';
                  return (
                    <li
                      key={t.id}
                      className={cn(
                        'flex items-start gap-2 text-xs leading-snug rounded-md px-1.5 py-1 transition-colors',
                        active && 'bg-primary/10 ring-1 ring-inset ring-primary/20',
                        tone,
                      )}
                    >
                      <Icon
                        className={cn(
                          'h-3.5 w-3.5 mt-0.5 shrink-0',
                          active && 'text-primary animate-pulse',
                        )}
                      />
                      <span className="break-words">
                        {active && t.activeForm ? t.activeForm : t.content}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <Pagination
                page={todoPage.page}
                pageSize={todoPage.pageSize}
                totalItems={todoPage.totalItems}
                onPageChange={todoPage.setPage}
                compact
                itemLabel="todos"
              />
            </div>
          );
        })()}

      {/* ── Pinned answers ── */}
      {pinnedRows.length > 0 && (
        <div className="space-y-1.5 border-b border-border/70 px-3 py-2.5">
          <SectionHeading
            icon={<Pin className="h-3 w-3 text-warning" />}
            label={t('activity:sessionPanel.pinned')}
            right={
              <button
                type="button"
                onClick={unpinAll}
                className="text-[10px] text-muted-foreground hover:text-destructive"
              >
                {t('common:action.clear')}
              </button>
            }
          />
          <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
            {pinnedPage.pageItems.map((m) => {
              const preview = m.content.replace(/\s+/g, ' ').slice(0, 80);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.querySelector(`[data-message-id="${m.id}"]`);
                      if (!el) return;
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      el.classList.add('ring-2', 'ring-warning/60');
                      setTimeout(() => {
                        el.classList.remove('ring-2', 'ring-warning/60');
                      }, 1600);
                    }}
                    className="w-full text-left text-xs px-2 py-1.5 rounded bg-muted/40 hover:bg-muted/70 border border-warning/20 leading-snug"
                    title={m.content.slice(0, 400)}
                  >
                    {preview}
                    {m.content.length > 80 ? '…' : ''}
                  </button>
                </li>
              );
            })}
          </ul>
          <Pagination
            page={pinnedPage.page}
            pageSize={pinnedPage.pageSize}
            totalItems={pinnedPage.totalItems}
            onPageChange={pinnedPage.setPage}
            compact
            itemLabel="pinned answers"
          />
        </div>
      )}

      {/* ── Quick settings — the mid-session knobs ── */}
      <div className="space-y-1 border-b border-border/70 px-3 py-2.5">
        <SectionHeading
          icon={<SlidersHorizontal className="h-3 w-3" />}
          label={t('activity:sessionPanel.quickSettings')}
        />
        <QuickToggle
          label={t('activity:sessionPanel.autonomy')}
          title={t('activity:sessionPanel.autonomyTitle')}
          value={localPrefs.autonomy !== 'off'}
          onChange={() => {
            const next = localPrefs.autonomy === 'off' ? lastAutonomyRef.current : 'off';
            if (next !== 'off') lastAutonomyRef.current = next;
            localPrefs.set({ autonomy: next });
            switchAutonomy(next);
          }}
        />
        <QuickToggle
          label={t('activity:sessionPanel.yolo')}
          title={t('activity:sessionPanel.yoloTitle')}
          value={localPrefs.yolo}
          onChange={() => syncPref('yolo', !localPrefs.yolo)}
        />
        <QuickToggle
          label={t('activity:sessionPanel.sound')}
          title={t('activity:sessionPanel.soundTitle')}
          value={soundOnComplete}
          onChange={() => {
            const next = !useConfigStore.getState().soundOnComplete;
            useConfigStore.getState().setSoundOnComplete(next);
            if (next) playCompletionChime();
          }}
        />
      </div>

      {/* ── History / recent sessions ── */}
      {(() => {
        const recent = historyEntries.slice(0, 8);
        if (recent.length === 0) return null;
        return (
          <div className="space-y-1 border-b border-border/70 px-3 py-2.5">
            <SectionHeading
              icon={<History className="h-3 w-3" />}
              label={t('activity:nav.history', 'History')}
              right={
                <button
                  type="button"
                  onClick={() => {
                    const ui = useUIStore.getState();
                    ui.setCurrentView('sessions');
                    ui.setSidebarOpen(false);
                  }}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {t('activity:history.openDashboard', 'Open Dashboard')}
                </button>
              }
            />
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {recent.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() =>
                    getWSClient(useConfigStore.getState().wsUrl)?.resumeSession?.(entry.id)
                  }
                  className={cn(
                    'w-full text-left px-2 py-1.5 rounded text-xs leading-snug transition-colors',
                    entry.isCurrent
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-muted/60 text-muted-foreground hover:text-foreground',
                  )}
                >
                  <div className="font-medium truncate">
                    {entry.title || t('chat:empty', 'Untitled')}
                  </div>
                  <div className="text-[10px] text-muted-foreground/70 font-mono truncate">
                    {entry.provider}/{entry.model} · {entry.tokenTotal.toLocaleString()} tok
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
