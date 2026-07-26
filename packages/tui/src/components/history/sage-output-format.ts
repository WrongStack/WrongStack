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

export function extractSageBlock(output: string): SageSplit {
  const lines = output.split('\n');
  for (let sageIdx = lines.length - 1; sageIdx >= 0; sageIdx--) {
    if (!SAGE_INJECTOR_HEADINGS.has(lines[sageIdx] ?? '')) continue;
    const candidate = lines.slice(sageIdx);
    if (candidate.length < 2) continue;
    // Tolerate trailing blank/whitespace-only lines that may follow the SAGE
    // block if the injector or a downstream serializer appends them. Every
    // non-blank line after the header must still match the memory-line regex.
    const memoryLines = candidate.slice(1).filter((line) => line.trim().length > 0);
    if (memoryLines.length === 0 || !memoryLines.every((line) => SAGE_MEMORY_LINE.test(line))) {
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

export function formatToolOutputSageWith(input: {
  toolName: string;
  output: string | undefined;
  ok: boolean;
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
      sageLines: [],
    };
  }
  const { cleanOutput, sageLines } = extractSageBlock(output);
  const text = cleanOutput || (sageLines.length > 0 ? '' : output);
  return {
    cleanOutput: text,
    outLines: formatToolOutput(toolName, text, ok, outputBytes, outputLines),
    sageLines,
  };
}
