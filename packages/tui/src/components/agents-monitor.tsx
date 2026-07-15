import { Box, Text, useInput, useStdout } from '../ink.js';
import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type { AgentTimelineEntry } from '@wrongstack/core/coordination';
import type { FleetEntry } from '../app.js';
import type { HistoryEntry } from './history/types.js';
import { theme } from '../theme.js';
import { fmtModelLabel } from './fleet-monitor.js';
import { fmtElapsed } from './status-bar.js';
import { getToolVisual } from '../tool-glyph.js';
import { glyphs } from '../ui-glyphs.js';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
} from './monitor-shell.js';

// ─── Types & Interfaces ───────────────────────────────────────────────

/**
 * Narrow read-only view of per-subagent transcripts. AgentMonitorService
 * (created in the CLI host) satisfies this structurally; the TUI never
 * imports from @wrongstack/cli. `getTranscript` returns entries NEWEST
 * FIRST (mirroring AgentMonitorService.getTranscript).
 */
export interface AgentTranscriptReader {
  getTranscript(subagentId: string, limit?: number): AgentTimelineEntry[];
}

export interface AgentsMonitorProps {
  entries: Record<string, FleetEntry>;
  totalCost: number;
  leaderCost?: number | undefined;
  totalTokens?: { input: number; output: number };
  nowTick: number;
  onClose?: (() => void) | undefined;
  transcripts?: AgentTranscriptReader | undefined;
  leaderTranscript?: (() => AgentTimelineEntry[]) | undefined;
  fullscreen?: boolean | undefined;
}

// ─── Constants ────────────────────────────────────────────────────────

const STATUS: Record<FleetEntry['status'], { icon: string; color: string }> = {
  idle: { icon: '○', color: theme.textMuted },
  running: { icon: '▶', color: theme.warn },
  success: { icon: '✓', color: theme.success },
  failed: { icon: '✗', color: theme.error },
  timeout: { icon: '⏱', color: theme.warn },
  stopped: { icon: '⊘', color: theme.textMuted },
};

/** Retained for callers/tests that tune the empty-state grace window. */
export const IDLE_HIDE_MS = 60_000;
export const EMPTY_AGENTS_CLOSE_DELAY_MS = 7_500;

/** Fallback rows of transcript content when terminal height is unknown. */
export const TRANSCRIPT_ROWS = 10;

/** Full in-memory transcript depth to fetch (AgentMonitorService ring size). */
export const TRANSCRIPT_FETCH_LIMIT = 500;

// ─── Pure Helpers ─────────────────────────────────────────────────────

function isLeaderEntry(entry: FleetEntry): boolean {
  return entry.id === 'leader' || entry.name === 'LEADER';
}

/**
 * Select the agents the live monitor should render. Only actively-running
 * subagents are detail-worthy; idle workers are retained by the coordinator for
 * reuse but should not keep the TUI crowded after their task closes. LEADER
 * stays visible while a subagent is running (or while LEADER itself is running)
 * so F3 always has a detail card fallback.
 */
