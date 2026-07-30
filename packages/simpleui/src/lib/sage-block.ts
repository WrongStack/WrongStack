/**
 * sage-block — split the SAGE Memory Injector suffix off a tool result.
 *
 * Live tool results no longer carry the block inline: the backend splits it at
 * the emit site and sends it in `tool.executed.sage` (see
 * `packages/core/src/utils/sage-output-block.ts`). Replayed conversations still
 * have it inline in the persisted `tool_result` content, so this recovers it
 * there and `ToolCallEntry` renders it under its own MEMORY heading instead of
 * dumping `--- SAGE: … ---` into the OUTPUT block.
 *
 * The headings and memory-line shape mirror the core splitter, the TUI's
 * `components/history/sage-output-format.ts`, and the WebUI's
 * `lib/sage-block.ts`. All four must agree on what counts as a SAGE suffix.
 */

const SAGE_INJECTOR_HEADINGS = new Set([
  '--- SAGE: task-aware project knowledge (Memory Injector) ---',
  '--- SAGE: related project knowledge (Memory Injector) ---',
]);

/** A complete memory line as produced by `formatMemoryHintsDetailed()`. */
const SAGE_MEMORY_LINE = /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*<\/memory>(?: .*)?$/;

/** A memory line whose tail an upstream character cap cut (trailing `…`). */
const SAGE_MEMORY_LINE_TRUNCATED = /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*…$/;

export interface SageSplit {
  /** Tool output with the SAGE block removed. */
  body: string;
  /** SAGE block lines, header first. Empty when there is no SAGE suffix. */
  sageLines: string[];
}

/**
 * Find the last SAGE suffix in `output` and split it off the tool text. Scans
 * from the end so a `--- SAGE:` string inside the body cannot steal the real
 * block; every non-blank line after the header must be a memory line (the last
 * may be a truncated fragment) or the candidate is rejected and left as
 * ordinary output.
 */
export function splitSageBlock(output: string): SageSplit {
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
