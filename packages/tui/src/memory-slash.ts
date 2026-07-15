import type { MemoryEntry, MemoryScope, MemoryStore } from '@wrongstack/core';
import { MEMORY_TYPE_LABELS, type MemoryType, type MemoryPriority } from '@wrongstack/core';

export interface MemorySlashDeps {
  memoryStore: MemoryStore;
}

// ── Scope labels ────────────────────────────────────────────────────────────

const SCOPE_LABEL: Record<MemoryScope, string> = {
  'project-agents': '🤖 Project AGENTS.md',
  'project-memory': '🧠 Project memory',
  'user-memory': '👤 User memory',
};

// ── Emoji badges ────────────────────────────────────────────────────────────

const TYPE_EMOJI: Record<MemoryType, string> = {
  fact: '📌',
  decision: '⚖️',
  convention: '📐',
  preference: '⭐',
  reference: '📎',
  anti_pattern: '🚫',
};

const PRIORITY_EMOJI: Record<MemoryPriority, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '⚪',
};

function daysAgo(ts: string): number {
  return (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60 * 24);
}

function recencyLabel(days: number): string {
  if (days < 1) return 'today';
  if (days < 7) return `${Math.round(days)}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

function fmtDate(ts: string): string {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

// ── Statistics ──────────────────────────────────────────────────────────────

interface Stats {
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

function computeStats(entries: MemoryEntry[]): Stats {
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

    const days = daysAgo(e.ts);
    if (days < 7) stats.recency.week++;
    else if (days < 30) stats.recency.month++;
    else stats.recency.older++;

    for (const tag of e.tags ?? []) {
      stats.tagCounts.set(tag, (stats.tagCounts.get(tag) ?? 0) + 1);
    }

    if (e.source) stats.sources.add(e.source);
  }

  return stats;
}

// ── Renderers ───────────────────────────────────────────────────────────────

function renderSummary(stats: Stats): string[] {
  const lines: string[] = [];

  // ── Header ──
  lines.push('## 🗂️ Memory Overview');
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
  lines.push(`| Period | Count |`);
  lines.push('|--------|-------|');
  lines.push(`| **< 7 days** | ${stats.recency.week} |`);
  lines.push(`| **7–30 days** | ${stats.recency.month} |`);
  lines.push(`| **> 30 days** | ${stats.recency.older} |`);
  lines.push('');

  // ── Top tags ──
  if (stats.tagCounts.size > 0) {
    lines.push('### 🏷️ Top tags');
    lines.push('');
    const sorted = [...stats.tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
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

/**
 * Render a simple ASCII sparkbar: a string of █ chars proportional to the ratio
 * of `value / total`. Always at least 1 block when value > 0, max 10 blocks.
 * Returns empty string when value is 0.
 */
function sparkbar(value: number, total: number): string {
  if (value === 0 || total === 0) return '';
  const blocks = Math.max(1, Math.round((value / total) * 10));
  return `█`.repeat(blocks);
}

// ── Per-entry render ────────────────────────────────────────────────────────

function renderEntry(e: MemoryEntry): string {
  const typeEmoji = e.type ? (TYPE_EMOJI[e.type] ?? '•') : '•';
  const prioEmoji = e.priority ? (PRIORITY_EMOJI[e.priority] ?? '') : '';
  const date = fmtDate(e.ts);
  const recency = recencyLabel(daysAgo(e.ts));

  // First line of the text as summary
  const textFirstLine = e.text.split('\n')[0] ?? '';
  const preview = textFirstLine.length > 100 ? `${textFirstLine.slice(0, 98)}…` : textFirstLine;

  const parts: string[] = [];

  // Badges
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

// ── Scope section ───────────────────────────────────────────────────────────

function renderScopeSection(scope: MemoryScope, entries: MemoryEntry[]): string[] {
  if (entries.length === 0) return [];

  const lines: string[] = [];
  lines.push('');
  lines.push(`---`);
  lines.push('');
  lines.push(`## ${SCOPE_LABEL[scope]} (${entries.length})`);
  lines.push('');

  for (const e of entries) {
    lines.push(renderEntry(e));
    lines.push('');
  }

  return lines;
}

// ── Entry list ──────────────────────────────────────────────────────────────

function renderCompactList(entries: MemoryEntry[]): string[] {
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
    const tags = e.tags?.length ? e.tags.slice(0, 3).join(', ') + (e.tags.length > 3 ? '…' : '') : '—';
    const preview = e.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    lines.push(`| ${idx} | ${date} | ${type} | ${prio} | ${tags} | ${preview} |`);
  }

  return lines;
}

// ── Main command factory ────────────────────────────────────────────────────

export function createMemorySlashCommand(deps: MemorySlashDeps) {
  return {
    name: 'memory',
    description: 'List all stored memory entries with statistics, grouped by scope.',
    argsHint: '[scope] [--compact]',
    category: 'Inspect' as const,
    help:
      'Usage:\n' +
      '  /memory                     — show all entries with statistics\n' +
      '  /memory project-memory      — list only project memory\n' +
      '  /memory user-memory         — list only user memory\n' +
      '  /memory project-agents      — list only project AGENTS.md entries\n' +
      '  /memory --compact           — show compact table format instead of rich entries\n' +
      '',
    async run(args: string) {
      const trimmed = args.trim();
      const useCompact = trimmed.includes('--compact');
      const scopeArg = trimmed.replace(/--compact\s*/g, '').trim().toLowerCase() as MemoryScope | '';

      const scopes: MemoryScope[] =
        scopeArg &&
        (['project-agents', 'project-memory', 'user-memory'] as const).includes(
          scopeArg as MemoryScope,
        )
          ? [scopeArg as MemoryScope]
          : ['project-agents', 'project-memory', 'user-memory'];

      try {
        // Fetch all requested scopes in parallel
        const results = await Promise.all(
          scopes.map(async (scope) => {
            const entries = await deps.memoryStore.list(scope);
            return { scope, entries };
          }),
        );

        const allEntries = results.flatMap((r) => r.entries);
        if (allEntries.length === 0) {
          return { message: '🧠 No memory entries found.' };
        }

        const parts: string[] = [];

        // ── Global statistics ──
        const globalStats = computeStats(allEntries);
        parts.push(...renderSummary(globalStats));

        if (useCompact) {
          // ── Compact mode: one table per scope ──
          for (const { scope, entries } of results) {
            if (entries.length === 0) continue;
            parts.push('');
            parts.push(`---`);
            parts.push('');
            parts.push(`## ${SCOPE_LABEL[scope]} (${entries.length})`);
            parts.push(...renderCompactList(entries));
          }
        } else {
          // ── Rich mode: per-entry cards grouped by scope ──
          for (const { scope, entries } of results) {
            parts.push(...renderScopeSection(scope, entries));
          }
        }

        // ── Footer ──
        parts.push('');
        const scopeSuffix = scopes.length === 1 ? `in **${SCOPE_LABEL[scopes[0]!]}**` : 'across all scopes';
        parts.push(`*${allEntries.length} entr${allEntries.length === 1 ? 'y' : 'ies'} ${scopeSuffix}*`);

        return { message: parts.join('\n') };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { message: `Failed to read memory store: ${msg}` };
      }
    },
  };
}
