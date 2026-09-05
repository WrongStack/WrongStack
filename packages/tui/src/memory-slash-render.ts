import type { MemoryEntry, MemoryScope, MemoryType, MemoryPriority } from '@wrongstack/core/types';
import { MEMORY_TYPE_LABELS } from '@wrongstack/core/types';
import {
  daysAgo,
  fmtDate,
  KIND_EMOJI,
  PRIORITY_EMOJI,
  recencyLabel,
  SCOPE_LABEL,
  TYPE_EMOJI,
} from './memory-slash-format.js';

// ── Sage duck-type interface ──────────────────────────────────────────

export interface SageLike {
  id: string;
  kind: string;
  status: string;
  text: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  importance: number;
  confidence: number;
  anchors: Array<{
    type: string;
    path?: string | undefined;
    symbol?: string | undefined;
    command?: string | undefined;
  }>;
  sources: Array<{ type: string }>;
}

export interface SageStatsLike {
  total: number;
  byStatus: Record<string, number>;
  byKind: Partial<Record<string, number>>;
  edges: number;
}

export interface MemoryAnchorLike {
  type: string;
  path?: string | undefined;
  symbol?: string | undefined;
  command?: string | undefined;
}

// ── Legacy statistics ───────────────────────────────────────────────────────

export interface Stats {
  total: number;
  perScope: Record<MemoryScope, number>;
  perType: Partial<Record<MemoryType, number>>;
  perPriority: Partial<Record<MemoryPriority, number>>;
  recency: { week: number; month: number; older: number };
  tagCounts: Map<string, number>;
  noTypeCount: number;
  noPriorityCount: number;
  sources: Set<string>;
}

export function computeStats(entries: MemoryEntry[], now: number = Date.now()): Stats {
  const stats: Stats = {
    total: entries.length,
    perScope: { 'project-agents': 0, 'project-memory': 0, 'user-memory': 0 },
    perType: {},
    perPriority: {},
    recency: { week: 0, month: 0, older: 0 },
    tagCounts: new Map(),
    noTypeCount: 0,
    noPriorityCount: 0,
    sources: new Set(),
  };

  for (const e of entries) {
    stats.perScope[e.scope]++;

    if (e.type) {
      stats.perType[e.type] = (stats.perType[e.type] ?? 0) + 1;
    } else {
      stats.noTypeCount++;
    }

    if (e.priority) {
      stats.perPriority[e.priority] = (stats.perPriority[e.priority] ?? 0) + 1;
    } else {
      stats.noPriorityCount++;
    }

    const days = daysAgo(e.ts, now);
    if (days === null) {
      stats.recency.older++;
    } else if (days < 7) {
      stats.recency.week++;
    } else if (days < 30) {
      stats.recency.month++;
    } else {
      stats.recency.older++;
    }

    for (const tag of e.tags ?? []) {
      stats.tagCounts.set(tag, (stats.tagCounts.get(tag) ?? 0) + 1);
    }

    if (e.source) stats.sources.add(e.source);
  }

  return stats;
}

// ── Utilities ───────────────────────────────────────────────────────────────

/**
 * Render a simple ASCII sparkbar: a string of █ chars proportional to the ratio
 * of `value / total`. Always at least 1 block when value > 0, max 10 blocks.
 * Returns empty string when value is 0.
 */
export function sparkbar(value: number, total: number): string {
  if (value === 0 || total === 0) return '';
  const blocks = Math.max(1, Math.round((value / total) * 10));
  return `█`.repeat(blocks);
}

// ── Sage renderers ───────────────────────────────────────────────────

