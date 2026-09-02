import { toErrorMessage } from '@wrongstack/core/utils';
import type { SageSurface } from '@wrongstack/sage';
import { getSageSurface } from '@wrongstack/sage';
import type { SlashCommandContext } from './command-context.js';
import { requiresSage } from './memory-formatters.js';

export async function runPathMemory(
  store: NonNullable<SlashCommandContext['memoryStore']>,
  targetPath: string,
  includeAncestors: boolean,
): Promise<{ message: string }> {
  const Sage = getSageSurface(store);
  if (!Sage) {
    return {
      message:
        '`/memory file` requires the SAGE backend. Enable `Sage.enabled` and restart the session.',
    };
  }
  const memories = await Sage.retrieveForPath({
    path: targetPath,
    limit: 20,
    includeAncestors,
  });
  if (memories.length === 0) {
    return { message: `No SAGE entries are attached to ${targetPath}.` };
  }
  const lines = [`## SAGE for ${targetPath}`];
  for (const memory of memories) {
    const tags = memory.tags.length > 0 ? ` ${memory.tags.map((tag) => `#${tag}`).join(' ')}` : '';
    const anchor = memory.anchors.find((a) => a.path || a.symbol || a.command);
    const anchorText = anchor
      ? `\n  anchor: ${anchor.path ?? anchor.symbol ?? anchor.command}`
      : '';
    lines.push(`- [${memory.kind}|${memory.status}] ${memory.text}${tags}${anchorText}`);
  }
  return { message: lines.join('\n') };
}

export async function runGatherCommand(
  Sage: SageSurface | null | undefined,
  rest: string[],
): Promise<{ message: string }> {
  if (!Sage?.listSagePage) return requiresSage('gather');
  // Token-based flag parsing (avoids regex greedily consuming next flag)
  let limit = 50;
  let statusVal: string | undefined;
  let kindVal: string | undefined;
  let includeRelations = false;
  const queryTokens: string[] = [];
  const gatherErrors: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (!token.startsWith('--')) {
      queryTokens.push(token);
      continue;
    }
    const name = token.slice(2).toLowerCase();
    const next = rest[i + 1];

    if (name === 'limit') {
      if (next === undefined || next.startsWith('--')) {
        gatherErrors.push('--limit needs a value between 1 and 500.');
        continue;
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        gatherErrors.push(`--limit must be a positive integer (got "${next}").`);
        continue;
      }
      limit = Math.min(500, Math.max(1, parsed));
      i++;
    } else if (name === 'status') {
      if (next === undefined || next.startsWith('--')) {
        gatherErrors.push('--status needs a value.');
        continue;
      }
      statusVal = next;
      i++;
    } else if (name === 'kind') {
      if (next === undefined || next.startsWith('--')) {
        gatherErrors.push('--kind needs a value.');
        continue;
      }
      kindVal = next;
      i++;
    } else if (name === 'relations') {
      includeRelations = true;
    } else {
      gatherErrors.push(`Unknown flag "--${name}".`);
    }
  }

  const query = queryTokens.join(' ').trim();
  if (gatherErrors.length > 0) {
    return { message: `Cannot gather:\n- ${gatherErrors.join('\n- ')}` };
  }

  // Runtime-validate --status against known SageStatus values
  const VALID_STATUSES = [
    'active',
    'stale',
    'superseded',
    'contradicted',
    'archived',
    'deleted',
  ] as const;
  if (statusVal !== undefined && !(VALID_STATUSES as readonly string[]).includes(statusVal)) {
    return {
      message: `Invalid --status "${statusVal}". Valid: ${VALID_STATUSES.join(', ')}`,
    };
  }
  const resolvedStatus = statusVal as (typeof VALID_STATUSES)[number] | undefined;

  // Runtime-validate --kind against known SageKind values
  const VALID_KINDS = [
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
    'memory_review',
  ] as const;
  if (kindVal !== undefined && !(VALID_KINDS as readonly string[]).includes(kindVal)) {
    return { message: `Invalid --kind "${kindVal}". Valid: ${VALID_KINDS.join(', ')}` };
  }

  try {
    const page = await Sage.listSagePage({
      statuses: resolvedStatus ? [resolvedStatus] : ['active'],
      kind: kindVal,
      query: query || undefined,
      limit,
      // Admin surface: the user running this command owns every session in the
      // project, so it opts out of the session filter the agent-facing tools
      // rely on. Without this, session-scoped memories vanish from the listing.
      includeAllSessions: true,
    });
    if (page.memories.length === 0) {
      return { message: 'No memories matched the gather criteria.' };
    }
    // Build output
    const lines: string[] = [];
    lines.push(`## 📋 Memory Gather — ${page.total} matched`);
    lines.push(
      `Filter: status=${resolvedStatus ?? 'active'}${kindVal ? `, kind=${kindVal}` : ''}${query ? `, query="${query}"` : ''}`,
    );
    if (page.statusCounts && Object.keys(page.statusCounts).length > 0) {
      const bar = Object.entries(page.statusCounts)
        .map(([s, n]) => `${s}: ${n}`)
        .join(', ');
      lines.push(`Status counts: ${bar}`);
    }
    lines.push('');
    for (const mem of page.memories) {
      const preview = mem.text.length > 120 ? `${mem.text.slice(0, 118)}…` : mem.text;
      lines.push(
        `  ${mem.kind} [${mem.importance.toFixed(2)}|${mem.confidence.toFixed(2)}] ${mem.id} — ${preview}`,
      );
    }
    // Relations (requires graphFor on the backend)
    if (includeRelations) {
      if (!Sage.graphFor) {
        lines.push('');
        lines.push('*(Relations requested but graphFor is not available on this backend)*');
      } else {
        const edges: Array<{ from: string; to: string; relation: string }> = [];
        const scanCount = Math.min(page.memories.length, 10);
        for (let i = 0; i < scanCount; i++) {
          const mem = page.memories[i];
          if (!mem) continue;
          try {
            const graph = await Sage.graphFor(mem.id, 1, 50);
            for (const edge of graph) {
              edges.push({ from: edge.from, to: edge.to, relation: edge.relation });
            }
          } catch {
            /* best-effort */
          }
        }
        // Deduplicate
        const seen = new Set<string>();
        const deduped = edges.filter((e) => {
          const key = `${e.from}|${e.relation}|${e.to}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (deduped.length > 0) {
          lines.push('');
          lines.push('### 🔗 Relations (first page)');
          for (const edge of deduped) {
            lines.push(`  ${edge.from} —[${edge.relation}]→ ${edge.to}`);
          }
        }
      }
    }
    const moreAvailable = page.total > page.memories.length;
    if (moreAvailable) {
      lines.push('');
      lines.push(
        `*Showing ${page.memories.length} of ${page.total} — use --limit ${Math.min(500, limit * 2)} for more*`,
      );
    }
    return { message: lines.join('\n') };
  } catch (err) {
    return { message: `gather failed: ${toErrorMessage(err)}` };
  }
}
