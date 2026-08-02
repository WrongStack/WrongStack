import type { MemoryEntry, MemoryPort, MemoryScope } from '@wrongstack/core/types';
import { MEMORY_TYPE_LABELS, type MemoryPriority, type MemoryType } from '@wrongstack/core/types';
import { getSageSurface } from '@wrongstack/sage';
import {
  daysAgo,
  fmtDate,
  KIND_EMOJI,
  PRIORITY_EMOJI,
  recencyLabel,
  SCOPE_LABEL,
  TYPE_EMOJI,
} from './memory-slash-format.js';

export interface MemorySlashDeps {
  memoryStore: MemoryPort;
}

/**
 * Default number of entries to show when the user runs `/memory` with no
 * explicit limit. Prevents the TUI from dumping the entire memory list (which
 * can run into thousands of memories) onto the screen at once.
 */
const DEFAULT_MEMORY_LIMIT = 50;

/**
 * Hard cap on `--limit`. The SAGE `listSagePage` API clamps to 500 as well;
 * this constant matches that ceiling so the legacy path stays consistent.
 */
const MAX_MEMORY_LIMIT = 500;

// ── Sage duck-type interface ──────────────────────────────────────────

interface SageLike {
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

interface SageStatsLike {
  total: number;
  byStatus: Record<string, number>;
  byKind: Partial<Record<string, number>>;
  edges: number;
}

interface MemoryAnchorLike {
  type: string;
  path?: string | undefined;
  symbol?: string | undefined;
  command?: string | undefined;
}

interface UpdateSageInput {
  text?: string | undefined;
  kind?: string | undefined;
  tags?: string[] | undefined;
  anchors?: MemoryAnchorLike[] | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  status?: string | undefined;
  supersedes?: string[] | undefined;
  contradicts?: string[] | undefined;
}

// ── Legacy statistics ───────────────────────────────────────────────────────

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

// ── Sage renderers ───────────────────────────────────────────────────

function renderSageStats(
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

function renderSageEntries(memories: SageLike[], compact?: boolean): string[] {
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
      const preview = mem.text.replace(/\s+/g, ' ').trim().slice(0, 60);
      lines.push(
        `| ${idx} | \`${mem.id.slice(0, 16)}…\` | ${mem.kind} | ${mem.status} | ${tags} | ${preview} |`,
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
      const recency = recencyLabel(daysAgo(mem.createdAt));

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

function renderLegacySummary(stats: Stats): string[] {
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

function renderLegacyEntry(e: MemoryEntry): string {
  const typeEmoji = e.type ? (TYPE_EMOJI[e.type] ?? '•') : '•';
  const prioEmoji = e.priority ? (PRIORITY_EMOJI[e.priority] ?? '') : '';
  const date = fmtDate(e.ts);
  const recency = recencyLabel(daysAgo(e.ts));

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

function renderLegacyCompactList(entries: MemoryEntry[]): string[] {
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

// ── Utilities ───────────────────────────────────────────────────────────────

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

/**
 * Parse `--key value` style arguments from an args string.
 */
interface ParsedArgs {
  tag?: string;
  path?: string;
  compact: boolean;
  /** Page size for entries (clamped to [1, MAX_MEMORY_LIMIT]). */
  limit: number;
  positional: string;
}

function parseArgs(raw: string): ParsedArgs {
  const trimmed = raw.trim();
  const result: ParsedArgs = { compact: false, limit: DEFAULT_MEMORY_LIMIT, positional: '' };

  // Extract --tag <value>
  const tagMatch = trimmed.match(/--tag\s+(\S+)/);
  if (tagMatch) result.tag = tagMatch[1] ?? '';

  // Extract --path <value>
  const pathMatch = trimmed.match(/--path\s+(\S+)/);
  if (pathMatch) result.path = pathMatch[1] ?? '';

  // Extract --limit <N>
  const limitMatch = trimmed.match(/--limit\s+(\d+)/);
  if (limitMatch) {
    const parsed = Number.parseInt(limitMatch[1] ?? '', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      result.limit = Math.max(1, Math.min(MAX_MEMORY_LIMIT, Math.floor(parsed)));
    }
  }

  // Extract --compact
  result.compact = trimmed.includes('--compact');

  // Remaining positional (scope for legacy, filter for SAGE)
  const positional = trimmed
    .replace(/--tag\s+\S+/g, '')
    .replace(/--path\s+\S+/g, '')
    .replace(/--limit\s+\d+/g, '')
    .replace(/--compact\s*/g, '')
    .trim();
  result.positional = positional;

  return result;
}

// ── Main command factory ────────────────────────────────────────────────────

// ── Write subcommands (remember / update / delete / forget) ──────────────────
//
// Mirrors the CLI `/memory` write surface (packages/cli/src/slash-commands/
// memory.ts). Kept self-contained (local parser + duck-types) so the TUI does
// not need a direct @wrongstack/sage dependency. Keep the flag set in
// sync with the CLI command.

const MEMORY_WRITE_SUBS = new Set([
  'remember',
  'add',
  'update',
  'edit',
  'delete',
  'del',
  'forget',
  'rm',
]);

const MEMORY_KIND_VALUES = [
  'fact',
  'decision',
  'convention',
  'preference',
  'warning',
  'anti_pattern',
  'workflow',
  'bug_root_cause',
  'file_note',
  'symbol_note',
  'command_note',
  'summary',
];
const MEMORY_SCOPE_VALUES = ['project', 'user', 'session', 'file', 'symbol'];
const MEMORY_STATUS_VALUES = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
  'deleted',
] as const;

interface ParsedMemoryFlags {
  text: string;
  kind?: string;
  scope?: string;
  status?: string;
  tags?: string[];
  anchors?: MemoryAnchorLike[];
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  supersedes?: string[];
  contradicts?: string[];
  errors: string[];
}

function parseMemoryFlags(tokens: string[]): ParsedMemoryFlags {
  const words: string[] = [];
  const anchors: MemoryAnchorLike[] = [];
  const errors: string[] = [];
  const out: ParsedMemoryFlags = { text: '', errors };

  const csv = (value: string): string[] =>
    value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  const num = (name: string, value: string | undefined): number | undefined => {
    if (value === undefined) {
      errors.push(`${name} needs a value between 0 and 1.`);
      return undefined;
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      errors.push(`${name} must be a number between 0 and 1 (got "${value}").`);
      return undefined;
    }
    return parsed;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (!token.startsWith('--')) {
      words.push(token);
      continue;
    }
    const name = token.slice(2).toLowerCase();
    const nxt = tokens[i + 1];
    const value = nxt !== undefined && !nxt.startsWith('--') ? nxt : undefined;
    if (value !== undefined) i++;
    switch (name) {
      case 'kind':
        if (value && (MEMORY_KIND_VALUES as readonly string[]).includes(value)) out.kind = value;
        else errors.push(`--kind must be one of: ${MEMORY_KIND_VALUES.join(', ')}.`);
        break;
      case 'scope':
        if (value && MEMORY_SCOPE_VALUES.includes(value)) out.scope = value;
        else errors.push(`--scope must be one of: ${MEMORY_SCOPE_VALUES.join(', ')}.`);
        break;
      case 'status':
        if (value && (MEMORY_STATUS_VALUES as readonly string[]).includes(value)) out.status = value;
        else errors.push(`--status must be one of: ${MEMORY_STATUS_VALUES.join(', ')}.`);
        break;
      case 'tag':
      case 'tags':
        if (value) out.tags = [...(out.tags ?? []), ...csv(value)];
        else errors.push('--tag needs a value (comma-separated for multiple).');
        break;
      case 'anchor':
      case 'file':
        if (value) anchors.push({ type: 'file', path: value });
        else errors.push('--anchor needs a file path.');
        break;
      case 'symbol': {
        if (!value) {
          errors.push('--symbol needs a value like path#SymbolName.');
          break;
        }
        const hash = value.lastIndexOf('#');
        if (hash <= 0 || hash === value.length - 1) {
          errors.push('--symbol must be path#SymbolName.');
          break;
        }
        anchors.push({ type: 'symbol', path: value.slice(0, hash), symbol: value.slice(hash + 1) });
        break;
      }
      case 'command':
        if (value) anchors.push({ type: 'command', command: value });
        else errors.push('--command needs a value.');
        break;
      case 'importance':
        out.importance = num('--importance', value);
        break;
      case 'confidence':
        out.confidence = num('--confidence', value);
        break;
      case 'freshness':
        out.freshness = num('--freshness', value);
        break;
      case 'supersedes':
        if (value) out.supersedes = [...(out.supersedes ?? []), ...csv(value)];
        else errors.push('--supersedes needs one or more memory ids.');
        break;
      case 'contradicts':
        if (value) out.contradicts = [...(out.contradicts ?? []), ...csv(value)];
        else errors.push('--contradicts needs one or more memory ids.');
        break;
      case 'text':
        if (value) words.push(value);
        else errors.push('--text needs a value.');
        break;
      default:
        errors.push(`Unknown flag "--${name}".`);
    }
  }

  out.text = words.join(' ').trim();
  if (anchors.length > 0) out.anchors = anchors;
  return out;
}

function memErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function handleMemoryWrite(
  store: MemoryPort,
  sub: string,
  rest: string[],
): Promise<{ message: string }> {
  const Sage = getSageSurface(store);
  // remember has a legacy fallback; every other write op needs SAGE.
  if (sub === 'remember' || sub === 'add') {
    if (rest.length === 0) {
      return {
        message:
          'Usage: /memory remember <text> [--kind k] [--scope s] [--tag a,b] [--anchor path] [--symbol path#Name] [--command cmd] [--importance 0..1] [--confidence 0..1] [--supersedes id,id] [--contradicts id,id]',
      };
    }
    if (!Sage) {
      const text = rest.join(' ').trim();
      if (!text) return { message: 'Usage: /memory remember <text>' };
      await store.remember(text);
      return { message: `Remembered: ${text}` };
    }
    const parsed = parseMemoryFlags(rest);
    if (parsed.errors.length > 0)
      return { message: `Cannot remember:\n- ${parsed.errors.join('\n- ')}` };
    if (!parsed.text)
      return { message: 'Nothing to remember — provide the memory text before/after the flags.' };
    try {
      const memory = await Sage.rememberSage({
        text: parsed.text,
        ...(parsed.kind && { kind: parsed.kind }),
        ...(parsed.scope && { scope: parsed.scope }),
        ...(parsed.tags && { tags: parsed.tags }),
        ...(parsed.anchors && { anchors: parsed.anchors }),
        ...(parsed.importance !== undefined && { importance: parsed.importance }),
        ...(parsed.confidence !== undefined && { confidence: parsed.confidence }),
        ...(parsed.supersedes && { supersedes: parsed.supersedes }),
        ...(parsed.contradicts && { contradicts: parsed.contradicts }),
      } as never);
      const tags = memory.tags.length > 0 ? ` ${memory.tags.map((t) => `#${t}`).join(' ')}` : '';
      return { message: `Remembered \`${memory.id}\` [${memory.kind}] ${memory.text}${tags}` };
    } catch (err) {
      return { message: `Could not remember: ${memErr(err)}` };
    }
  }

  if (!Sage) {
    return { message: `\`/memory ${sub}\` requires the SAGE backend.` };
  }

  if (sub === 'update' || sub === 'edit') {
    const id = rest[0];
    if (!id)
      return {
        message:
          'Usage: /memory update <memory-id> [--text t] [--kind k] [--tag a,b] [--status active|stale|archived|deleted] [--importance 0..1] ...',
      };
    const parsed = parseMemoryFlags(rest.slice(1));
    if (parsed.errors.length > 0)
      return { message: `Cannot update:\n- ${parsed.errors.join('\n- ')}` };
    const patch: UpdateSageInput = {
      ...(parsed.text && { text: parsed.text }),
      ...(parsed.kind && { kind: parsed.kind }),
      ...(parsed.tags && { tags: parsed.tags }),
      ...(parsed.anchors && { anchors: parsed.anchors }),
      ...(parsed.importance !== undefined && { importance: parsed.importance }),
      ...(parsed.confidence !== undefined && { confidence: parsed.confidence }),
      ...(parsed.freshness !== undefined && { freshness: parsed.freshness }),
      ...(parsed.status && { status: parsed.status }),
      ...(parsed.supersedes && { supersedes: parsed.supersedes }),
      ...(parsed.contradicts && { contradicts: parsed.contradicts }),
    };
    if (Object.keys(patch).length === 0) {
      return {
        message: 'Nothing to update — pass at least one field (e.g. --text, --status, --tag).',
      };
    }
    try {
      const memory = await Sage.updateSage(id, patch as never);
      return {
        message: `Updated \`${memory.id}\` [${memory.kind}|${memory.status}] ${memory.text}`,
      };
    } catch (err) {
      return { message: `Could not update: ${memErr(err)}` };
    }
  }

  if (sub === 'delete' || sub === 'del') {
    const id = rest[0];
    if (!id) return { message: 'Usage: /memory delete <memory-id> [reason...]' };
    const reason = rest.slice(1).join(' ').trim() || undefined;
    try {
      const existing = await Sage.getSage(id);
      if (!existing) return { message: `No memory with id \`${id}\`.` };
      await Sage.deleteSage(id, reason, { force: true });
      return { message: `Deleted \`${id}\`.` };
    } catch (err) {
      return { message: `Could not delete: ${memErr(err)}` };
    }
  }

  // forget / rm — substring removal via the shared MemoryStore API.
  const query = rest.join(' ').trim();
  if (!query) return { message: 'Usage: /memory forget <query>' };
  try {
    const removed = await store.forget(query);
    return {
      message:
        removed === 0
          ? `No entries matched "${query}".`
          : `Forgot ${removed} entr${removed === 1 ? 'y' : 'ies'}.`,
    };
  } catch (err) {
    return { message: `Could not forget: ${memErr(err)}` };
  }
}

export function createMemorySlashCommand(deps: MemorySlashDeps) {
  return {
    name: 'memory',
    description: 'Display memory stats with filtering by tag and path (supports SAGE).',
    argsHint: '[--tag <tag>] [--path <path>] [--limit N] [--compact] [scope]',
    category: 'Inspect' as const,
    help:
      'Usage:\n' +
      `  /memory                     — show memory stats + first ${DEFAULT_MEMORY_LIMIT} entries\n` +
      `  /memory --limit <N>         — show up to N entries (default ${DEFAULT_MEMORY_LIMIT}, max ${MAX_MEMORY_LIMIT})\n` +
      '  /memory --tag <tag>         — filter entries by tag\n' +
      '  /memory --path <path>       — filter entries by file path\n' +
      '  /memory --compact           — compact table format\n' +
      '  /memory remember <text> [--kind k] [--scope s] [--tag a,b] [--anchor path] [--importance 0..1]\n' +
      '  /memory update <id> [--text t] [--kind k] [--tag a,b] [--status s] ...\n' +
      '  /memory delete <id> [reason]\n' +
      '  /memory graph <id|path|query> — show persisted relations, weights, and why evidence\n' +
      '  /memory forget <query>      — remove entries matching a substring\n' +
      '  /memory gather [--limit N] [--status s] [--kind k] [--relations] [query] — batch gather memories with optional graph\n' +
      '  /memory project-memory      — legacy: list only project memory\n' +
      '  /memory user-memory         — legacy: list only user memory\n' +
      '  /memory project-agents      — legacy: list only AGENTS.md entries\n' +
      '',
    async run(args: string) {
      const store = deps.memoryStore;

      // ── Write subcommands (remember/update/delete/forget) ──────────────
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? '').toLowerCase();
      if (MEMORY_WRITE_SUBS.has(sub)) {
        return handleMemoryWrite(store, sub, tokens.slice(1));
      }
      if (sub === 'graph') {
        const query = tokens.slice(1).join(' ').trim();
        if (!query) return { message: 'Usage: /memory graph <memory-id|path|query>' };
        const Sage = getSageSurface(store);
        if (!Sage?.graphFor) {
          return { message: '`/memory graph` requires the SAGE graph backend.' };
        }
        const edges = await Sage.graphFor(query, 2, 100);
        if (edges.length === 0) return { message: `No graph relationships matched "${query}".` };
        return {
          message: [
            `## Memory Graph — ${query}`,
            ...edges.map(
              (edge) =>
                `- ${edge.from} —[${edge.relation}:${edge.weight.toFixed(2)}]→ ${edge.to}` +
                (edge.evidence?.length ? ` _(why: ${edge.evidence.join(', ')})_` : ''),
            ),
          ].join('\n'),
        };
      }

      if (sub === 'gather') {
        const Sage = getSageSurface(store);
        if (!Sage?.listSagePage) {
          return { message: '`/memory gather` requires the SAGE page listing backend.' };
        }
        // Parse gather-specific flags: --relations, --status, --kind
        const remaining = tokens.slice(1).join(' ').trim();
        const remainingTokens = remaining.split(/\s+/);
        // Token-level check for --relations (no value arg) to avoid substring collisions
        const includeRelations = remainingTokens.includes('--relations');
        const statusMatch = remaining.match(/--status\s+(\w+)/);
        const statusVal = statusMatch?.[1];
        const kindMatch = remaining.match(/--kind\s+(\w+)/);
        const kindVal = kindMatch?.[1];
        const limitMatch = remaining.match(/--limit\s+(\d+)/);
        const limitVal = limitMatch ? Math.min(MAX_MEMORY_LIMIT, Math.max(1, Number.parseInt(limitMatch[1]!, 10))) : DEFAULT_MEMORY_LIMIT;
        // Positional query: strip flags — use exact token matching for --relations,
        // regex for flags that carry a value argument
        const query = remainingTokens
          .filter(t => t !== '--relations')
          .join(' ')
          .replace(/--status\s+\w+/g, '')
          .replace(/--kind\s+\w+/g, '')
          .replace(/--limit\s+\d+/g, '')
          .trim();

        // Runtime-validate --status against known SageStatus values
        if (statusVal !== undefined && !(MEMORY_STATUS_VALUES as readonly string[]).includes(statusVal)) {
          return { message: `Invalid --status "${statusVal}". Valid: ${MEMORY_STATUS_VALUES.join(', ')}` };
        }
        if (kindVal !== undefined && !(MEMORY_KIND_VALUES as readonly string[]).includes(kindVal)) {
          return { message: `Invalid --kind "${kindVal}". Valid: ${MEMORY_KIND_VALUES.join(', ')}` };
        }
        const resolvedStatus = statusVal as typeof MEMORY_STATUS_VALUES[number] | undefined;

        try {
          const page = await Sage.listSagePage({
            statuses: resolvedStatus ? [resolvedStatus] : ['active'],
            kind: kindVal,
            query: query || undefined,
            limit: limitVal,
          });
          if (page.memories.length === 0) {
            return { message: 'No memories matched the gather criteria.' };
          }
          const lines: string[] = [];
          lines.push('');
          lines.push(`## 📋 Memory Gather — ${page.total} matched`);
          if (page.statusCounts && Object.keys(page.statusCounts).length > 0) {
            const bar = Object.entries(page.statusCounts)
              .map(([s, n]) => `${s}: ${n}`)
              .join(' · ');
            lines.push(`> ${bar}`);
          }
          lines.push('');

          // If --relations, attempt graph edges for the returned memories
          let relationEdges: Array<{ from: string; to: string; relation: string }> = [];
          if (includeRelations && Sage.graphFor && page.memories.length > 0) {
            const scanCount = Math.min(page.memories.length, 10);
            for (let i = 0; i < scanCount; i++) {
              const mem = page.memories[i]!;
              try {
                const edges = await Sage.graphFor(mem.id, 1, 50);
                for (const edge of edges) {
                  relationEdges.push({ from: edge.from, to: edge.to, relation: edge.relation });
                }
              } catch {
                // Best-effort
              }
            }
            // Deduplicate
            const seen = new Set<string>();
            relationEdges = relationEdges.filter((e) => {
              const key = `${e.from}|${e.relation}|${e.to}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          }

          // Render entries
          for (const mem of page.memories) {
            const kindEmoji = KIND_EMOJI[mem.kind as keyof typeof KIND_EMOJI] ?? '•';
            const textPreview = mem.text.length > 120 ? `${mem.text.slice(0, 118)}…` : mem.text;
            const tags = mem.tags.length > 0 ? ` 🏷️ ${mem.tags.map((t) => `\`${t}\``).join(' ')}` : '';
            lines.push(`> ${kindEmoji} **${textPreview}**`);
            lines.push(`> \`${mem.id}\` · ${mem.kind} · ${mem.status} · importance ${mem.importance} · confidence ${mem.confidence}`);
            if (tags) lines.push(`> ${tags.slice(1).trim()}`);
            // Anchor info
            const anchor = mem.anchors?.find((a: { path?: string | undefined; symbol?: string | undefined; command?: string | undefined }) => a.path || a.symbol || a.command);
            if (anchor) {
              lines.push(`> 📎 \`${anchor.path ?? anchor.symbol ?? anchor.command ?? ''}\``);
            }
            lines.push('');
          }

          // Render relations if gathered
          if (relationEdges.length > 0) {
            lines.push('### 🔗 Graph relations (first page)');
            lines.push('');
            for (const edge of relationEdges) {
              lines.push(`- ${edge.from} —[${edge.relation}]→ ${edge.to}`);
            }
            lines.push('');
          }

          // Footer
          const moreAvailable = page.total > page.memories.length;
          if (moreAvailable) {
            lines.push(`*Showing ${page.memories.length} of ${page.total} — use \`/memory gather --limit ${Math.min(MAX_MEMORY_LIMIT, limitVal * 2)}\` for more*`);
          }

          return { message: lines.join('\n') };
        } catch (err) {
          return { message: `Failed to gather memories: ${memErr(err)}` };
        }
      }

      const parsed = parseArgs(args);

      try {
        // ── Sage path ──────────────────────────────────────────────
        const Sage = getSageSurface(store);
        if (Sage) {
          // Fetch stats. Fetch the memory list via `listSagePage` when available
          // so we never load thousands of entries at once; otherwise fall back
          // to `listSage()` and slice to the configured limit.
          const stats = await Sage.stats();

          let allMemories: SageLike[];
          let sageTotal: number | undefined;

          if (Sage.listSagePage) {
            const page = await Sage.listSagePage({ limit: parsed.limit });
            allMemories = page.memories as unknown as SageLike[];
            sageTotal = page.total;
          } else {
            const full = (await Sage.listSage()) as unknown as SageLike[];
            sageTotal = full.length;
            allMemories = full.slice(0, parsed.limit);
          }

          if (sageTotal === 0 || allMemories.length === 0) {
            // Distinguish "store is empty" from "page filtered to nothing":
            // only show the empty-state copy when the underlying store has 0
            // memories; otherwise the user expects a filter-no-match message.
            if (sageTotal === 0) return { message: '🧠 SAGE is empty.' };
            // fall through with empty filteredMemories to render the filter
            // no-match message below.
          }

          // Apply filters on the (already bounded) page. We filter after
          // paging so the limit budget is used for the slice the user sees;
          // for very narrow filters the page can come back smaller than
          // `parsed.limit`, which is expected.
          let filteredMemories = allMemories;

          // Tag filter
          if (parsed.tag) {
            const tagLower = parsed.tag.toLowerCase();
            filteredMemories = filteredMemories.filter((m) =>
              m.tags.some((t) => t.toLowerCase() === tagLower),
            );
          }

          // Path filter — use retrieveForPath for path-based queries. We still
          // bound the resulting intersection by `parsed.limit`.
          if (parsed.path) {
            const pathMemories = await Sage.retrieveForPath({
              path: parsed.path,
              limit: parsed.limit,
              includeAncestors: true,
            });
            const pathIds = new Set(pathMemories.map((m) => m.id));
            filteredMemories = filteredMemories.filter((m) => pathIds.has(m.id));
          }

          const parts: string[] = [];

          // ── Stats panel ──
          parts.push(...renderSageStats(stats, allMemories, parsed.tag, parsed.path));

          // ── Entries ──
          if (filteredMemories.length > 0) {
            parts.push(...renderSageEntries(filteredMemories, parsed.compact));
          } else {
            parts.push('*No entries matched the filter.*');
            parts.push('');
          }

          // ── Footer ──
          const filterDesc: string[] = [];
          if (parsed.tag) filterDesc.push(`tag="${parsed.tag}"`);
          if (parsed.path) filterDesc.push(`path="${parsed.path}"`);
          const filterSuffix =
            filterDesc.length > 0 ? ` (filtered by ${filterDesc.join(', ')})` : '';
          const total = sageTotal ?? allMemories.length;
          const moreAvailable = total > filteredMemories.length;
          const moreHint = moreAvailable
            ? ` · showing ${parsed.limit} per page, use \`/memory --limit ${Math.min(
                MAX_MEMORY_LIMIT,
                parsed.limit * 2,
              )}\` (or \`/memory graph <query>\`) to see more`
            : '';
          parts.push(
            `*${filteredMemories.length} of ${total} SAGE entr${filteredMemories.length === 1 ? 'y' : 'ies'}${filterSuffix}${moreHint}*`,
          );

          return { message: parts.join('\n') };
        }

        // ── Legacy MemoryStore path ───────────────────────────────────────
        const trimmed = parsed.positional;
        const useCompact = parsed.compact;
        const scopeArg = trimmed.toLowerCase() as MemoryScope | '';

        const scopes: MemoryScope[] =
          scopeArg &&
          (['project-agents', 'project-memory', 'user-memory'] as const).includes(
            scopeArg as MemoryScope,
          )
            ? [scopeArg as MemoryScope]
            : ['project-agents', 'project-memory', 'user-memory'];

        const results = await Promise.all(
          scopes.map(async (scope) => {
            const entries = await store.list(scope);
            return { scope, entries };
          }),
        );

        const allEntries = results.flatMap((r) => r.entries);
        if (allEntries.length === 0) {
          return {
            message:
              '🧠 No memory entries found.\n\n> 💡 Enable **SAGE** (`Sage.enabled`) for structured memory with tags, paths, and graph relationships.',
          };
        }

        const parts: string[] = [];

        // Apply tag filter to legacy entries
        let filteredEntries = allEntries;
        if (parsed.tag) {
          const tagLower = parsed.tag.toLowerCase();
          filteredEntries = filteredEntries.filter((e) =>
            (e.tags ?? []).some((t) => t.toLowerCase() === tagLower),
          );
        }

        // ── Legacy stats (computed from the full filtered set so the bar
        // chart accurately reflects the filter, even if entries are capped
        // for display below).
        const globalStats = computeStats(filteredEntries);
        parts.push(...renderLegacySummary(globalStats));

        // Legacy migration hint
        parts.push(
          '> 💡 **SAGE** available — enables path anchoring, tags, graph, and structured queries.',
        );
        parts.push(
          '> Enable `Sage.enabled` in config, then run `/memory` for the full stats panel.',
        );
        parts.push('');

        // ── Cap displayed entries per-scope. The legacy `MemoryStore.list`
        // API does not support pagination, so we split the per-scope budget
        // evenly across the scopes the user is viewing. This still prevents
        // a single huge scope (e.g. 1000-entry project-memory) from flooding
        // the TUI.
        const scopeBudgets = new Map<MemoryScope, number>();
        // Only allocate budget to scopes that actually have entries; empty
        // scopes should not eat into the per-scope budget.
        const activeScopes = results.filter((r) => r.entries.length > 0).map((r) => r.scope);
        const activeCount = Math.max(1, activeScopes.length);
        const perScopeBudget = Math.max(1, Math.floor(parsed.limit / activeCount));
        let remainingBudget = parsed.limit;
        for (let i = 0; i < activeScopes.length; i++) {
          const scope = activeScopes[i]!;
          const budget = i === activeScopes.length - 1 ? remainingBudget : perScopeBudget;
          scopeBudgets.set(scope, budget);
          remainingBudget = Math.max(0, remainingBudget - budget);
        }
        // Scopes with no entries get zero budget explicitly.
        for (const scope of scopes) {
          if (!scopeBudgets.has(scope)) scopeBudgets.set(scope, 0);
        }

        if (useCompact) {
          for (const { scope, entries } of results) {
            if (entries.length === 0) continue;
            const scopeFiltered = parsed.tag
              ? entries.filter((e) =>
                  (e.tags ?? []).some((t) => t.toLowerCase() === (parsed.tag ?? '').toLowerCase()),
                )
              : entries;
            if (scopeFiltered.length === 0) continue;
            const budget = scopeBudgets.get(scope) ?? scopeFiltered.length;
            const capped = scopeFiltered.slice(0, budget);
            if (capped.length === 0) continue;
            parts.push('');
            parts.push(`---`);
            parts.push('');
            parts.push(`## ${SCOPE_LABEL[scope]} (${capped.length} of ${scopeFiltered.length})`);
            parts.push(...renderLegacyCompactList(capped));
          }
        } else {
          for (const { scope, entries } of results) {
            if (entries.length === 0) continue;
            const scopeFiltered = parsed.tag
              ? entries.filter((e) =>
                  (e.tags ?? []).some((t) => t.toLowerCase() === (parsed.tag ?? '').toLowerCase()),
                )
              : entries;
            if (scopeFiltered.length === 0) continue;
            const budget = scopeBudgets.get(scope) ?? scopeFiltered.length;
            const capped = scopeFiltered.slice(0, budget);
            if (capped.length === 0) continue;
            parts.push(...renderLegacyScopeSection(scope, capped));
          }
        }

        const scopeSuffix =
          scopes.length === 1 ? `in **${SCOPE_LABEL[scopes[0]!]}**` : 'across all scopes';
        const filterSuffix = parsed.tag ? ` (filtered by tag="${parsed.tag}")` : '';
        // Re-derive the displayed count from the capped slice so the footer
        // matches what the user actually sees.
        let displayed = 0;
        for (const { scope, entries } of results) {
          const budget = scopeBudgets.get(scope) ?? entries.length;
          const scopeFiltered = parsed.tag
            ? entries.filter((e) =>
                (e.tags ?? []).some((t) => t.toLowerCase() === (parsed.tag ?? '').toLowerCase()),
              )
            : entries;
          displayed += Math.min(scopeFiltered.length, budget);
        }
        const moreAvailable = filteredEntries.length > displayed;
        const moreHint = moreAvailable
          ? ` · showing up to ${parsed.limit}, use \`/memory --limit ${Math.min(
              MAX_MEMORY_LIMIT,
              parsed.limit * 2,
            )}\` to see more`
          : '';
        parts.push(
          `*${displayed} of ${filteredEntries.length} entr${filteredEntries.length === 1 ? 'y' : 'ies'} ${scopeSuffix}${filterSuffix}${moreHint}*`,
        );

        return { message: parts.join('\n') };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { message: `Failed to read memory store: ${msg}` };
      }
    },
  };
}

// ── Legacy scope section (extracted for clarity) ────────────────────────────

function renderLegacyScopeSection(scope: MemoryScope, entries: MemoryEntry[]): string[] {
  if (entries.length === 0) return [];

  const lines: string[] = [];
  lines.push('');
  lines.push(`---`);
  lines.push('');
  lines.push(`## ${SCOPE_LABEL[scope]} (${entries.length})`);
  lines.push('');

  for (const e of entries) {
    lines.push(renderLegacyEntry(e));
    lines.push('');
  }

  return lines;
}