export function renderSageStats(
  stats: SageStatsLike,
  memories: SageLike[],
  tagFilter?: string,
  pathFilter?: string,
): string[] {
  const lines: string[] = [];

  lines.push('## 🧠 SAGE');
  lines.push('');

  // ── Status bar ──
  const active = stats.byStatus['active'] ?? 0;
  const stale = stats.byStatus['stale'] ?? 0;
  const archived = stats.byStatus['archived'] ?? 0;
  const deleted = stats.byStatus['deleted'] ?? 0;
  lines.push(
    `**Total:** ${stats.total} memories · ` +
      `🟢 ${active} active · ` +
      `🟡 ${stale} stale · ` +
      `🔵 ${archived} archived · ` +
      `⚫ ${deleted} deleted`,
  );
  lines.push(`**Graph edges:** ${stats.edges}`);
  lines.push('');

  // ── By kind (types) ──
  const kindOrder = [
    'fact',
    'decision',
    'convention',
    'preference',
    'anti_pattern',
    'warning',
    'workflow',
    'bug_root_cause',
    'file_note',
    'symbol_note',
    'command_note',
    'summary',
  ];
  const kindRows: string[] = [];
  for (const kind of kindOrder) {
    const count = stats.byKind[kind] ?? 0;
    if (count === 0) continue;
    const emoji = KIND_EMOJI[kind] ?? '•';
    const bar = sparkbar(count, stats.total);
    kindRows.push(`${emoji} **${kind}**: ${count} ${bar}`);
  }
  if (kindRows.length > 0) {
    lines.push('### 📊 By kind');
    lines.push('');
    lines.push(kindRows.join('  ·  '));
    lines.push('');
  }

  // ── Tag cloud ──
  const tagCounts = new Map<string, number>();
  for (const mem of memories) {
    for (const tag of mem.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  if (tagCounts.size > 0) {
    lines.push('### 🏷️ Top tags');
    lines.push('');
    const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const tagLine = sorted.map(([tag, count]) => `\`${tag}\` ×${count}`).join('  ·  ');
    lines.push(tagLine);
    lines.push('');
    lines.push('> Filter: `/memory --tag <tag>`  ·  `/memory --path <path>`');
    lines.push('');
  }

  // ── Active filter indicator ──
  if (tagFilter || pathFilter) {
    const parts: string[] = ['### 🔍 Filtered view'];
    if (tagFilter) parts.push(`tag: \`${tagFilter}\``);
    if (pathFilter) parts.push(`path: \`${pathFilter}\``);
    lines.push(parts.join('  ·  '));
    lines.push('');
  }

  return lines;
}

export function renderSageEntries(
  memories: SageLike[],
  compact?: boolean,
  now: number = Date.now(),
): string[] {
  if (memories.length === 0) return [];

  const lines: string[] = [];

  if (compact) {
    // ── Compact table ──
    lines.push('');
    lines.push('| # | ID | Kind | Status | Tags | Text |');
    lines.push('|---|----|------|--------|------|------|');
    let idx = 0;
    for (const mem of memories) {
      idx++;
      const tags =
        mem.tags.length > 0
          ? mem.tags.slice(0, 3).join(', ') + (mem.tags.length > 3 ? '…' : '')
          : '—';
      // Escape pipes so preview text (memory text often contains '|' in
      // commands or type notations) cannot terminate the cell early.
      const preview = mem.text
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60)
        .replaceAll('|', '\\|');
      lines.push(
        `| ${idx} | \`${mem.id.slice(0, 16)}…\` | ${mem.kind} | ${mem.status} | ${tags.replaceAll('|', '\\|')} | ${preview} |`,
      );
    }
  } else {
    // ── Rich per-entry cards ──
    lines.push('');
    for (const mem of memories) {
      const kindEmoji = KIND_EMOJI[mem.kind] ?? '•';
      const statusIcon =
        mem.status === 'active'
          ? '🟢'
          : mem.status === 'stale'
            ? '🟡'
            : mem.status === 'archived'
              ? '🔵'
              : mem.status === 'deleted'
                ? '⚫'
                : '⚪';

      const date = fmtDate(mem.createdAt);
      const recency = recencyLabel(daysAgo(mem.createdAt, now));

      const textPreview = mem.text.length > 100 ? `${mem.text.slice(0, 98)}…` : mem.text;

      const badges: string[] = [];
      badges.push(`\`${mem.kind}\``);
      badges.push(`${statusIcon} ${mem.status}`);
      badges.push(`📅 ${date} (${recency})`);
      if (mem.importance >= 0.75) badges.push('⭐ important');
      if (mem.confidence < 0.5) badges.push('⚠️ low confidence');

      lines.push(`> ${kindEmoji} **${textPreview}**`);
      lines.push(`> \`${mem.id}\` · ${badges.join(' · ')}`);

      if (mem.tags.length > 0) {
        lines.push(`> 🏷️ ${mem.tags.map((t) => `\`${t}\``).join(' ')}`);
      }

      // Anchor info
      const anchor = mem.anchors.find((a) => a.path || a.symbol || a.command);
      if (anchor) {
        const anchorText = anchor.path ?? anchor.symbol ?? anchor.command ?? '';
        lines.push(`> 📎 \`${anchorText}\``);
      }

      lines.push('');
    }
  }

  return lines;
}

// ── Legacy renderers ────────────────────────────────────────────────────────

