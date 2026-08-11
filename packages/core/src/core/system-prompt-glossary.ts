/**
 * `[Project Jargon Dictionary]` block for the agent system prompt.
 *
 * The block is rendered FROM the same SAGE port the agent uses for
 * all other memory context — never from `@wrongstack/sage-mcp`.
 * Per the SAGE architectural rule (see `packages/sage/docs/direct-icp-usage.md`
 * §1, "The architectural rule"), in-process consumers like the system-prompt
 * builder must consume SAGE through `ProjectSageMemoryPort`/`SqliteMemoryPort`
 * only. MCP is for external consumers; reading the glossary through MCP would
 * open a second writer to the same SQLite file.
 *
 * This module is therefore intentionally `MemoryStore`-shaped rather than
 * typed against the SAGE surface directly, so the prompt-builder stays
 * core-level (no `@wrongstack/sage` import — `core` does not depend on
 * `sage`). The host (CLI/TUI/WebUI) constructs the `SageDomainTermExtractor`
 * against its own SAGE port and stitches it onto the builder via the
 * `injectDomainGlossary` helper.
 *
 * Implementation note — the minimal-dictionary format:
 *   We render at most `maxEntries` bullets (default 12, configurable per
 *   token-saving tier) of `**Term** — short definition`. Definitions are
 *   capped at `maxEntryChars` chars per bullet (default 80) so the block
 *   always fits inside ~1k tokens. The format mirrors what the agent would
 *   otherwise have to re-derive by reading every recalled SAGE memory, which
 *   is the exact token-cost the design reduces.
 */
import type { MemoryEntry, MemoryStore } from '../types/memory.js';
import type { BuildContext } from '../types/system-prompt.js';

export interface DomainGlossaryOptions {
  /** Max number of bullets. Default 12. */
  maxEntries?: number | undefined;
  /** Max chars per bullet line (after the **Term** header). Default 80. */
  maxEntryChars?: number | undefined;
}

/**
 * Probe whether a `MemoryStore` exposes the SAGE glossary shape.
 *
 * SAGE backs every glossary entry as a `MemoryEntry` with the
 * `domain-term` tag in `tags`. The contract this probe checks:
 *   - memory.list / memory.search / memory.read exists
 *   - any returned entry with `tags` including `domain-term` is a glossary entry
 *
 * The probe intentionally avoids coupling to `@wrongstack/sage` types —
 * `core` does not depend on `sage`. Non-SAGE stores return `null` and the
 * caller treats the dictionary as missing.
 */
function findDomainGlossaryEntries(memory: MemoryStore): Promise<ReadonlyArray<MemoryEntry>> {
  // Best effort: prefer `list` then `search`. Stop on first non-empty bucket.
  return safeList(memory, { limit: 200 })
    .then((rows) => rows ?? [])
    .then((rows) =>
      rows.filter(
        (r) => Array.isArray(r?.tags) && (r.tags as readonly string[]).includes('domain-term'),
      ),
    );
}

async function safeList(
  memory: MemoryStore,
  opts: { limit: number },
): Promise<ReadonlyArray<MemoryEntry> | null> {
  try {
    const rows = await memory.list('project-memory', opts.limit);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows;
  } catch {
    return null;
  }
}

const GLOSSARY_HEADING =
  '# Project Jargon Dictionary (auto-mined from SAGE; update via SageDomainTermExtractor)';

/**
 * Build the minimal `[Project Jargon Dictionary]` block.
 *
 * Returns:
 *   - `null` when the memory store is missing or doesn't expose the glossary
 *     shape — never throw; the prompt builder logs and continues.
 *   - an empty string when the memory store has no glossary entries.
 *   - a markdown block capped at `maxEntries` × `maxEntryChars` otherwise.
 *
 * The block is prefixed with a clear provenance heading so the agent
 * understands the source and can override / refresh at runtime via
 * the SAGE tooling. The trailing line lists the lookup tag for grep
 * parity (`domain-term`).
 */
export async function renderDomainGlossary(
  ctx: BuildContext,
  memory: MemoryStore | undefined,
  options: DomainGlossaryOptions = {},
): Promise<string | null> {
  if (!memory) return null;
  const maxEntries = options.maxEntries ?? 12;
  const maxEntryChars = options.maxEntryChars ?? 80;

  const entries = await findDomainGlossaryEntries(memory);
  if (entries.length === 0) return '';

  // Stable sort: highest confidence first, then most recent ts. The
  // Sort uses lexical ts order as a tiebreaker — ISO-8601 is monotonic,
  // so equal-confidence entries keep the most recent first.
  const sorted = [...entries].sort((a, b) => {
    const dc = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (dc !== 0) return dc;
    return b.ts.localeCompare(a.ts);
  });

  const lines: string[] = [GLOSSARY_HEADING, ''];
  let emitted = 0;
  for (const entry of sorted) {
    if (emitted >= maxEntries) break;
    const { term, definition } = parseTermEntry(entry.text);
    if (!term) continue;
    const def = (definition || '').slice(0, maxEntryChars).trim();
    lines.push(def ? `- **${term}** — ${def}` : `- **${term}**`);
    emitted += 1;
  }

  if (emitted === 0) return '';

  lines.push('');
  lines.push(
    `_Source: <${ctx.projectRoot}>/.wrongstack/domain-terms.md (auto-generated; do not edit by hand)._`,
  );
  lines.push(
    '_Lookup tag: `domain-term` (search: `memory_search({ query: "domain-term", scope: "project-memory" })`)._',
  );

  return lines.join('\n');
}

/**
 * Wire a glossary block into a `DefaultSystemPromptBuilder` via the
 * existing `contributors` channel (see `system-prompt-contributor.ts`).
 *
 * Use from the host (CLI/TUI/WebUI) like this:
 *
 *   const builder = new DefaultSystemPromptBuilder({
 *     ...other opts,
 *     contributors: [
 *       ...DefaultSystemPromptBuilder.defaultContributors({ projectRoot }),
 *       makeDomainGlossaryContributor({ memory: sagePort }),
 *     ],
 *   });
 *
 * The contributor returns `[]` for non-SAGE stores so the prompt stays clean.
 */
/**
 * Parse a stored glossary text back into (term, definition).
 *
 * Storing format: `${term} — ${definition}` (em-dash with spaces,
 * see `packages/sage/src/domain-term-extractor.ts` for the canonical
 * shape). Falls back gracefully on missing definitions.
 */
function parseTermEntry(text: string): { term: string; definition: string } {
  const trimmed = text.trim();
  const idx = trimmed.indexOf(' \u2014 ');
  if (idx > 0) {
    return {
      term: trimmed.slice(0, idx).trim(),
      definition: trimmed.slice(idx + 3).trim(),
    };
  }
  // No separator — treat the whole text as the term, empty definition.
  return { term: trimmed, definition: '' };
}
