import type { Diagnostic } from 'vscode-languageserver-protocol';
import { lspColumnToHuman } from '../position.js';
import type { SeverityName } from '../types.js';
import { displayPath } from '../utils/uri.js';
import type { LineTextReader } from './location.js';

const SEVERITY: Record<number, SeverityName> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

const LABEL: Record<SeverityName, string> = {
  error: 'ERROR',
  warning: 'WARN',
  info: 'INFO',
  hint: 'HINT',
};

export function formatDiagnostics(
  byFile: Map<string, Diagnostic[]>,
  opts: {
    cwd: string;
    severityFilter: SeverityName[];
    maxPerFile: number;
    maxTotal: number;
    /** Reads a line so columns go out in the tools' 1-based byte convention. */
    lineText?: LineTextReader | undefined;
  },
): string {
  const allowed = new Set(opts.severityFilter);
  const sections: string[] = [];
  let total = 0;
  let files = 0;
  const maxPerFile = Number.isFinite(opts.maxPerFile)
    ? Math.max(0, Math.floor(opts.maxPerFile))
    : 0;
  const maxTotal = Number.isFinite(opts.maxTotal) ? Math.max(0, Math.floor(opts.maxTotal)) : 0;
  for (const [file, diagnostics] of byFile.entries()) {
    const filtered = diagnostics
      /* v8 ignore next -- fallback handles invalid server severity values defensively. */
      .filter((d) => allowed.has(SEVERITY[d.severity ?? 1] ?? 'error'))
      .sort(compareDiagnostics)
      .slice(0, maxPerFile);
    if (filtered.length === 0) continue;
    // `maxTotal` caps the grand total across files: the file that crosses the
    // line is truncated to the remaining budget instead of being emitted whole
    // (which both overshot the cap and hid every later file from the output).
    const shown = filtered.slice(0, Math.max(0, maxTotal - total));
    if (shown.length === 0) break;
    files++;
    total += shown.length;
    const lines = shown.map((d) => formatDiagnostic(d, opts.lineText?.(file, d.range.start.line)));
    sections.push(
      `${displayPath(file, opts.cwd)} (${shown.length}):\n${lines.map((l) => `  ${l}`).join('\n')}`,
    );
    if (total >= maxTotal) break;
  }
  if (sections.length === 0) return 'No LSP diagnostics.';
  return `${sections.join('\n\n')}\n\nTotal: ${total} diagnostics in ${files} files.`;
}

function safeCoord(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function formatDiagnostic(d: Diagnostic, lineText?: string): string {
  /* v8 ignore next -- fallback handles invalid server severity values defensively. */
  const sev = SEVERITY[d.severity ?? 1] ?? 'error';
  const source = d.source ? ` ${d.source}${d.code !== undefined ? `(${String(d.code)})` : ''}` : '';
  const msgRaw = typeof d.message === 'string' ? d.message : d.message.value;
  const msg = msgRaw.replace(/\s*\r?\n\s*/g, ' | ');
  const line = safeCoord(d.range.start.line);
  const character = safeCoord(d.range.start.character);
  const column = lineText !== undefined ? lspColumnToHuman(lineText, character) : character + 1;
  return `L${line + 1}:${column} ${LABEL[sev]}${source}: ${msg}`;
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    (a.severity ?? 1) - (b.severity ?? 1) ||
    safeCoord(a.range.start.line) - safeCoord(b.range.start.line) ||
    safeCoord(a.range.start.character) - safeCoord(b.range.start.character)
  );
}