export function renderLegacySummary(stats: Stats): string[] {
  const lines: string[] = [];

  lines.push('## 🗂️ Memory Overview (legacy)');
  lines.push('');

  // ── Counts per scope ──
  lines.push('### 📊 By scope');
  lines.push('');
  lines.push('| Scope | Count |');
  lines.push('|-------|-------|');
  for (const scope of ['project-agents', 'project-memory', 'user-memory'] as MemoryScope[]) {
    const count = stats.perScope[scope];
    if (count > 0) {
      lines.push(`| ${SCOPE_LABEL[scope]} | **${count}** |`);
    }
  }
  lines.push(`| **Total** | **${stats.total}** |`);
  lines.push('');

  // ── Breakdown by type ──
  lines.push('### 🏷️ By type');
  lines.push('');
  const typeRows: string[] = [];
  for (const [type, label] of Object.entries(MEMORY_TYPE_LABELS) as [MemoryType, string][]) {
    const count = stats.perType[type] ?? 0;
    const emoji = TYPE_EMOJI[type] ?? '•';
    const bar = count > 0 ? sparkbar(count, stats.total) : '';
    typeRows.push(`${emoji} **${label}**: ${count} ${bar}`);
  }
  if (stats.noTypeCount > 0) {
    typeRows.push(`• *Uncategorized*: ${stats.noTypeCount}`);
  }
  lines.push(typeRows.join('  ·  '));
  lines.push('');

  // ── Breakdown by priority ──
  lines.push('### 🔥 By priority');
  lines.push('');
  const prioRows: string[] = [];
  for (const prio of ['critical', 'high', 'medium', 'low'] as MemoryPriority[]) {
    const count = stats.perPriority[prio] ?? 0;
    const emoji = PRIORITY_EMOJI[prio] ?? '•';
    const bar = count > 0 ? sparkbar(count, stats.total) : '';
    prioRows.push(`${emoji} **${prio}**: ${count} ${bar}`);
  }
  if (stats.noPriorityCount > 0) {
    prioRows.push(`• *Unset*: ${stats.noPriorityCount}`);
  }
  lines.push(prioRows.join('  ·  '));
  lines.push('');

  // ── Recency ──
  lines.push('### 📅 By recency');
  lines.push('');
  lines.push('| Period | Count |');
  lines.push('|--------|-------|');
  lines.push(`| **< 7 days** | ${stats.recency.week} |`);
  lines.push(`| **7–30 days** | ${stats.recency.month} |`);
  lines.push(`| **> 30 days** | ${stats.recency.older} |`);
  lines.push('');

  // ── Top tags ──
  if (stats.tagCounts.size > 0) {
    lines.push('### 🏷️ Top tags');
    lines.push('');
    const sorted = [...stats.tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const tagLine = sorted.map(([tag, count]) => `\`${tag}\` ×${count}`).join('  ·  ');
    lines.push(tagLine);
    lines.push('');
  }

  // ── Sources ──
  if (stats.sources.size > 0) {
    lines.push(`*Sources: ${[...stats.sources].sort().join(', ')}*`);
    lines.push('');
  }

  return lines;
}

export function renderLegacyEntry(e: MemoryEntry, now: number = Date.now()): string {
  const typeEmoji = e.type ? (TYPE_EMOJI[e.type] ?? '•') : '•';
  const prioEmoji = e.priority ? (PRIORITY_EMOJI[e.priority] ?? '') : '';
  const date = fmtDate(e.ts);
  const recency = recencyLabel(daysAgo(e.ts, now));

  const textFirstLine = e.text.split('\n')[0] ?? '';
  const preview = textFirstLine.length > 100 ? `${textFirstLine.slice(0, 98)}…` : textFirstLine;

  const parts: string[] = [];

  const badges: string[] = [];
  if (e.type) badges.push(`\`${MEMORY_TYPE_LABELS[e.type] ?? e.type}\``);
  if (e.priority) badges.push(`${prioEmoji} ${e.priority}`);
  badges.push(`📅 ${date} (${recency})`);
  if (e.confidence !== undefined && e.confidence < 0.5) badges.push('⚠️ low confidence');
  parts.push(`> ${typeEmoji} **${preview}**`);
  if (badges.length > 0) parts.push(`> ${badges.join(' · ')}`);
  if (e.tags && e.tags.length > 0) {
    parts.push(`> 🏷️ ${e.tags.map((t) => `\`${t}\``).join(' ')}`);
  }

  return parts.join('\n');
}

export function renderLegacyCompactList(entries: MemoryEntry[]): string[] {
  if (entries.length === 0) return [];

  const lines: string[] = [];
  lines.push('');
  lines.push('| # | Date | Type | Priority | Tags | Preview |');
  lines.push('|---|------|------|----------|------|---------|');

  let idx = 0;
  for (const e of entries) {
    idx++;
    const date = fmtDate(e.ts);
    const type = e.type ? (MEMORY_TYPE_LABELS[e.type] ?? e.type) : '—';
    const prio = e.priority ?? '—';
    const tags = e.tags?.length
      ? e.tags.slice(0, 3).join(', ') + (e.tags.length > 3 ? '…' : '')
      : '—';
    const preview = e.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    lines.push(`| ${idx} | ${date} | ${type} | ${prio} | ${tags} | ${preview} |`);
  }

  return lines;
}

export function renderLegacyScopeSection(
  scope: MemoryScope,
  entries: MemoryEntry[],
  now: number = Date.now(),
): string[] {
  if (entries.length === 0) return [];

  const lines: string[] = [];
  lines.push('');
  lines.push(`---`);
  lines.push('');
  lines.push(`## ${SCOPE_LABEL[scope]} (${entries.length})`);
  lines.push('');

  for (const e of entries) {
    lines.push(renderLegacyEntry(e, now));
    lines.push('');
  }

  return lines;
}
