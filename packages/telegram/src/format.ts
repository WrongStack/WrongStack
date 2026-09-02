// ---------------------------------------------------------------------------
// Humanizers for agent events forwarded to Telegram.
//
// The host emits rich structured events; this module turns them into short,
// readable chat messages. Kept pure (no bot / IO) so it's trivially testable.
//
// Design rules for Telegram readability:
// - Start with an emoji status icon so the outcome is scannable.
// - Lead with the *headline* (what happened), then context, then stats.
// - Never embed raw JSON. Never concatenate object dumps.
// - Keep messages under 2000 chars so they fit one mobile screen.
// - Use emoji sparingly — status markers only, no decoration.
// - Run output through `redactSecrets` before formatting — a chat
//   notification is the highest-risk exfiltration surface for any token
//   that happens to land in tool output (see packages/telegram/src/redact.ts).
// ---------------------------------------------------------------------------

import { redactSecrets } from './redact.js';

// ---------------------------------------------------------------------------
// Payload types (subsets of core event shapes)
// ---------------------------------------------------------------------------

/** Subset of the core `delegate.completed` event payload we render. */
export interface DelegateCompletedLike {
  target: string;
  task: string;
  ok: boolean;
  status?: string | undefined;
  summary: string;
  durationMs: number;
  iterations: number;
  toolCalls: number;
  costUsd?: number | undefined;
  subagentId?: string | undefined;
}

/** Subset of core `tool.executed` event payload. */
export interface ToolExecutedLike {
  name: string;
  ok: boolean;
  durationMs: number;
  /** Raw tool output — only the first 300 chars are rendered. */
  output?: string | undefined;
}

/** Subset of core `session.ended` event payload (from Usage). */
export interface SessionEndedLike {
  id: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Compact human duration: `42s`, `3m`, `1.5h`. */
export function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Format a numeric count of tokens for human readability.
 * Uses comma-separated thousands: 1,234, 56,789.
 */
export function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Try to render a tool's output as a short human-readable snippet.
 * Strips JSON braces/quoting, redacts secrets, limits to ~300 chars,
 * preserves first/last lines.
 */
export function fmtToolOutput(raw: string | undefined): string {
  if (!raw) return '(no output)';
  // Redact BEFORE the JSON-stripping pass so we don't transform the
  // redacted marker (e.g. `[REDACTED]` survives untouched).
  const redacted = redactSecrets(raw);
  const cleaned =
    redacted
      .replace(/^[{[]\s*/, '') // strip leading JSON opening
      .replace(/\s*[}\]]$/, '') // strip trailing JSON closing
      .replace(/"([^"]+)":/g, '$1: ') // unquote JSON keys, add space for readability
      .replace(/\\n/g, '\n') // expand escaped newlines
      .replace(/\\"/g, '"') // expand escaped quotes
      .trim() || redacted;

  // Try to split into short lines; show the first 3 meaningful ones.
  const lines = cleaned.split('\n').filter((l) => l.trim().length > 0);
  let preview = lines.slice(0, 3).join('\n');
  if (lines.length > 3) preview += `\n… +${lines.length - 3} more lines`;
  if (preview.length > 300) preview = `${preview.slice(0, 297)}…`;
  return preview;
}

// ---------------------------------------------------------------------------
// Event → message formatters
// ---------------------------------------------------------------------------

/**
 * Render a finished delegation as a readable Telegram message.
 *
 * Example:
 *   ✅ Delegate → bug-hunter · success
 *   Found 3 null-deref risks in auth.ts and patched the worst one…
 *   ⏱ 3m · 4 iter · 37 tools · 💲0.0820
 */
export function formatDelegateCompleted(e: DelegateCompletedLike): string {
  const icon = e.ok ? '✅' : '❌';
  const status = e.status ?? (e.ok ? 'success' : 'failed');
  const task = e.task.length > 160 ? `${e.task.slice(0, 159)}…` : e.task;

  // Prefer the host's one-line summary; fall back to echoing the task when a
  // failure produced no summary. Both go through `redactSecrets` — a
  // delegate summary can contain raw tool output that itself leaks tokens.
  const rawBody = e.summary?.trim() || `(no summary) — ${task}`;
  const body = redactSecrets(rawBody);

  const stats = [`⏱ ${fmtDuration(e.durationMs)}`, `${e.iterations} iter`, `${e.toolCalls} tools`];
  if (typeof e.costUsd === 'number' && e.costUsd > 0) {
    stats.push(`💲${e.costUsd.toFixed(4)}`);
  }

  return [`${icon} Delegate → ${e.target} · ${status}`, body, stats.join(' · ')].join('\n');
}

/**
 * Render a long-running tool execution notification.
 *
 * Example:
 *   ✅ bash completed in 45.2s
 *   pnpm test — 12 suites, 47 tests passed
 *   …
 */
export function formatToolExecuted(e: ToolExecutedLike): string {
  const icon = e.ok ? '✅' : '❌';
  const sec = (e.durationMs / 1000).toFixed(1);
  const headline = `${icon} ${e.name} completed in ${sec}s`;

  const output = fmtToolOutput(e.output);
  // Only include output if it's short enough to be readable on mobile
  if (output === '(no output)') return headline;
  return `${headline}\n${output}`;
}

/**
 * Render a session-end notification.
 *
 * Example:
 *   🏁 Session sess_abcd ended
 *   ⬇ 8,234 in · ⬆ 3,456 out · 11,690 total
 *   Cache: 1,200 read · 800 written
 */
export function formatSessionEnded(e: SessionEndedLike): string {
  const id = e.id.length > 8 ? e.id.slice(0, 8) : e.id;
  const total = e.inputTokens + e.outputTokens;

  const lines = [
    `🏁 Session ${id} ended`,
    `⬇ ${fmtTokens(e.inputTokens)} in · ⬆ ${fmtTokens(e.outputTokens)} out · ${fmtTokens(total)} total`,
  ];

  // Show cache stats when available
  if (e.cacheRead || e.cacheWrite) {
    const parts: string[] = [];
    if (e.cacheRead && e.cacheRead > 0) parts.push(`${fmtTokens(e.cacheRead)} cache read`);
    if (e.cacheWrite && e.cacheWrite > 0) parts.push(`${fmtTokens(e.cacheWrite)} cache written`);
    if (parts.length > 0) lines.push(`📦 ${parts.join(' · ')}`);
  }

  return lines.join('\n');
}
