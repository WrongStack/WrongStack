import type { MemoryPort } from '@wrongstack/core/types';
import { getSageSurface } from '@wrongstack/sage';
import { KIND_EMOJI } from './memory-slash-format.js';
import { memErr } from './memory-slash-renderers.js';
import {
  DEFAULT_MEMORY_LIMIT,
  MAX_MEMORY_LIMIT,
  MEMORY_KIND_VALUES,
  MEMORY_STATUS_VALUES,
} from './memory-slash-types.js';

export async function handleGraphSubcommand(
  store: MemoryPort,
  tokens: string[],
): Promise<{ message: string }> {
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

export async function handleGatherSubcommand(
  store: MemoryPort,
  tokens: string[],
): Promise<{ message: string }> {
  const Sage = getSageSurface(store);
  if (!Sage?.listSagePage) {
    return { message: '`/memory gather` requires the SAGE page listing backend.' };
  }

  const remaining = tokens.slice(1).join(' ').trim();
  const remainingTokens = remaining.split(/\s+/);
  const includeRelations = remainingTokens.includes('--relations');
  const statusMatch = remaining.match(/--status\s+(\w+)/);
  const statusVal = statusMatch?.[1];
  const kindMatch = remaining.match(/--kind\s+(\w+)/);
  const kindVal = kindMatch?.[1];
  const limitMatch = remaining.match(/--limit\s+(\d+)/);
  const limitVal = limitMatch
    ? Math.min(MAX_MEMORY_LIMIT, Math.max(1, Number.parseInt(limitMatch[1]!, 10)))
    : DEFAULT_MEMORY_LIMIT;

  const query = remainingTokens
    .filter((t) => t !== '--relations')
    .join(' ')
    .replace(/--status\s+\w+/g, '')
    .replace(/--kind\s+\w+/g, '')
    .replace(/--limit\s+\d+/g, '')
    .trim();

  if (statusVal !== undefined && !(MEMORY_STATUS_VALUES as readonly string[]).includes(statusVal)) {
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
      const seen = new Set<string>();
      relationEdges = relationEdges.filter((e) => {
        const key = `${e.from}|${e.relation}|${e.to}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    for (const mem of page.memories) {
      const kindEmoji = KIND_EMOJI[mem.kind as keyof typeof KIND_EMOJI] ?? '•';
      const textPreview = mem.text.length > 120 ? `${mem.text.slice(0, 118)}…` : mem.text;
      const tags = mem.tags.length > 0 ? ` 🏷️ ${mem.tags.map((t) => `\`${t}\``).join(' ')}` : '';
      lines.push(`> ${kindEmoji} **${textPreview}**`);
      lines.push(
        `> \`${mem.id}\` · ${mem.kind} · ${mem.status} · importance ${mem.importance} · confidence ${mem.confidence}`,
      );
      if (tags) lines.push(`> ${tags.slice(1).trim()}`);
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

    if (relationEdges.length > 0) {
      lines.push('### 🔗 Graph relations (first page)');
      lines.push('');
      for (const edge of relationEdges) {
        lines.push(`- ${edge.from} —[${edge.relation}]→ ${edge.to}`);
      }
      lines.push('');
    }

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