export function selectLiveAgents(
  all: FleetEntry[],
  _now: number,
  _idleHideMs: number = IDLE_HIDE_MS,
): FleetEntry[] {
  const leader = all.find(isLeaderEntry);
  const activeSubagents = all.filter(
    (entry) => !isLeaderEntry(entry) && entry.status === 'running',
  );
  const showLeader =
    leader !== undefined && (leader.status !== 'idle' || activeSubagents.length > 0);
  return all.filter((entry) =>
    isLeaderEntry(entry) ? showLeader : activeSubagents.some((active) => active.id === entry.id),
  );
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtExactTokens(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} tok`;
}

function snippet(s: string, max = 72): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function fmtShortDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function fmtSignedTokens(n: number): string {
  return n <= 0 ? '0' : fmtTokens(n);
}

export function formatContextRunway(tokens?: number, maxTokens?: number): string {
  if (!tokens || !maxTokens || maxTokens <= 0) return 'ctx unknown';
  const left = Math.max(0, maxTokens - tokens);
  return `${fmtTokens(tokens)}/${fmtTokens(maxTokens)} · ${fmtSignedTokens(left)} free`;
}

export function formatRecentToolChip(tool: FleetEntry['recentTools'][number]): string {
  const status = tool.ok === false ? '✗' : '✓';
  const duration =
    typeof tool.durationMs === 'number' ? ` ${fmtShortDuration(tool.durationMs)}` : '';
  const lines =
    typeof tool.outputLines === 'number' && tool.outputLines > 0 ? ` ${tool.outputLines}L` : '';
  const bytes =
    typeof tool.outputBytes === 'number' && tool.outputBytes > 0
      ? ` ${fmtTokens(tool.outputBytes)}B`
      : '';
  return `${status} ${tool.name}${duration}${lines}${bytes}`;
}

export function formatAgentDetailHeader(entry: FleetEntry): string {
  return entry.name || entry.id;
}

export function agentRisk(
  entry: FleetEntry,
): 'calm' | 'busy' | 'hot' | 'critical' {
  const pct = entry.ctxPct ?? 0;
  if (entry.budgetWarning || entry.failureReason || pct >= 0.9) return 'critical';
  if (pct >= 0.75 || (entry.extensions ?? 0) > 0) return 'hot';
  if (entry.status === 'running' || pct >= 0.55) return 'busy';
  return 'calm';
}

function riskMeta(risk: ReturnType<typeof agentRisk>): {
  icon: string;
  color: string;
  label: string;
} {
  switch (risk) {
    case 'critical':
      return { icon: '◆', color: theme.error, label: 'critical' };
    case 'hot':
      return { icon: '▲', color: theme.warn, label: 'hot' };
    case 'busy':
      return { icon: '●', color: theme.accent, label: 'busy' };
    case 'calm':
      return { icon: '○', color: theme.success, label: 'calm' };
  }
}

function currentAction(entry: FleetEntry, now: number): string {
  if (entry.currentTool)
    return `→ ${entry.currentTool.name} ${fmtShortDuration(now - entry.currentTool.startedAt)}`;
  if (entry.status === 'running') return 'thinking';
  const last = entry.recentTools[entry.recentTools.length - 1];
  if (last) return `last ${last.name}`;
  const msg = entry.recentMessages[entry.recentMessages.length - 1];
  if (msg) return `msg ${snippet(msg.text, 34)}`;
  return 'standing by';
}

export function selectAgentDetail(
  live: FleetEntry[],
  selectedId?: string,
): FleetEntry | undefined {
  return live.find((entry) => entry.id === selectedId) ?? live.find(isLeaderEntry) ?? live[0];
}

export function nextEmptyAgentsCloseStartedAt(
  liveCount: number,
  now: number,
  currentStartedAt?: number,
): number | undefined {
  if (liveCount > 0) return undefined;
  return currentStartedAt ?? now;
}

export function shouldCloseEmptyAgentsMonitor(
  liveCount: number,
  now: number,
  emptyStartedAt: number | undefined,
  delayMs = EMPTY_AGENTS_CLOSE_DELAY_MS,
): boolean {
  return liveCount === 0 && emptyStartedAt !== undefined && now - emptyStartedAt >= delayMs;
}

function selectHotAgent(entries: FleetEntry[]): FleetEntry | undefined {
  const riskScore = { critical: 3, hot: 2, busy: 1, calm: 0 } as const;
  return [...entries]
    .sort((a, b) => {
      const ar = riskScore[agentRisk(a)];
      const br = riskScore[agentRisk(b)];
      if (br !== ar) return br - ar;
      const bp = b.ctxPct ?? 0;
      const ap = a.ctxPct ?? 0;
      if (bp !== ap) return bp - ap;
      if (b.toolCalls !== a.toolCalls) return b.toolCalls - a.toolCalls;
      return b.lastEventAt - a.lastEventAt;
    })
    .at(0);
}

function pctTextFromRatio(pct: number | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '0%';
  return `${Math.min(100, Math.max(0, Math.round(pct * 100)))}%`;
}

// ─── Transcript Helpers ───────────────────────────────────────────────

/**
 * Rows of transcript content for the current terminal. Constant for a
 * given terminal size and agent count, so agent switches never change
 * the panel height — only explicit resizes / fleet composition do.
 * `fullscreen` lifts the 24-row cap: the F3 monitor owns the whole
 * screen (chat history hidden), so the pane should fill every row the
 * chrome doesn't need.
 */
export function transcriptRowsForTerminal(
  termRows: number | undefined,
  rosterCount: number,
  fullscreen = false,
): number {
  // Chrome above/below the pane:
  //   Dashboard header: 2 rows
  //   Models row: 1 row
  //   Card rows: rosterCount
  //   Detail header: 3 rows
  //   Footer + border interior: 6 rows
  const chrome = 2 + 1 + Math.max(0, rosterCount - 1) + 3 + 6;
  const available = (termRows ?? 30) - chrome;
  return Math.max(6, fullscreen ? available : Math.min(24, available));
}

const TRANSCRIPT_GLYPHS: Record<AgentTimelineEntry['kind'], string> = {
  text: '💬',
  thinking: '∴',
  tool_use: '🔧',
  tool_result: '📎',
  status: '·',
  error: '❌',
  system: '·',
};

/** One transcript entry as a single display line: `HH:MM:SS L3 🔧 …`. */
export function formatTranscriptLine(e: AgentTimelineEntry, maxWidth = 110): string {
  const time = e.ts
    ? (() => {
        const d = new Date(e.ts);
        return `${Number.isNaN(d.getTime()) ? '??:??:??' : d.toLocaleTimeString('en-US', { hour12: false })} `;
      })()
    : '';
  const iter = e.iteration > 0 ? `L${e.iteration} ` : '';
  const glyph = TRANSCRIPT_GLYPHS[e.kind] ?? '·';
  const lines = e.content.split('\n');
  const firstLine = (lines[0] ?? '').trim();
  const tool =
    e.toolName && !firstLine.includes(e.toolName)
      ? `${e.toolName}${e.toolOk === false ? ' ✗' : ''} `
      : e.toolName &&
          e.toolOk === false &&
          !firstLine.includes('✗') &&
          !firstLine.startsWith('Failed')
        ? '✗ '
        : '';
  const extraLines = lines.length - 1;
  const tail = extraLines > 0 ? ` (+${extraLines})` : '';
  const head = `${time}${iter}${glyph} ${tool}`;
  return `${head}${snippet(firstLine, Math.max(16, maxWidth - head.length - tail.length))}${tail}`;
}

/**
 * Map the main chat's history entries into the transcript timeline shape
 * so LEADER gets its own clean per-agent view in the F3 monitor. Subagent
 * lines are EXCLUDED — that separation (leader vs subagents, not
 * interleaved) is the whole point of the per-agent view. Banners and
 * confirm prompts are UI chrome, not history, and are skipped too.
 */
export function leaderTimelineFromEntries(
  entries: readonly HistoryEntry[],
): AgentTimelineEntry[] {
  const out: AgentTimelineEntry[] = [];
  for (const e of entries) {
    const base = {
      id: `h${e.id}`,
      subagentId: 'leader',
      agentName: 'LEADER',
      ts: '',
      iteration: 0,
    } as const;
    switch (e.kind) {
      case 'user':
        out.push({ ...base, kind: 'status', content: `❯ ${e.text}` });
        break;
      case 'assistant':
        out.push({ ...base, kind: 'text', content: e.text });
        break;
      case 'thinking':
        out.push({ ...base, kind: 'thinking', content: e.text });
        break;
      case 'tool': {
        const meta = [
          e.durationMs > 0 ? `${e.durationMs}ms` : '',
          typeof e.outputLines === 'number' && e.outputLines > 0 ? `${e.outputLines}L` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        out.push({ ...base, kind: 'tool_use', toolName: e.name, toolOk: e.ok, content: meta });
        break;
      }
      case 'error':
        out.push({ ...base, kind: 'error', content: e.text });
        break;
      case 'warn':
        out.push({ ...base, kind: 'system', content: `⚠ ${e.text}` });
        break;
      case 'info':
      case 'turn-summary':
        out.push({ ...base, kind: 'system', content: e.text });
        break;
      case 'brain':
        out.push({
          ...base,
          kind: 'system',
          content: `🧠 ${e.question}${e.decision ? ` → ${e.decision}` : ''}`,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Slice a transcript (OLDEST first) into the fixed viewing window.
 * `scrollOffset` counts lines scrolled UP from the tail (0 = pinned to
 * newest). Returns the visible slice plus how many entries are hidden
 * above/below the window.
 */
export function selectTranscriptWindow(
  entries: readonly AgentTimelineEntry[],
  scrollOffset: number,
  rows: number = TRANSCRIPT_ROWS,
): { slice: AgentTimelineEntry[]; above: number; below: number } {
  const total = entries.length;
  const maxOffset = Math.max(0, total - rows);
  const offset = Math.max(0, Math.min(scrollOffset, maxOffset));
  const end = total - offset;
  const start = Math.max(0, end - rows);
  return { slice: entries.slice(start, end), above: start, below: offset };
}

// ─── Visual Components (Redesigned for left-right split) ──────────────

/**
 * Dashboard header — structured metrics strip.
 * Shows running/success/failed counts, max context pressure, and total cost.
 */
function DashboardHeader({
  running,
  totalDone,
  totalFailed,
  pressure,
  grandCost,
  leaderCost,
  totalCost,
  totalTokens,
  hotAgent,
  hotRisk,
}: {
  running: number;
  totalDone: number;
  totalFailed: number;
  pressure: number;
  grandCost: number;
  leaderCost: number;
  totalCost: number;
  totalTokens?: { input: number; output: number } | undefined;
  hotAgent?: FleetEntry | undefined;
  hotRisk?: { icon: string; color: string; label: string } | undefined;
}): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1} marginTop={1}>
      {/* Active count */}
      <Text bold color={theme.warn}>
        {glyphs.running} {running}
      </Text>
      <Text dimColor>active</Text>

      {/* Done count */}
      {totalDone > 0 ? (
        <>
          <Text color={theme.textMuted}>·</Text>
          <Text bold color={theme.success}>
            {glyphs.success} {totalDone}
          </Text>
          <Text dimColor>done</Text>
        </>
      ) : null}

      {/* Failed count */}
      {totalFailed > 0 ? (
        <>
          <Text color={theme.textMuted}>·</Text>
          <Text bold color={theme.error}>
            {glyphs.failure} {totalFailed}
          </Text>
          <Text dimColor>failed</Text>
        </>
      ) : null}

      {/* Separator */}
      <Text color={theme.textMuted}>│</Text>

      {/* Context pressure */}
      <Text dimColor>ctx</Text>
      <Text
        color={
          pressure >= 0.9 ? theme.error : pressure >= 0.75 ? theme.warn : theme.success
        }
      >
        {pctTextFromRatio(pressure)}
      </Text>

      {/* Hot agent */}
      {hotAgent && hotRisk ? (
        <>
          <Text color={theme.textMuted}>·</Text>
          <Text color={hotRisk.color}>{hotRisk.icon}</Text>
          <Text dimColor>{truncatePanelText(hotAgent.name, 16)}</Text>
        </>
      ) : null}

      {/* Separator */}
      <Text color={theme.textMuted}>│</Text>

      {/* Total cost */}
      <Text bold color={theme.success}>
        ${grandCost.toFixed(4)}
      </Text>
      <Text dimColor>total</Text>

      {/* Token usage — compact */}
      {totalTokens ? (
        <>
          <Text color={theme.textMuted}>·</Text>
          <Text dimColor>
            {fmtTokens(totalTokens.input)}↑ {fmtTokens(totalTokens.output)}↓
          </Text>
        </>
      ) : null}

      {/* Leader/fleet cost breakdown */}
      {leaderCost > 0 || totalCost > 0 ? (
        <Text dimColor>
          (L ${leaderCost.toFixed(4)} · F ${totalCost.toFixed(4)})
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Agent card — compact sidebar row for one agent.
 * Sized for the narrow left column: selection, status, risk, name, elapsed.
 */
function AgentCard({
  entry,
  now,
  selected,
  width,
}: {
  entry: FleetEntry;
  now: number;
  selected: boolean;
  width: number;
}): React.ReactElement {
  const s = STATUS[entry.status];
  const risk = riskMeta(agentRisk(entry));
  const elapsed = entry.status === 'running' ? fmtElapsed(Math.max(0, now - entry.startedAt)) : '';

  // Reserve space for: selection(1) + gap(1) + status(1) + gap(1) + risk(1) + gap(1) + ctx(4) + gap(1) + elapsed(~6) = 17
  const nameW = Math.max(4, width - 17);

  return (
    <Box flexDirection="row" gap={1} height={1}>
      {/* Selection indicator */}
      <Text color={selected ? theme.monitor.agents : 'transparent'}>
        {selected ? '▶' : ' '}
      </Text>

      {/* Status icon */}
      <Text color={s.color} bold>
        {s.icon}
      </Text>

      {/* Risk icon */}
      <Text color={risk.color}>{risk.icon}</Text>

      {/* Agent name — bold when selected */}
      <Text
        bold={selected}
        color={selected ? theme.monitor.agents : theme.textPrimary}
      >
        {truncatePanelText(entry.name || entry.id, nameW)}
      </Text>

      {/* Context bar — 3 dots */}
      {entry.ctxPct !== undefined ? (
        (() => {
          const clamped = Math.max(0, Math.min(1, entry.ctxPct));
          const bars = 3;
          const filled = Math.round(clamped * bars);
          const barColor =
            clamped < 0.6 ? theme.success : clamped < 0.75 ? theme.warn : theme.error;
          return (
            <Text color={barColor}>
              {'█'.repeat(filled)}
              {'░'.repeat(Math.max(0, bars - filled))}
            </Text>
          );
        })()
      ) : null}

      {/* Extensions badge */}
      {entry.extensions && entry.extensions > 0 ? (
        <Text color={theme.warn}>⚡</Text>
      ) : null}

      <Box flexGrow={1} />

      {/* Elapsed time */}
      {elapsed ? <Text dimColor>{elapsed}</Text> : null}
    </Box>
  );
}

/**
 * Detail panel — full-width content area in the right column.
 * Shows agent summary, live activity, recent tools, and (when available)
 * a scrollable transcript pane.
 */
function AgentDetailPanel({
  entry,
  now,
  transcript,
  transcriptScroll,
  transcriptRows: rows,
  width,
}: {
  entry: FleetEntry;
  now: number;
  transcript?: AgentTimelineEntry[] | undefined;
  transcriptScroll?: number | undefined;
  transcriptRows?: number | undefined;
  width: number;
}): React.ReactElement {
  const s = STATUS[entry.status];
  const modelLabel = fmtModelLabel(entry.provider, entry.model);
  const streamTail = entry.streamingText
    ? snippet(entry.streamingText.slice(-160), Math.max(16, width - 10))
    : '';
  const lastMessage = entry.recentMessages[entry.recentMessages.length - 1];

  // Alert line: failure > budget > streaming tail > current action
  const alert =
    entry.failureReason && entry.status !== 'success'
      ? { color: theme.error, text: `✗ ${snippet(entry.failureReason, Math.max(16, width - 8))}` }
      : entry.budgetWarning
        ? {
            color: theme.warn,
            text: `⚡ ${entry.budgetWarning.kind} ${entry.budgetWarning.used}/${entry.budgetWarning.limit}${entry.extensions ? ` ×${entry.extensions}` : ''}`,
          }
        : streamTail
          ? { color: theme.textMuted, text: `∴ …${streamTail}` }
          : {
              color: entry.currentTool ? theme.accent : theme.textMuted,
              text: currentAction(entry, now),
            };

  // Determine if there's room for tools row
  const wide = width >= 56;

  return (
    <Box flexDirection="column" width="100%" flexGrow={1}>
      {/* Row 1: Agent header — name, status, model */}
      <Box flexDirection="row" gap={1} height={1}>
        <Text color={theme.monitor.agents} bold>
          {truncatePanelText(
            formatAgentDetailHeader(entry),
            Math.max(12, Math.floor(width * 0.35)),
          )}
        </Text>
        {modelLabel && width >= 48 ? (
          <Text color={theme.accent}>{truncatePanelText(modelLabel, 24)}</Text>
        ) : null}
        <Box flexGrow={1} />
        <Text color={s.color}>
          {s.icon} {entry.status}
        </Text>
      </Box>

      {/* Row 2: Runtime / throughput / context / cost */}
      <Box flexDirection="row" gap={1} height={1}>
        <Text dimColor>⚙</Text>
        <Text>
          L{entry.iterations} · {entry.toolCalls}t
        </Text>
        <Text dimColor>ctx</Text>
        <Text>{formatContextRunway(entry.ctxTokens, entry.ctxMaxTokens)}</Text>
        <Text color={theme.success}>${entry.cost.toFixed(4)}</Text>
        <Text dimColor>· {fmtElapsed(Math.max(0, now - entry.startedAt))}</Text>
      </Box>

      {/* Row 3: Alert / live activity */}
      {alert.text ? (
        <Box flexDirection="row" gap={1} height={1}>
          <Text color={alert.color}>{alert.text}</Text>
        </Box>
      ) : null}

      {/* Recent tools row (compact chips) */}
      {entry.recentTools.length > 0 && wide ? (
        <Box flexDirection="row" gap={1} height={1}>
          <Text dimColor>tools</Text>
          {entry.recentTools.slice(-4).map((tool, i) => {
            const visual = getToolVisual(tool.name);
            return (
              <Text
                key={`${tool.name}-${tool.at}-${i}`}
                color={tool.ok === false ? theme.error : visual.color}
              >
                {`‹${visual.glyph} ${formatRecentToolChip(tool)}›`}
              </Text>
            );
          })}
        </Box>
      ) : null}

      {/* Streaming tail or last message (when no transcript) */}
      {!transcript && entry.status === 'running' && streamTail ? (
        <Box height={1}>
          <Text dimColor>{'>'} {streamTail}</Text>
        </Box>
      ) : null}

      {/* Latest message snippet (when no stream tail) */}
      {!transcript && (entry.status !== 'running' || !streamTail) && lastMessage ? (
        <Box height={1}>
          <Text dimColor>msg: {snippet(lastMessage.text)}</Text>
        </Box>
      ) : null}

      {/* Transcript pane — renders below the agent summary */}
      {transcript ? (
        <TranscriptPane
          entries={transcript}
          scrollOffset={transcriptScroll ?? 0}
          rows={rows ?? TRANSCRIPT_ROWS}
          width={width}
        />
      ) : null}
    </Box>
  );
}

/**
 * Fixed-height transcript pane. Constant row count in every state so the
 * surrounding layout never grows/shrinks while streaming.
 */
function TranscriptPane({
  entries,
  scrollOffset,
  rows = TRANSCRIPT_ROWS,
  width = 100,
}: {
  entries: readonly AgentTimelineEntry[];
  scrollOffset: number;
  rows?: number | undefined;
  width?: number | undefined;
}): React.ReactElement {
  const { slice, above, below } = selectTranscriptWindow(entries, scrollOffset, rows);
  const padding = Math.max(0, rows - slice.length);
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.textMuted}
      paddingX={1}
      marginTop={1}
    >
      <Box flexDirection="row" gap={1} height={1}>
        <Text dimColor bold>
          transcript
        </Text>
        <Text dimColor>
          {truncatePanelText(
            `${entries.length} entries · PgUp/PgDn scroll${above > 0 ? ` · ↑ ${above} earlier` : ''}${below > 0 ? ` · ↓ ${below} newer` : ''}`,
            Math.max(12, width - 16),
          )}
        </Text>
      </Box>
      {slice.map((e) => (
        <Text
          key={e.id}
          dimColor={e.kind === 'thinking' || e.kind === 'system'}
          color={e.kind === 'error' ? theme.error : undefined}
        >
          {formatTranscriptLine(e, Math.max(24, width - 6))}
        </Text>
      ))}
      {Array.from({ length: padding }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </Box>
  );
}

// ─── Main Component (F3 — Agents Panel with Sidebar Layout) ──────────

/**
 * Agents panel — the redesigned F3 view.
 *
 * Layout:
 * ┌─────────────────────────────────────────────────────────┐
 * │ ◇ AGENTS / live ops            ▶ 2 ✓ 5  $0.1234        │  ← DashboardHeader
 * ├──────────────────────┬──────────────────────────────────┤
 * │ agents (4)           │ AgentName   model   status      │  ← Right detail
 * │ ▶ agent1  ██░  12s  │ runtime 5m · L42 892t          │
 * │ ○ agent2  █░░  5m   │ ctx 45k/100k · 55k free         │
 * │ ○ agent3  ░░░  2m   │ active: → read foo.ts 1.2s      │
 * │                      │ ┌──────────────────────────┐   │
 * │                      │ │ transcript   74 entries   │   │
 * │                      │ │ L3 🔧 read foo.ts        │   │
 * │                      │ └──────────────────────────┘   │
 * ├──────────────────────┴──────────────────────────────────┤
 * │ ↑↓ agent  PgUp/Dn transcript  F3 close                 │
 * └─────────────────────────────────────────────────────────┘
 */
export function AgentsMonitor({
  entries,
  totalCost,
  leaderCost = 0,
  totalTokens,
  nowTick,
  onClose,
  transcripts,
  leaderTranscript,
  fullscreen: _fullscreen = false,
}: AgentsMonitorProps): React.ReactElement {
  const all = Object.values(entries);
  const grandCost = leaderCost + totalCost;

  const live = useMemo(() => selectLiveAgents(all, nowTick), [all, nowTick]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [emptyAgentsCloseStartedAt, setEmptyAgentsCloseStartedAt] = useState<number | undefined>(
    undefined,
  );

  // Auto-close when empty
  useEffect(() => {
    const nextStartedAt = nextEmptyAgentsCloseStartedAt(
      live.length,
      nowTick,
      emptyAgentsCloseStartedAt,
    );
    if (nextStartedAt !== emptyAgentsCloseStartedAt) setEmptyAgentsCloseStartedAt(nextStartedAt);
    if (shouldCloseEmptyAgentsMonitor(live.length, nowTick, nextStartedAt)) onClose?.();
  }, [emptyAgentsCloseStartedAt, live.length, nowTick, onClose]);

  const selected = selectAgentDetail(live, selectedId);
  const selectedIndex = selected ? live.findIndex((entry) => entry.id === selected.id) : -1;

  // Selected agent's full transcript, refreshed on the 1s nowTick
  const [transcriptScroll, setTranscriptScroll] = useState(0);
  const selectedTranscriptId = selected?.id;
  const transcript = useMemo(() => {
    if (!selected) return undefined;
    if (isLeaderEntry(selected)) {
      return leaderTranscript ? leaderTranscript().slice(-TRANSCRIPT_FETCH_LIMIT) : undefined;
    }
    return transcripts
      ? transcripts.getTranscript(selected.id, TRANSCRIPT_FETCH_LIMIT).slice().reverse()
      : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcripts, leaderTranscript, selectedTranscriptId, nowTick]);

  // Re-pin transcript scroll to newest on selection change
  useEffect(() => {
    setTranscriptScroll(0);
  }, [selectedTranscriptId]);

  // Terminal dimensions
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 30;
  const terminalColumns = stdout?.columns ?? 90;
  const contentWidth = Math.max(24, terminalColumns - 4);

  // Column widths for left-right split layout.
  // Left sidebar gets ~32% of width (min 26, max 42 chars for readability).
  const leftColWidth = Math.max(26, Math.min(Math.floor(contentWidth * 0.32), 42));
  const rightColWidth = contentWidth - leftColWidth - 2; // gap

  // Transcript rows fill the available vertical space in the right column.
  // Chrome: top border(1) + title row(1) + dashboard(1) + right detail header(3)
  //         + footer(1) + bottom border(1) = 8 + 2 buffer = 10
  // Also subtract the left column header row.
  const detailRows = transcript
    ? Math.max(6, terminalRows - 10)
    : 4;

  // Left-column roster windowing.
  // The left column header takes 1 row + padding.
  const leftHeaderRows = 2;
  const leftAvailableRows = terminalRows - leftHeaderRows - 6; // 6 for shell chrome
  const rosterLimit = Math.max(1, Math.min(live.length, leftAvailableRows));
  const rosterWindow = panelWindow(live.length, Math.max(0, selectedIndex), rosterLimit);
  const visibleLive = live.slice(rosterWindow.start, rosterWindow.end);

  // Keyboard navigation
  useInput((_input, key) => {
    if (live.length === 0) return;
    if (key.upArrow) {
      const next = Math.max(0, selectedIndex - 1);
      setSelectedId(live[next]?.id);
    } else if (key.downArrow) {
      const next = Math.min(live.length - 1, selectedIndex + 1);
      setSelectedId(live[next]?.id);
    } else if (key.pageUp && transcript) {
      const maxOffset = Math.max(0, transcript.length - detailRows);
      setTranscriptScroll((s) => Math.min(maxOffset, s + detailRows));
    } else if (key.pageDown && transcript) {
      setTranscriptScroll((s) => Math.max(0, s - detailRows));
    }
  });

  // Derived metrics
  const running = live.filter((e) => e.status === 'running').length;
  const totalDone = all.filter((e) => e.status === 'success').length;
  const totalFailed = all.filter((e) => e.status === 'failed' || e.status === 'timeout').length;
  const hotAgent = selectHotAgent(live);
  const hotRisk = hotAgent ? riskMeta(agentRisk(hotAgent)) : undefined;
  const pressure = live.length > 0 ? live.reduce((max, e) => Math.max(max, e.ctxPct ?? 0), 0) : 0;
  const wide = terminalColumns >= 96;

  return (
    <MonitorShell
      accent={theme.monitor.agents}
      icon={glyphs.peers}
      title="AGENTS"
      kicker={wide ? 'live operations' : undefined}
      grow
      right={
        <Text>
          <Text color={theme.warn}>{glyphs.running} {running}</Text>
          <Text color={theme.success}> {glyphs.success} {totalDone}</Text>
          {totalFailed > 0 ? <Text color={theme.error}> {glyphs.failure} {totalFailed}</Text> : null}
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="agent" color={theme.monitor.agents} />
          {selected && transcripts ? (
            <KeyCap keyName="PgUp/Dn" label="transcript" color={theme.monitor.agents} />
          ) : null}
          <KeyCap keyName="F3" label="close" color={theme.monitor.agents} />
        </Box>
      }
    >
      {/* ── Dashboard header ───────────────────────────────────────────── */}
      <DashboardHeader
        running={running}
        totalDone={totalDone}
        totalFailed={totalFailed}
        pressure={pressure}
        grandCost={grandCost}
        leaderCost={leaderCost}
        totalCost={totalCost}
        totalTokens={totalTokens}
        hotAgent={hotAgent}
        hotRisk={hotRisk}
      />

      {/* ── Left-right split layout ────────────────────────────────────── */}
      {live.length === 0 ? (
        <EmptyPanelState
          icon="◇"
          title="No live agents"
          detail="Start one with /spawn or hand off work with /fleet dispatch."
          accent={theme.monitor.agents}
        />
      ) : (
        <Box flexDirection="row" gap={1} flexGrow={1} marginTop={1}>
          {/* ═══ Left sidebar: agent list ═══ */}
          <Box flexDirection="column" width={leftColWidth}>
            {/* Column header */}
            <Box flexDirection="row" gap={1} height={1}>
              <Text dimColor bold>
                agents
              </Text>
              <Text dimColor>{live.length}</Text>
              {rosterWindow.above > 0 ? (
                <Text color={theme.textMuted} dimColor>
                  ↑{rosterWindow.above}
                </Text>
              ) : null}
              {rosterWindow.below > 0 ? (
                <Text color={theme.textMuted} dimColor>
                  ↓{rosterWindow.below}
                </Text>
              ) : null}
            </Box>

            {/* Agent cards */}
            {visibleLive.map((e) => (
              <AgentCard
                key={e.id}
                entry={e}
                now={nowTick}
                selected={e.id === selected?.id}
                width={leftColWidth}
              />
            ))}
          </Box>

          {/* ═══ Vertical separator ═══ */}

          {/* ═══ Right panel: agent detail + transcript ═══ */}
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="single"
            borderColor={theme.textMuted}
            paddingX={1}
            minWidth={36}
          >
            {selected ? (
              <AgentDetailPanel
                entry={selected}
                now={nowTick}
                transcript={transcript}
                transcriptScroll={transcriptScroll}
                transcriptRows={detailRows}
                width={rightColWidth}
              />
            ) : (
              <EmptyPanelState
                icon="◈"
                title="Select an agent"
                detail="Use ↑↓ to browse agents. Esc to close."
                accent={theme.monitor.agents}
              />
            )}
          </Box>
        </Box>
      )}
    </MonitorShell>
  );
}
