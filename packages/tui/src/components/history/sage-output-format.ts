export interface SageSplit {
  /** Tool result text with the SAGE block removed. */
  cleanOutput: string;
  /** Extracted SAGE block lines (including the `--- SAGE:` header), or empty. */
  sageLines: string[];
}

const SAGE_INJECTOR_HEADINGS = new Set([
  '--- SAGE: task-aware project knowledge (Memory Injector) ---',
  '--- SAGE: related project knowledge (Memory Injector) ---',
]);

const SAGE_MEMORY_LINE = /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*<\/memory>(?: .*)?$/;

/**
 * A memory line whose tail was cut by a character cap somewhere upstream (the
 * `…` marker appended by an event preview, the fleet bridge, the HQ raw-content
 * cap, or history retention). Accepted only as the LAST line of a candidate
 * block: the `- [labels] <memory id="…">` prefix is specific enough that no
 * ordinary tool output produces it, so recognising the fragment keeps a
 * truncated block rendering as memory instead of decaying into raw tool text.
 * Mirrors `packages/core/src/utils/sage-output-block.ts`.
 */
const SAGE_MEMORY_LINE_TRUNCATED = /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*…$/;

/**
 * One SAGE memory line split into its structured fields, so the renderer shows
 * clean key/value rows instead of an opaque blob. The producer shape (see
 * `packages/sage/src/retrieval/format.ts`) is:
 *
 *   - [kind][importance?] <memory id="…">escaped text</memory> (anchor)? [relation=…; tags=…]
 */
export interface ParsedSageMemoryLine {
  id: string;
  text: string;
  labels: string[];
  anchor?: string | undefined;
  relation?: string | undefined;
  tags?: string[] | undefined;
}

/**
 * Strict counterpart to `SAGE_MEMORY_LINE`. The gate above only decides "does
 * this line belong to a SAGE block?" and stays permissive (greedy body, opaque
 * `(?: .*)?` trailer) so block extraction survives future format additions.
 * This one captures named groups and therefore requires the exact `(anchor)` /
 * `[meta]` shapes the producer emits today; a line that passes the gate but
 * fails here falls back to a literal render row, so the memory is still shown.
 */
export const SAGE_MEMORY_DETAIL =
  /^- (?<labels>\[[^\]]+\](?:\[[^\]]+\])*) <memory id="(?<id>[^"]+)">(?<text>.*?)<\/memory>(?: \((?<anchor>[^)]+)\))?(?: \[(?<meta>[^\]]+)\])?$/;

/**
 * Inverse of the producer's `escapeFenceText`, limited to the XML entities.
 *
 * Order matters: `&amp;` must be last so entities we just expanded are not
 * re-expanded (`&amp;lt;` → `&lt;`, not `<`). Control-char escapes (`\n`,
 * `\r`, `\u2028`, `\u2029`) are deliberately NOT materialized: the producer
 * escapes a real newline as the two chars `\n` but never escapes a literal
 * backslash, so that direction is ambiguous. Leaving them literal round-trips
 * identically either way — the only cost is that a newline inside a memory
 * renders as `\n`.
 */
function unescapeFenceBody(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function parseMeta(
  meta: string | undefined,
): { relation?: string | undefined; tags?: string[] | undefined } {
  if (!meta) return {};
  const relationMatch = /relation=([^;\]]+)/.exec(meta);
  const tagsMatch = /tags=([^;\]]+)/.exec(meta);
  return {
    relation: relationMatch?.[1]?.trim(),
    tags: tagsMatch?.[1]
      ?.split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
}

export function parseSageMemoryLine(line: string): ParsedSageMemoryLine | null {
  const match = SAGE_MEMORY_DETAIL.exec(line);
  if (!match || !match.groups) return null;
  const rawLabels = match.groups['labels'] ?? '';
  const labels = Array.from(rawLabels.matchAll(/\[([^\]]+)\]/g))
    .map((m) => m[1] ?? '')
    .filter(Boolean);
  return {
    id: match.groups['id'] ?? '',
    text: unescapeFenceBody(match.groups['text'] ?? ''),
    labels,
    anchor: match.groups['anchor']?.trim() || undefined,
    ...parseMeta(match.groups['meta']),
  };
}

export function extractSageBlock(output: string): SageSplit {
  const lines = output.split('\n');
  for (let sageIdx = lines.length - 1; sageIdx >= 0; sageIdx--) {
    if (!SAGE_INJECTOR_HEADINGS.has(lines[sageIdx] ?? '')) continue;
    const candidate = lines.slice(sageIdx);
    if (candidate.length < 2) continue;
    // Tolerate trailing blank/whitespace-only lines that may follow the SAGE
    // block if the injector or a downstream serializer appends them. Every
    // non-blank line after the header must still match the memory-line regex.
    const rawMemoryLines = candidate.slice(1);
    // Validate the truncation marker against the raw final entry before
    // filtering trailing blanks; a future producer may emit a fragment whose
    // only visible content is the marker itself.
    const memoryLines = rawMemoryLines.filter((line) => line.trim().length > 0);
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
    // Exclude trailing blank/whitespace lines from sageLines so the rendered
    // memory panel doesn't show empty rows.
    let end = candidate.length;
    while (end > 1 && candidate[end - 1]!.trim().length === 0) end--;
    return {
      cleanOutput: lines.slice(0, sageIdx).join('\n').trimEnd(),
      sageLines: candidate.slice(0, end),
    };
  }
  return { cleanOutput: output, sageLines: [] };
}

/**
 * Resolve the SAGE block for a tool history entry.
 *
 * Live entries carry the block as structured `sageLines` (from
 * `tool.executed.sage`), split off by the backend BEFORE the event's ~400-char
 * preview cap — that cap used to slice a memory line mid-fence, and the
 * unparseable remainder then rendered as raw tool text. Replayed entries have
 * no such field and still carry the block inline in `output`, so fall back to
 * splitting the text.
 */
export function resolveEntrySage(
  output: string | undefined,
  sageLines: readonly string[] | undefined,
): SageSplit {
  if (sageLines && sageLines.length > 0) {
    return { cleanOutput: output ?? '', sageLines: [...sageLines] };
  }
  return extractSageBlock(output ?? '');
}

export function formatToolOutputSageWith(input: {
  toolName: string;
  output: string | undefined;
  ok: boolean;
  /** Structured SAGE lines from the event, when the surface has them. */
  sageLines?: readonly string[] | undefined;
  outputBytes?: number | undefined;
  outputLines?: number | undefined;
  formatToolOutput(
    toolName: string,
    output: string | undefined,
    ok: boolean,
    outputBytes?: number | undefined,
    outputLines?: number | undefined,
  ): string[];
}): { cleanOutput: string; outLines: string[]; sageLines: string[] } {
  const { toolName, output, ok, outputBytes, outputLines, formatToolOutput } = input;
  if (!output) {
    return {
      cleanOutput: '',
      outLines: formatToolOutput(toolName, output, ok, outputBytes, outputLines),
      // A tool can return nothing and still get memory injected, so the
      // structured lines are honoured even with an empty body.
      sageLines: input.sageLines ? [...input.sageLines] : [],
    };
  }
  const { cleanOutput, sageLines } = resolveEntrySage(output, input.sageLines);
  const text = cleanOutput || (sageLines.length > 0 ? '' : output);
  return {
    cleanOutput: text,
    outLines: formatToolOutput(toolName, text, ok, outputBytes, outputLines),
    sageLines,
  };
}
