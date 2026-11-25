import * as path from 'node:path';
import type { LanguageDiagnostic, LanguageRunSummary } from './types.js';

export function parseLinePattern(
  text: string,
  regex: RegExp,
  root: string,
  source: string,
  details: (
    match: RegExpMatchArray,
    fallback: string,
  ) => { severity: LanguageDiagnostic['severity']; message: string },
): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  for (const match of text.matchAll(regex)) {
    const parsed = details(match, match.at(-1)?.trim() ?? 'Diagnostic');
    diagnostics.push({
      severity: parsed.severity,
      message: parsed.message,
      file: normalizeDiagnosticPath(match[1]!, root),
      range: { start: { line: toPositiveInt(match[2]), column: toPositiveInt(match[3]) } },
      source,
    });
  }
  return diagnostics;
}

export function normalizeDiagnosticPath(value: string, root: string): string {
  const clean = value.trim().replace(/^['"]|['"]$/g, '');
  return path.resolve(root, clean);
}

export function normalizeSeverity(value: string | undefined): LanguageDiagnostic['severity'] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'warning' || normalized === 'warn') return 'warning';
  // rustc closes a failed build with a span-less `failure-note` ("For more
  // information about this error, try `rustc --explain …`"): a pointer, not a
  // diagnostic. Read as `error` it inflated every failed cargo build by one.
  if (
    normalized === 'info' ||
    normalized === 'note' ||
    normalized === 'help' ||
    normalized === 'failure-note'
  )
    return 'info';
  if (normalized === 'hint') return 'hint';
  return 'error';
}

export function toPositiveInt(value: string | undefined): number {
  return Math.max(1, Number.parseInt(value ?? '1', 10) || 1);
}

export function summarize(diagnostics: readonly LanguageDiagnostic[]): LanguageRunSummary {
  return {
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    infos: diagnostics.filter((item) => item.severity === 'info' || item.severity === 'hint')
      .length,
  };
}

export function emptySummary(): LanguageRunSummary {
  return { errors: 0, warnings: 0, infos: 0 };
}

export function dedupeDiagnostics(items: readonly LanguageDiagnostic[]): LanguageDiagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [
      item.source,
      item.code ?? '',
      item.file ?? '',
      item.range?.start.line ?? 0,
      item.range?.start.column ?? 0,
      item.message,
    ].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function compareDiagnostics(a: LanguageDiagnostic, b: LanguageDiagnostic): number {
  const safeNum = (n: number | undefined): number =>
    typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return (
    (a.file ?? '').localeCompare(b.file ?? '') ||
    safeNum(a.range?.start.line) - safeNum(b.range?.start.line) ||
    safeNum(a.range?.start.column) - safeNum(b.range?.start.column) ||
    severityRank(a.severity) - severityRank(b.severity) ||
    (a.code ?? '').localeCompare(b.code ?? '') ||
    a.message.localeCompare(b.message)
  );
}

function severityRank(value: LanguageDiagnostic['severity']): number {
  return value === 'error' ? 0 : value === 'warning' ? 1 : value === 'info' ? 2 : 3;
}
