/**
 * Ended sessions, as the Sessions tab reads them: a summary, then the list
 * grouped by day. Pure, so it is tested without React.
 */
import type { HqSessionHistoryEntry } from '@wrongstack/hq';

export interface SessionHistorySummary {
  count: number;
  costUsd: number;
  toolCalls: number;
  /** Sessions HQ lost (the client vanished or stopped reporting). */
  lost: number;
}

export function summarizeHistory(entries: readonly HqSessionHistoryEntry[]): SessionHistorySummary {
  let costUsd = 0;
  let toolCalls = 0;
  let lost = 0;
  for (const entry of entries) {
    costUsd += Number.isFinite(entry.costUsd) ? entry.costUsd : 0;
    toolCalls += Number.isFinite(entry.toolCalls) ? entry.toolCalls : 0;
    if (entry.outcome === 'lost') lost += 1;
  }
  return { count: entries.length, costUsd, toolCalls, lost };
}

/** "45s", "12m", "3h 05m", "2d 4h". */
export function sessionDuration(
  entry: Pick<HqSessionHistoryEntry, 'startedAt' | 'lastActivityAt'>,
): string {
  const start = Date.parse(entry.startedAt);
  const end = Date.parse(entry.lastActivityAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Newest day first; entries keep their (newest-first) order within a day. */
export function groupByDay(
  entries: readonly HqSessionHistoryEntry[],
): { day: string; entries: HqSessionHistoryEntry[] }[] {
  const groups: { day: string; entries: HqSessionHistoryEntry[] }[] = [];
  for (const entry of entries) {
    const at = new Date(entry.endedAt);
    const day = Number.isNaN(at.getTime())
      ? 'Unknown day'
      : at.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const last = groups.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

const CSV_COLUMNS: readonly (readonly [
  string,
  (entry: HqSessionHistoryEntry) => string | number,
])[] = [
  ['ended_at', (entry) => entry.endedAt],
  ['started_at', (entry) => entry.startedAt],
  ['last_activity_at', (entry) => entry.lastActivityAt],
  ['outcome', (entry) => entry.outcome],
  ['project_id', (entry) => entry.projectId],
  ['project', (entry) => entry.projectName],
  ['machine', (entry) => entry.hostname ?? entry.machineKey],
  ['client', (entry) => entry.clientKind],
  ['client_version', (entry) => entry.clientVersion ?? ''],
  ['branch', (entry) => entry.gitBranch ?? ''],
  ['cost_usd', (entry) => (Number.isFinite(entry.costUsd) ? entry.costUsd.toFixed(4) : '')],
  ['tokens_in', (entry) => entry.tokensIn],
  ['tokens_out', (entry) => entry.tokensOut],
  ['tool_calls', (entry) => entry.toolCalls],
  ['agents', (entry) => entry.agents],
  ['models', (entry) => entry.models.join(' ')],
  ['session_id', (entry) => entry.sessionId],
];

/**
 * One CSV cell. Names come from clients, so a value a spreadsheet would run
 * as a formula (`=`, `+`, `-`, `@`, tab, CR) is prefixed with `'`.
 */
function csvCell(value: string | number): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The history as CSV, one row per session, for spend reports. */
export function historyCsv(entries: readonly HqSessionHistoryEntry[]): string {
  const rows = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const entry of entries)
    rows.push(CSV_COLUMNS.map(([, read]) => csvCell(read(entry))).join(','));
  return `${rows.join('\r\n')}\r\n`;
}
