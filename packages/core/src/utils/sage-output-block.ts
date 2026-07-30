/**
 * sage-output-block — split the SAGE Memory Injector suffix off a tool result.
 *
 * The SAGE middleware (`packages/sage/src/middleware/tool-call-memory.ts`)
 * appends a `--- SAGE: … (Memory Injector) ---` block to the tool result
 * content the model sees. That block is *memory*, not tool output, and every
 * surface renders it as its own card (TUI `SageMemoryBlock`, WebUI
 * `SageMemoryCard`).
 *
 * Surfaces used to recover the block by re-parsing the `tool.executed` event
 * `output` string — which is a ~400-char preview. When a tool's own output was
 * short (glob/grep/tree hits), the cut landed *inside* the appended memory
 * line: the `</memory>` fence was gone, the memory-line regex rejected the
 * candidate, and the whole block fell through to the plain tool-output
 * renderer. The result was raw `--- SAGE: … ---` text dumped into the chat.
 *
 * So the split happens HERE, at the emit site, before any truncation:
 * `tool.executed.output` carries tool text only and the block travels
 * separately in `tool.executed.sage`. Surfaces that don't know about SAGE show
 * clean tool output instead of leaking the block, and surfaces that do render
 * a card from structured lines instead of a regex over a truncated string.
 *
 * The headings and the memory-line shape mirror
 * `packages/tui/src/components/history/sage-output-format.ts` and
 * `packages/webui/src/lib/sage-block.ts`. Those two keep their own copies
 * because they also parse *replayed* sessions, where the block is still inline
 * in the persisted `tool_result` content. All three must agree.
 */

export interface SageOutputSplit {
  /** Tool result text with the SAGE block removed (trailing whitespace trimmed). */
  body: string;
  /**
   * The SAGE block including its `--- SAGE: …` header line, or empty when the
   * input has no terminal SAGE suffix. Trailing blank lines are excluded.
   */
  sageLines: string[];
}

/** Exact heading lines emitted by `formatMemoryHintsDetailed()`. */
export const SAGE_INJECTOR_HEADINGS: ReadonlySet<string> = new Set([
  '--- SAGE: task-aware project knowledge (Memory Injector) ---',
  '--- SAGE: related project knowledge (Memory Injector) ---',
]);

/**
 * A complete memory line, as produced by `formatMemoryHintsDetailed()` in
 * `packages/sage/src/retrieval/format.ts`:
 *
 *   `- [kind][priority] <memory id="…">escaped text</memory> (anchor) [relation=…; tags=…]`
 *
 * The `(anchor)` / `[relation=…]` trailers are optional.
 */
const SAGE_MEMORY_LINE = /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*<\/memory>(?: .*)?$/;

/**
 * A memory line whose tail was cut by an upstream character cap (the `…`
 * marker `truncateForEvent` and the fleet/HQ bridges append). Accepted only as
 * the LAST line of a candidate block: the `- [labels] <memory id="…">` prefix
 * is specific enough that no ordinary tool output produces it, so recognising
 * the fragment keeps a truncated block rendering as memory rather than
 * decaying into raw tool text. Anything after such a fragment disqualifies the
 * candidate, exactly as an unmatched line would.
 */
const SAGE_MEMORY_LINE_TRUNCATED = /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*…$/;

/**
 * Find the last SAGE suffix in `output` and split it away from the tool text.
 *
 * - Scans from the end, so a `--- SAGE:` string inside the tool body never
 *   steals the real trailing block.
 * - Every non-blank line after the header must be a memory line (the last one
 *   may be a truncated fragment); otherwise the candidate is rejected and the
 *   header is treated as ordinary tool output.
 * - Trailing blank lines are tolerated but excluded from `sageLines`.
 */
export function splitSageOutputBlock(output: string): SageOutputSplit {
  if (!output.includes('--- SAGE: ')) return { body: output, sageLines: [] };
  const lines = output.split('\n');
  for (let sageIdx = lines.length - 1; sageIdx >= 0; sageIdx--) {
    if (!SAGE_INJECTOR_HEADINGS.has(lines[sageIdx] ?? '')) continue;
    const candidate = lines.slice(sageIdx);
    if (candidate.length < 2) continue;
    const memoryLines = candidate.slice(1).filter((line) => line.trim().length > 0);
    if (memoryLines.length === 0) continue;
    const bodyOk = memoryLines.every(
      (line, index) =>
        SAGE_MEMORY_LINE.test(line) ||
        (index === memoryLines.length - 1 && SAGE_MEMORY_LINE_TRUNCATED.test(line)),
    );
    if (!bodyOk) continue;
    let end = candidate.length;
    while (end > 1 && candidate[end - 1]!.trim().length === 0) end--;
    return {
      body: lines.slice(0, sageIdx).join('\n').trimEnd(),
      sageLines: candidate.slice(0, end),
    };
  }
  return { body: output, sageLines: [] };
}

/**
 * Trim a SAGE block to `maxChars` by dropping WHOLE memory lines from the end.
 *
 * Never slices inside a line: a half-line loses its `</memory>` fence and
 * every downstream parser would stop recognising the block — the exact failure
 * this module exists to prevent. Returns `[]` when not even the header plus one
 * memory line fits, since a header alone renders as an empty card.
 */
export function capSageLines(sageLines: readonly string[], maxChars: number): string[] {
  if (sageLines.length < 2) return [];
  const header = sageLines[0]!;
  if (header.length >= maxChars) return [];
  const out = [header];
  let used = header.length;
  for (const line of sageLines.slice(1)) {
    if (used + 1 + line.length > maxChars) break;
    out.push(line);
    used += 1 + line.length;
  }
  return out.length > 1 ? out : [];
}
