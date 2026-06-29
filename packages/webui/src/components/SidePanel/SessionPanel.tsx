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
  ListTodo,
  Pin,
  Plus,
  Shrink,
  SlidersHorizontal,
  Square,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { playCompletionChime } from '@/lib/chime';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore, useFleetStore, useSessionStore, useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { fmtTok } from '../ChatView/utils';
import { downloadChatAsMarkdown } from '../CommandPalette';
import { ContextFillBar } from '../ContextBar';
import { ContextBreakdownModal } from '../ContextBreakdownModal';

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

function shortSessionId(sessionId: string): string {
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
    <div className="flex flex-col p-2 rounded-lg bg-muted/40 border border-border/40 min-w-0">
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
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
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
  const { client, updatePrefs, switchAutonomy } = useWebSocket();
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const provider = useConfigStore((s) => s.provider);
  const model = useConfigStore((s) => s.model);
  const soundOnComplete = useConfigStore((s) => s.soundOnComplete);

  const session = useSessionStore((s) => s.session);
  const totalTokens = useSessionStore((s) => s.totalTokens);
  const cost = useSessionStore((s) => s.cost);
  const iteration = useSessionStore((s) => s.iteration);
  const todos = useSessionStore((s) => s.todos);
  const lastInputTokens = useSessionStore((s) => s.lastInputTokens);
  const maxContext = useSessionStore((s) => s.maxContext);

  const messages = useChatStore((s) => s.messages);
  const isLoading = useChatStore((s) => s.isLoading);
  const fleetAgents = useFleetStore((s) => s.agents);

  const pinnedIds = useUIStore((s) => s.pinnedIds);
  const unpinAll = useUIStore((s) => s.unpinAll);
  const setModelSwitcherOpen = useUIStore((s) => s.setModelSwitcherOpen);

  const localPrefs = useLocalPrefs();
  const syncPref = useCallback(
    (key: string, value: unknown) => {
      localPrefs.set({ [key]: value } as Parameters<typeof localPrefs.set>[0]);
      updatePrefs({ [key]: value });
    },
    [localPrefs, updatePrefs],
  );

  const [breakdownOpen, setBreakdownOpen] = useState(false);

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

  // Context fill: cap display at 100%; raw token counts still show overflow.
  const ctxPct =
    maxContext > 0 && lastInputTokens > 0
      ? Math.min(100, Math.round((lastInputTokens / maxContext) * 100))
      : 0;

  const pinnedRows = pinnedIds
    .map((id) => messages.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m && m.content.length > 0);

  const send = (msg: Parameters<NonNullable<ReturnType<typeof getWSClient>>['send']>[0]) =>
    getWSClient(wsUrl)?.send?.(msg);

  return (
    <div className="flex-1 overflow-y-auto">
      {/* ── Quick actions ── */}
      <div className="px-3 py-2.5 border-b grid grid-cols-2 gap-1.5">
        {isLoading ? (
          <ActionButton
            icon={<Square className="h-3 w-3" />}
            label="Abort"
            tone="danger"
            onClick={() => send({ type: 'abort', payload: {} })}
            disabled={!wsConnected}
          />
        ) : (
          <ActionButton
            icon={<Plus className="h-3 w-3" />}
            label="New session"
            tone="primary"
            onClick={() => {
              client?.newSession?.();
              // Starting a conversation is a chat-surface action — bring it up.
              useUIStore.getState().setCurrentView('chat');
            }}
            disabled={!wsConnected}
            title="Start a new session (Ctrl+N)"
          />
        )}
        <ActionButton
          icon={<Download className="h-3 w-3" />}
          label="Export"
          onClick={() => downloadChatAsMarkdown()}
          title="Export chat as markdown (Ctrl+E)"
        />
        <ActionButton
          icon={<Shrink className="h-3 w-3" />}
          label="Compact"
          onClick={() => send({ type: 'context.compact', payload: { aggressive: false } })}
          disabled={!wsConnected}
          title="Compact the context window"
        />
        <ActionButton
          icon={<Eraser className="h-3 w-3" />}
          label="Clear"
          onClick={() => send({ type: 'context.clear' })}
          disabled={!wsConnected}
          title="Clear context (Ctrl+L)"
        />
      </div>

      {/* ── Model chip — opens the quick switcher ── */}
      <button
        type="button"
        onClick={() => setModelSwitcherOpen(true)}
        className="w-full px-4 py-2.5 border-b text-left hover:bg-muted/40 transition-colors"
        title="Change model (Ctrl+M)"
      >
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
          Model
        </div>
        <div className="font-mono text-xs truncate">
          <span className="text-muted-foreground">{provider || '—'}</span>
          <span className="text-muted-foreground/40 mx-1">/</span>
          <span className="font-medium">{model || '—'}</span>
        </div>
      </button>

      {/* ── Context window ── */}
      {maxContext > 0 && (
        <div className="px-4 py-2.5 border-b space-y-1.5">
          <button
            type="button"
            onClick={() => setBreakdownOpen(true)}
            className="w-full block text-left"
            title="Click for a context breakdown"
          >
            <SectionHeading
              icon={null}
              label="Context"
              right={
                <span className="text-[10px] text-muted-foreground tabular-nums font-mono">
                  {fmtTok(lastInputTokens)}/{fmtTok(maxContext)} · {ctxPct}%
                </span>
              }
            />
          </button>
          <button
            type="button"
            onClick={() => setBreakdownOpen(true)}
            className="w-full block"
            title="Click for a context breakdown"
          >
            <ContextFillBar
              pct={ctxPct}
              tokens={lastInputTokens}
              maxTokens={maxContext}
              showTokens={true}
            />
          </button>
        </div>
      )}

      {/* ── Live stats ── */}
      <div className="px-3 py-2.5 border-b space-y-1.5">
        <SectionHeading icon={<Cpu className="h-3 w-3" />} label="Session" />
        <div className="grid grid-cols-2 gap-1.5">
          <StatBox label="Messages" value={messages.length} />
          <StatBox label="Elapsed" value={startedAt ? fmtElapsed(now - startedAt) : '--'} />
          <StatBox
            label="Tokens"
            value={fmtTok(totalTokens.input + totalTokens.output)}
            sub={`${fmtTok(totalTokens.input)} in / ${fmtTok(totalTokens.output)} out`}
          />
          <StatBox label="Cost" value={fmtCost(cost)} />
          {iteration && (
            <StatBox
              label="Iteration"
              value={iteration.index}
              sub={iteration.max ? `of ${iteration.max}` : undefined}
            />
          )}
          {fleetAgents.size > 0 && (
            <StatBox
              label="Agents"
              value={fleetAgents.size}
              sub={runningAgents > 0 ? `${runningAgents} running` : undefined}
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
            <div className="px-3 py-2.5 border-b space-y-1.5">
              <SectionHeading
                icon={<ListTodo className="h-3 w-3" />}
                label="Plan"
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
                title={`${pct}% complete`}
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-500',
                    allDone ? 'bg-[hsl(var(--success))]' : 'bg-primary',
                  )}
                  style={{ width: `${Math.max(pct, running > 0 ? 4 : 0)}%` }}
                />
              </div>
              <ul className="space-y-0.5 max-h-56 overflow-y-auto pr-1 -mx-1">
                {todos.map((t) => {
                  const Icon =
                    t.status === 'completed'
                      ? CheckCircle2
                      : t.status === 'in_progress'
                        ? CircleDot
                        : Circle;
                  const active = t.status === 'in_progress';
                  const tone =
                    t.status === 'completed'
                      ? 'text-[hsl(var(--success))] line-through opacity-60'
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
            </div>
          );
        })()}

      {/* ── Pinned answers ── */}
      {pinnedRows.length > 0 && (
        <div className="px-3 py-2.5 border-b space-y-1.5">
          <SectionHeading
            icon={<Pin className="h-3 w-3 text-amber-500" />}
            label="Pinned"
            right={
              <button
                type="button"
                onClick={unpinAll}
                className="text-[10px] text-muted-foreground hover:text-destructive"
              >
                Clear
              </button>
            }
          />
          <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
            {pinnedRows.map((m) => {
              const preview = m.content.replace(/\s+/g, ' ').slice(0, 80);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      const el = document.querySelector(`[data-message-id="${m.id}"]`);
                      if (!el) return;
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      el.classList.add('ring-2', 'ring-amber-500/60');
                      setTimeout(() => {
                        el.classList.remove('ring-2', 'ring-amber-500/60');
                      }, 1600);
                    }}
                    className="w-full text-left text-xs px-2 py-1.5 rounded bg-muted/40 hover:bg-muted/70 border border-amber-500/20 leading-snug"
                    title={m.content.slice(0, 400)}
                  >
                    {preview}
                    {m.content.length > 80 ? '…' : ''}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── Quick settings — the mid-session knobs ── */}
      <div className="px-3 py-2.5 border-b space-y-1">
        <SectionHeading icon={<SlidersHorizontal className="h-3 w-3" />} label="Quick settings" />
        <div className="flex items-center justify-between gap-2 py-1">
          <span className="text-xs text-foreground/80">Autonomy</span>
          <select
            value={localPrefs.autonomy}
            onChange={(e) => {
              const v = e.target.value as typeof localPrefs.autonomy;
              localPrefs.set({ autonomy: v });
              switchAutonomy(v);
            }}
            className="shrink-0 h-6 max-w-[150px] rounded-md border bg-background px-1.5 text-[11px]"
          >
            <option value="off">Off</option>
            <option value="suggest">Suggest</option>
            <option value="auto">Auto</option>
            <option value="eternal">Eternal</option>
            <option value="eternal-parallel">Eternal Parallel</option>
          </select>
        </div>
        <QuickToggle
          label="YOLO mode"
          title="Bypass tool confirmation prompts"
          value={localPrefs.yolo}
          onChange={() => syncPref('yolo', !localPrefs.yolo)}
        />
        <QuickToggle
          label="Refine prompts"
          title="Rewrite prompts before sending"
          value={localPrefs.enhanceEnabled}
          onChange={() => syncPref('enhanceEnabled', !localPrefs.enhanceEnabled)}
        />
        <QuickToggle
          label="Sound on completion"
          title="Play a soft chime when a run finishes"
          value={soundOnComplete}
          onChange={() => {
            const next = !useConfigStore.getState().soundOnComplete;
            useConfigStore.getState().setSoundOnComplete(next);
            if (next) playCompletionChime();
          }}
        />
      </div>

      {/* ── Connection footer ── */}
      <div className="px-4 py-2.5">
        <div
          className={cn(
            'flex items-center gap-2 text-[11px]',
            wsConnected ? 'text-[hsl(var(--success))]' : 'text-[hsl(var(--warning))]',
          )}
        >
          {wsConnected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          <span className="font-medium">{wsConnected ? 'Connected' : 'Disconnected'}</span>
          <span className="text-muted-foreground font-mono truncate ml-auto" title={wsUrl}>
            {wsUrl}
          </span>
        </div>
        {session && (
          <div
            className="text-[10px] text-muted-foreground font-mono mt-1 truncate"
            title={session.id}
          >
            session {shortSessionId(session.id)}
          </div>
        )}
      </div>

      <ContextBreakdownModal open={breakdownOpen} onClose={() => setBreakdownOpen(false)} />
    </div>
  );
}
