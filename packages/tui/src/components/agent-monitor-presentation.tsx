import { acpAgentName } from '@wrongstack/contracts/types/agent-identity';
import type { AgentTimelineEntry } from '@wrongstack/coordination';

import type { FleetEntry } from '../app-state.js';
import { theme } from '../theme.js';
import {
  EMPTY_AGENTS_CLOSE_DELAY_MS,
  FINISHED_KEEP_MS,
  STATUS,
  TRANSCRIPT_GLYPHS,
  TRANSCRIPT_ROWS,
} from './agents-monitor-constants.js';
import type { HistoryEntry } from './history.js';
import { fmtRatioPct } from './status-bar-format.js';

export function isLeaderEntry(entry: FleetEntry): boolean {
  return entry.id === 'leader' || entry.name === 'LEADER';
}

export function isFinishedEntry(entry: FleetEntry): boolean {
  return (
    entry.status === 'success' ||
    entry.status === 'failed' ||
    entry.status === 'timeout' ||
    entry.status === 'stopped'
  );
}

/**
 * Select the agents the live monitor should render: LEADER, then running
 * subagents in caller order, then subagents that finished within `keepMs`,
 * newest first — so a failure stays readable after the fact. Idle workers are
 * retained by the coordinator for reuse but are not shown. LEADER stays
 * visible while anything else is (or while it runs itself) so F3 always has
 * a detail card fallback.
 */
export function selectLiveAgents(
  all: FleetEntry[],
  now: number,
  keepMs: number = FINISHED_KEEP_MS,
): FleetEntry[] {
  const leader = all.find(isLeaderEntry);
  const running = all.filter((entry) => !isLeaderEntry(entry) && entry.status === 'running');
  const finished = all
    .filter(
      (entry) =>
        !isLeaderEntry(entry) &&
        isFinishedEntry(entry) &&
        now - (entry.endedAt ?? entry.lastEventAt) <= keepMs,
    )
    .sort((a, b) => (b.endedAt ?? b.lastEventAt) - (a.endedAt ?? a.lastEventAt));
  const showLeader =
    leader !== undefined && (leader.status !== 'idle' || running.length > 0 || finished.length > 0);
  return [...(showLeader ? [leader] : []), ...running, ...finished];
}

/**
 * The one glyph a roster row leads with: a running agent's pressure (calm,
 * busy, hot, critical), otherwise how its task ended.
 */
export function rosterGlyph(entry: FleetEntry): { icon: string; color: string } {
  if (entry.status === 'running') {
    const risk = riskMeta(agentRisk(entry));
    return { icon: risk.icon, color: risk.color };
  }
  return STATUS[entry.status];
}

/** Where the agent runs: `provider:model`, or what an external ACP worker is. */
export function formatAgentModel(entry: FleetEntry): string {
  if (entry.provider === 'acp') {
    const label = entry.id === 'leader' || entry.name === 'LEADER' ? 'ACP leader' : 'ACP subagent';
    return entry.model ? `${label} · ${acpAgentName(entry.model)}` : label;
  }
  if (!entry.model && !entry.provider) return '';
  const model = entry.model
    ? entry.model.includes('/')
      ? entry.model.slice(entry.model.lastIndexOf('/') + 1)
      : entry.model
    : '?';
  return entry.provider ? `${entry.provider}:${model}` : model;
}

/** Dollars at a precision that reads: cents once there are any, else four places. */
export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = (n / 1000).toFixed(1);
  // 999_950 rounds to "1000.0k" — that is the next unit.
  if (n < 1_000_000 && Number(k) < 1000) return `${k}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtExactTokens(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} tok`;
}

export function snippet(s: string, max = 72): string {
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

export function agentRisk(entry: FleetEntry): 'calm' | 'busy' | 'hot' | 'critical' {
  const pct = entry.ctxPct ?? 0;
  if (entry.budgetWarning || entry.failureReason || pct >= 0.9) return 'critical';
  if (pct >= 0.75 || (entry.extensions ?? 0) > 0) return 'hot';
  if (entry.status === 'running' || pct >= 0.55) return 'busy';
  return 'calm';
}

export function riskMeta(risk: ReturnType<typeof agentRisk>): {
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

export function currentAction(entry: FleetEntry, now: number): string {
  if (entry.currentTool)
    return `→ ${entry.currentTool.name} ${fmtShortDuration(now - entry.currentTool.startedAt)}`;
  // Subagents: show only tool activity. No streaming text, no "thinking",
  // no message snippets — those caused screen flicker. Empty when idle.
  if (!isLeaderEntry(entry)) {
    const last = entry.recentTools[entry.recentTools.length - 1];
    if (last) return `last ${last.name}`;
    return '';
  }
  if (entry.status === 'running') return 'thinking';
  const last = entry.recentTools[entry.recentTools.length - 1];
  if (last) return `last ${last.name}`;
  const msg = entry.recentMessages[entry.recentMessages.length - 1];
  if (msg) return `msg ${snippet(msg.text, 34)}`;
  return 'standing by';
}

export function selectAgentDetail(live: FleetEntry[], selectedId?: string): FleetEntry | undefined {
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

export function selectHotAgent(entries: FleetEntry[]): FleetEntry | undefined {
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

export function pctTextFromRatio(pct: number | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '0%';
  return fmtRatioPct(pct);
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
export function leaderTimelineFromEntries(entries: readonly HistoryEntry[]): AgentTimelineEntry[] {
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
