import type { MemoryPriority, MemoryScope, MemoryType } from '@wrongstack/core/types';

export const SCOPE_LABEL: Record<MemoryScope, string> = {
  'project-agents': '🤖 Project AGENTS.md',
  'project-memory': '🧠 Project memory',
  'user-memory': '👤 User memory',
};

export const TYPE_EMOJI: Record<MemoryType, string> = {
  fact: '📌',
  decision: '⚖️',
  convention: '📐',
  preference: '⭐',
  reference: '📎',
  anti_pattern: '🚫',
};

export const PRIORITY_EMOJI: Record<MemoryPriority, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '⚪',
};

export const KIND_EMOJI: Record<string, string> = {
  fact: '📌',
  decision: '⚖️',
  convention: '📐',
  preference: '⭐',
  anti_pattern: '🚫',
  warning: '⚠️',
  workflow: '🔁',
  bug_root_cause: '🐛',
  file_note: '📄',
  symbol_note: '🔣',
  command_note: '⌨️',
  summary: '📋',
};

function parseDate(ts: string): Date | null {
  if (!ts || typeof ts !== 'string') return null;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function daysAgo(ts: string, now: number = Date.now()): number | null {
  const d = parseDate(ts);
  if (!d) return null;
  return (now - d.getTime()) / (1000 * 60 * 60 * 24);
}

export function fmtDate(ts: string): string {
  const d = parseDate(ts);
  if (!d) return '—';
  return d.toISOString().slice(0, 10);
}

export function recencyLabel(days: number | null): string {
  if (days === null) return '—';
  if (days < 1) return 'today';
  if (days < 7) return `${Math.round(days)}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}
