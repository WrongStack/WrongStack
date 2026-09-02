import type { MemoryPort, MemoryScope } from '@wrongstack/core/types';
import { getSageSurface } from '@wrongstack/sage';
import { KIND_EMOJI, SCOPE_LABEL } from './memory-slash-format.js';
import {
  computeStats,
  type SageLike,
  renderSageStats,
  renderSageEntries,
  renderLegacySummary,
  renderLegacyCompactList,
  renderLegacyScopeSection,
} from './memory-slash-render.js';
import {
  handleMemoryWrite,
  MEMORY_WRITE_SUBS,
  MEMORY_KIND_VALUES,
  MEMORY_STATUS_VALUES,
  memErr,
} from './memory-slash-write.js';

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
        const limitVal = limitMatch
          ? Math.min(MAX_MEMORY_LIMIT, Math.max(1, Number.parseInt(limitMatch[1]!, 10)))
          : DEFAULT_MEMORY_LIMIT;
        // Positional query: strip flags — use exact token matching for --relations,
        // regex for flags that carry a value argument
        const query = remainingTokens
          .filter((t) => t !== '--relations')
          .join(' ')
          .replace(/--status\s+\w+/g, '')
          .replace(/--kind\s+\w+/g, '')
          .replace(/--limit\s+\d+/g, '')
          .trim();

        // Runtime-validate --status against known SageStatus values
        if (
          statusVal !== undefined &&
          !(MEMORY_STATUS_VALUES as readonly string[]).includes(statusVal)
        ) {
          return {
            message: `Invalid --status "${statusVal}". Valid: ${MEMORY_STATUS_VALUES.join(', ')}`,
          };
        }
        if (kindVal !== undefined && !(MEMORY_KIND_VALUES as readonly string[]).includes(kindVal)) {
          return {
            message: `Invalid --kind "${kindVal}". Valid: ${MEMORY_KIND_VALUES.join(', ')}`,
          };
        }
        const resolvedStatus = statusVal as (typeof MEMORY_STATUS_VALUES)[number] | undefined;

        try {
          const page = await Sage.listSagePage({
            statuses: resolvedStatus ? [resolvedStatus] : ['active'],
            kind: kindVal,
            query: query || undefined,
            limit: limitVal,
            // Admin surface: the user running this command owns every session in the
            // project, so it opts out of the session filter the agent-facing tools
            // rely on. Without this, session-scoped memories vanish from the listing.
            includeAllSessions: true,
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
            const tags =
              mem.tags.length > 0 ? ` 🏷️ ${mem.tags.map((t) => `\`${t}\``).join(' ')}` : '';
            lines.push(`> ${kindEmoji} **${textPreview}**`);
            lines.push(
              `> \`${mem.id}\` · ${mem.kind} · ${mem.status} · importance ${mem.importance} · confidence ${mem.confidence}`,
            );
            if (tags) lines.push(`> ${tags.slice(1).trim()}`);
            // Anchor info
            const anchor = mem.anchors?.find(
              (a: {
                path?: string | undefined;
                symbol?: string | undefined;
                command?: string | undefined;
              }) => a.path || a.symbol || a.command,
            );
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
            lines.push(
              `*Showing ${page.memories.length} of ${page.total} — use \`/memory gather --limit ${Math.min(MAX_MEMORY_LIMIT, limitVal * 2)}\` for more*`,
            );
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
            const page = await Sage.listSagePage({
              limit: parsed.limit,
              // Admin surface — see the note on the gather listing above.
              includeAllSessions: true,
            });
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
            parts.push(...renderSageEntries(filteredMemories, parsed.compact, Date.now()));
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
        const globalStats = computeStats(filteredEntries, Date.now());
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
            parts.push(...renderLegacyScopeSection(scope, capped, Date.now()));
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
