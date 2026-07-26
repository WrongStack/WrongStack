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
    const sageLines = lines.slice(sageIdx);
    if (sageLines.length < 2 || !sageLines.slice(1).every((line) => SAGE_MEMORY_LINE.test(line))) {
      continue;
    }
    return {
      cleanOutput: lines.slice(0, sageIdx).join('\n').trimEnd(),
      sageLines,
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
