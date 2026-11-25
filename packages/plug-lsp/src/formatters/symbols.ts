import { displayPath } from '../utils/uri.js';

interface CodebaseLspResult {
  name: string;
  kind: string;
  lspKind: number;
  file: string;
  line: number;
  source: 'index' | 'lsp';
  server?: string | undefined;
  score?: number | undefined;
  snippet?: string | undefined;
}

interface CodebaseLspSearchOutput {
  results: CodebaseLspResult[];
  totalIndex: number;
  totalLsp: number;
  query: string;
  usedIndex: boolean;
  usedLsp: boolean;
}

/**
 * Format `codebase-lsp-search` output for human-readable display.
 */
export function formatCodebaseLspResults(output: CodebaseLspSearchOutput, cwd: string): string {
  const { results, totalIndex, totalLsp, query, usedIndex, usedLsp } = output;

  if (results.length === 0) {
    const sources: string[] = [];
    if (usedIndex) sources.push(`index(${totalIndex})`);
    if (usedLsp) sources.push(`lsp(${totalLsp})`);
    // Next-step guidance, matching the codebase-* tools' `note`.
    const retry = usedLsp
      ? 'Try fewer or different words (symbol names, not sentences)'
      : 'Retry with preferLsp: true for live server symbols, or use fewer words';
    return (
      `No symbols matching "${query}". Searched: ${sources.join(', ') || 'none'}.\n` +
      `${retry}; codebase-context for a concept-level query; grep for exact text.`
    );
  }

  const lines: string[] = [];
  lines.push(`${results.length} results for "${query}" (index:${totalIndex} lsp:${totalLsp}):`);

  for (const r of results) {
    const sourceTag = r.source === 'index' ? '[index]' : `[lsp:${r.server ?? '?'}]`;
    const scoreTag =
      typeof r.score === 'number' && Number.isFinite(r.score) ? ` score=${r.score.toFixed(2)}` : '';
    const location = `${displayPath(r.file, cwd)}:${r.line}`;

    if (r.snippet) {
      lines.push(`  ${sourceTag} ${r.kind} ${r.name} ${location}${scoreTag}`);
      lines.push(`      ${r.snippet}`);
    } else {
      lines.push(`  ${sourceTag} ${r.kind} ${r.name} ${location}${scoreTag}`);
    }
  }

  // Empty results returned above, so a first result always exists here.
  const top = results[0]!;
  const file = JSON.stringify(displayPath(top.file, cwd).replace(/\\/g, '/'));
  lines.push(
    `Next: codebase-read-symbol({ file: ${file}, symbol: ${JSON.stringify(top.name)} }) reads its code; ` +
      `lsp_references({ path: ${file}, line: ${top.line}, character }) lists live usages.`,
  );

  return lines.join('\n');
}
