import { toErrorMessage } from '@wrongstack/core/utils';
import { getSageSurface } from '@wrongstack/sage';
import type { SlashCommandContext } from './command-context.js';

// ── /memory compact — LLM-driven memory review and optimization ────────

interface CompactOperation {
  action: 'keep' | 'rewrite' | 'merge' | 'delete';
  /** For rewrite/merge/delete: the memory entry IDs or search queries to match. */
  targets: string[];
  /** For rewrite/merge: the new text. For keep: unused. */
  newText?: string | undefined;
  /** Reason for the operation — shown in the summary. */
  reason: string;
}

interface CompactResponse {
  operations: CompactOperation[];
  /** Optional summary of what was done. */
  summary?: string | undefined;
}

/**
 * System prompt template for the memory compact LLM call.
 * `__ENTRIES__` is replaced with the formatted entry list at call time.
 * Kept as a module-level constant so the prompt text can be reviewed and
 * iterated on independently of the call logic.
 */
const COMPACT_SYSTEM_PROMPT = `You are a memory curator. Your task is to review, deduplicate, and improve a set of long-term memory entries.

These entries are injected into the context of an AI coding agent. Every token counts. The memory must be concise, accurate, and free of noise.

## Current Memory Entries

__ENTRIES__

## Your Task

Review each entry and return a JSON object with an "operations" array. Each operation targets one or more entries:

### Actions

- **"keep"** — The entry is valuable as-is. Include it in the operations so I know you reviewed it.
- **"rewrite"** — The entry has value but needs better wording. Provide improved "newText". Target a single entry.
- **"merge"** — Two or more entries say essentially the same thing. Combine them into one concise entry. The "targets" should list all entries being merged. Provide the combined "newText".
- **"delete"** — The entry is obsolete, redundant, too vague, or not useful for future sessions. Target one or more entries.

### Rules

1. **Be ruthless about noise.** If an entry won't help a future AI agent do its job better, delete it.
2. **Deduplicate aggressively.** Similar entries should be merged. Identical entries MUST be merged.
3. **Keep entries concise.** Each entry should be one clear sentence. Remove filler words.
4. **Preserve factual accuracy.** Don't change the meaning of entries unless they're wrong.
5. **Handle every entry.** Every entry must appear in at least one operation (keep, rewrite, merge, or delete).
6. **Prefer quality over quantity.** 10 excellent entries > 30 mediocre ones.
7. **Tag entries appropriately.** If an entry mentions a technology or concept that could be tagged, suggest tags in the newText using #hashtag syntax.

### Response Format

Return ONLY valid JSON with this structure:

{
  "operations": [
    { "action": "keep",    "targets": ["mem_1234_abcd"], "reason": "Clear and useful" },
    { "action": "rewrite", "targets": ["mem_5678_ef01"], "newText": "Project uses pnpm v9 with ESM-only modules #pnpm #esm", "reason": "Added version and ESM detail" },
    { "action": "merge",   "targets": ["mem_aaaa_1111", "mem_bbbb_2222"], "newText": "All packages use TypeScript strict mode with noUncheckedIndexedAccess #typescript", "reason": "Two entries about TS config, merged" },
    { "action": "delete",  "targets": ["mem_cccc_3333"], "reason": "Obsolete — was a temporary debug note" }
  ],
  "summary": "Merged 2 TS entries, rewrote 1 for clarity, deleted 1 obsolete note. 12 entries → 10 entries."
}

Use the EXACT entry IDs from the list above for "targets". No markdown, no explanation outside the JSON.`;

/**
 * Build the system prompt for the memory compact LLM call.
 * Interpolates the entry list into the shared template.
 */
