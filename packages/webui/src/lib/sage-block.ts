/**
 * sage-block — Split the SAGE memory-injection suffix from a tool result.
 *
 * The SAGE Memory Injector middleware (`packages/sage/src/middleware/tool-call-memory.ts`)
 * appends a `--- SAGE: ... ---` block to `payload.result.content` after the
 * normal tool output for triggers including `read`, `tree`, `grep`, `glob`,
 * `codebase_search`, `write`, `edit`, `replace`, and `patch`. The WebUI
 * `ToolResult` renderer wants to surface that block as a separate bordered
 * card instead of letting it leak into the body — this helper does the split.
 *
 * The exact headings and memory-line regex mirror the TUI's
 * `packages/tui/src/components/history/sage-output-format.ts` so both
 * surfaces agree on what counts as a SAGE suffix and what to leave
 * untouched.
 */

const SAGE_INJECTOR_HEADINGS = new Set([
  '--- SAGE: task-aware project knowledge (Memory Injector) ---',
  '--- SAGE: related project knowledge (Memory Injector) ---',
]);

/**
 * Match a single memory line. Format produced by
 * `formatMemoryHintsDetailed()` in `packages/sage/src/retrieval/format.ts`:
 *
 *   `- [kind][priority] <memory id="...">escaped text</memory> (anchor) [relation=...; tags=...]`
 *
 * The `(anchor)` and `[relation=...; tags=...]` trailers are optional, so the
 * regex keeps them as `(...)?` optional groups.
 */
const SAGE_MEMORY_LINE =
  /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*<\/memory>(?: .*)?$/;

/**
 * A memory line whose tail was cut by a character cap upstream (the `…` marker
 * appended by an event preview, the fleet bridge, or the HQ raw-content cap).
 * Accepted only as the LAST line of a candidate block: the
 * `- [labels] <memory id="…">` prefix is specific enough that no ordinary tool
 * output produces it, so recognising the fragment keeps a truncated block
 * rendering as a memory card instead of decaying into raw tool text. Mirrors
 * `packages/core/src/utils/sage-output-block.ts`.
 */
const SAGE_MEMORY_LINE_TRUNCATED =
  /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*…$/;

export interface SageSplit {
  /** Tool result text with the SAGE block removed (trailing whitespace trimmed). */
  cleanOutput: string;
  /**
   * Extracted SAGE block lines including the `--- SAGE:` header. Empty when
   * the input contains no terminal SAGE suffix. Trailing blank/whitespace
   * lines are excluded so the rendered card doesn't show empty rows.
   */
  sageLines: string[];
}

/**
 * Find the last SAGE-injector suffix in `output` and split it away from the
 * normal tool text. Behaviour mirrors the TUI's `extractSageBlock`:
 *
 * - Scans from the end so a stray `--- SAGE:` inside the tool body never
 *   accidentally steals the real trailing block.
 * - Every non-blank line after the header must match the memory-line regex;
 *   otherwise the candidate is rejected (defensive against tools that emit
 *   a `--- SAGE: ...` shaped header as legitimate output).
 * - Trailing blank/whitespace-only lines after the memory block are tolerated
 *   (the injector + downstream serializers sometimes append them) but
 *   excluded from `sageLines`.
 * - Real (non-blank) content after the SAGE block disqualifies the candidate
 *   — the SAGE header is then treated as ordinary tool output.
 */
export function extractSageBlock(output: string): SageSplit {
  const lines = output.split('\n');
  for (let sageIdx = lines.length - 1; sageIdx >= 0; sageIdx--) {
    if (!SAGE_INJECTOR_HEADINGS.has(lines[sageIdx] ?? '')) continue;
    const candidate = lines.slice(sageIdx);
    if (candidate.length < 2) continue;
    const memoryLines = candidate.slice(1).filter((line) => line.trim().length > 0);
    if (
      memoryLines.length === 0 ||
      !memoryLines.every(
        (line, index) =>
          SAGE_MEMORY_LINE.test(line) ||
          (index === memoryLines.length - 1 && SAGE_MEMORY_LINE_TRUNCATED.test(line)),
      )
    ) {
      continue;
    }
    let end = candidate.length;
    while (end > 1 && candidate[end - 1]!.trim().length === 0) end--;
    return {
      cleanOutput: lines.slice(0, sageIdx).join('\n').trimEnd(),
      sageLines: candidate.slice(0, end),
    };
  }
  return { cleanOutput: output, sageLines: [] };
}