function buildCompactPrompt(entries: CompactEntry[]): string {
  const entriesBlock = entries
    .map(
      (e, i) =>
        `${i + 1}. [${e.ts.slice(0, 10)}] ${e.id}\n   ${e.text}${e.tags ? `\n   tags: ${e.tags.join(', ')}` : ''}${e.type ? `\n   type: ${e.type}` : ''}${e.priority ? `\n   priority: ${e.priority}` : ''}`,
    )
    .join('\n\n');

  return COMPACT_SYSTEM_PROMPT.replace('__ENTRIES__', entriesBlock);
}

interface CompactEntry {
  id: string;
  text: string;
  ts: string;
  type?: string | undefined;
  tags?: string[] | undefined;
  priority?: string | undefined;
}

export async function runCompact(opts: SlashCommandContext): Promise<{ message: string }> {
  const store = opts.memoryStore;
  if (!store) return { message: 'No memory store configured.' };

  // 1. Gather current entries with their REAL ids + metadata.
  // SAGE is the live backend: pull structured memories directly so
  // operations target real memory ids (updateSage/deleteSage).
  // The legacy text-parsing path is only a fallback for a non-SAGE store.
  const sageStore = getSageSurface(store);
  let compactEntries: CompactEntry[];
  if (sageStore) {
    const memories = await sageStore.listSage(['active', 'stale']);
    if (memories.length === 0) {
      return { message: 'Memory is empty — nothing to compact.' };
    }
    compactEntries = memories.map((m) => ({
      id: m.id,
      text: m.text,
      ts: m.createdAt,
      type: m.kind,
      tags: m.tags.length > 0 ? m.tags : undefined,
    }));
  } else {
    const entries = await store.list('project-memory');
    if (entries.length === 0) {
      return { message: 'Memory is empty — nothing to compact.' };
    }
    const raw = await store.read('project-memory');
    compactEntries = parseCompactEntries(raw);
    if (compactEntries.length === 0) {
      return { message: 'No parseable entries found.' };
    }
  }

  // 2. Check for LLM provider
  const provider = opts.llmProvider;
  if (!provider?.complete) {
    return {
      message:
        'No LLM provider available. /memory compact requires an active session with a configured provider.',
    };
  }

  // 3. Build prompt and call LLM
  const prompt = buildCompactPrompt(compactEntries);

  let responseText: string;
  try {
    const signal = AbortSignal.timeout(30_000);
    const response = await provider.complete(
      {
        model: opts.llmModel ?? '',
        system: [{ type: 'text', text: prompt }],
        messages: [
          {
            role: 'user',
            content: `Review the ${compactEntries.length} memory entries above and return operations as JSON.`,
          },
        ],
        maxTokens: 2000,
        temperature: 0.1, // low temperature for deterministic curation
      },
      { signal },
    );

    responseText = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    return {
      message: `LLM call failed: ${toErrorMessage(err)}`,
    };
  }

  if (!responseText) {
    return { message: 'LLM returned empty response.' };
  }

  // 4. Parse the JSON response
  let parsed: CompactResponse;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { message: `LLM response is not valid JSON:\n${responseText.slice(0, 500)}` };
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return {
      message: `Failed to parse LLM response: ${toErrorMessage(err)}\n\nRaw response:\n${responseText.slice(0, 500)}`,
    };
  }

  if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) {
    return { message: 'LLM returned no operations.' };
  }

  // 5. Apply operations
  let kept = 0;
  let rewritten = 0;
  let merged = 0;
  let deleted = 0;
  const errors: string[] = [];

  for (const op of parsed.operations) {
    try {
      switch (op.action) {
        case 'keep': {
          kept += op.targets.length;
          break;
        }
        case 'rewrite': {
          if (!op.newText) {
            errors.push(`rewrite missing newText for targets: ${op.targets.join(', ')}`);
            continue;
          }
          if (sageStore) {
            // Edit the first target in place (preserves id/anchors/graph edges);
            // delete any extra targets folded into the rewrite.
            const [first, ...rest] = op.targets;
            if (first) await sageStore.updateSage(first, { text: op.newText });
            for (const t of rest) {
              await sageStore.deleteSage(t, 'compact: rewrite', { force: true });
            }
          } else {
            for (const target of op.targets) await store.forget(target);
            await store.remember(op.newText);
          }
          rewritten++;
          break;
        }
        case 'merge': {
          if (!op.newText) {
            errors.push(`merge missing newText for targets: ${op.targets.join(', ')}`);
            continue;
          }
          if (sageStore) {
            // Keep the first memory (update its text), delete the rest.
            const [keeper, ...rest] = op.targets;
            if (keeper) await sageStore.updateSage(keeper, { text: op.newText });
            for (const t of rest) {
              await sageStore.deleteSage(t, 'compact: merged', { force: true });
            }
          } else {
            for (const target of op.targets) await store.forget(target);
            await store.remember(op.newText);
          }
          merged++;
          break;
        }
        case 'delete': {
          if (sageStore) {
            for (const target of op.targets) {
              await sageStore.deleteSage(target, 'compact: obsolete', { force: true });
            }
          } else {
            for (const target of op.targets) await store.forget(target);
          }
          deleted += op.targets.length;
          break;
        }
        default: {
          errors.push(`unknown action "${(op as { action: string }).action}"`);
        }
      }
    } catch (err) {
      errors.push(`${op.action} failed for ${op.targets.join(', ')}: ${toErrorMessage(err)}`);
    }
  }

  // 6. Build summary
  const lines: string[] = ['## Memory Compact — Complete'];
  const stats: string[] = [];
  if (kept > 0) stats.push(`${kept} kept`);
  if (rewritten > 0) stats.push(`${rewritten} rewritten`);
  if (merged > 0) stats.push(`${merged} merged`);
  if (deleted > 0) stats.push(`${deleted} deleted`);
  lines.push(`**Result:** ${stats.join(', ')}`);
  lines.push(
    `**Before:** ${compactEntries.length} entries → **After:** ${kept + rewritten + merged} entries`,
  );

  if (parsed.summary) {
    lines.push('');
    lines.push(parsed.summary);
  }

  // Show per-operation details
  lines.push('');
  lines.push('### Operations');
  for (const op of parsed.operations) {
    const icon =
      op.action === 'keep'
        ? '✓'
        : op.action === 'rewrite'
          ? '✏️'
          : op.action === 'merge'
            ? '🔀'
            : op.action === 'delete'
              ? '✗'
              : '?';
    const detail = op.newText ? ` → "${op.newText}"` : '';
    lines.push(`- ${icon} **${op.action}** ${op.targets.join(', ')}${detail}`);
    if (op.reason) lines.push(`  _${op.reason}_`);
  }

  if (errors.length > 0) {
    lines.push('');
    lines.push('### Errors');
    for (const err of errors) {
      lines.push(`- ⚠️ ${err}`);
    }
  }

  return { message: lines.join('\n') };
}

/**
 * Parse raw memory content into compact entries with IDs.
 * Each line: `- [ISO] [type|priority] mem_<id> text #tags`
 */
function parseCompactEntries(raw: string): CompactEntry[] {
  const entries: CompactEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- [')) continue;

    // Extract entry ID: mem_<ts>_<rand>
    const idMatch = trimmed.match(/mem_(\d+_\w+)/);
    if (!idMatch) continue;
    const id = idMatch[0] ?? '';
    const afterId = trimmed.slice((idMatch.index ?? 0) + id.length).trim();

    // Extract timestamp
    const tsMatch = trimmed.match(/^-\s*\[([^\]]+)\]/);
    const ts = tsMatch?.[1] ?? '';

    // Extract #tags
    const tags: string[] = [];
    const tagRe = /#([\w-]+)/g;
    let tm: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((tm = tagRe.exec(afterId)) !== null) {
      tags.push(tm[1] ?? '');
    }

    // Clean text (remove tags)
    const text = afterId
      .replace(tagRe, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!text) continue;

    entries.push({ id, text, ts, tags: tags.length > 0 ? tags : undefined });
  }
  return entries;
}
