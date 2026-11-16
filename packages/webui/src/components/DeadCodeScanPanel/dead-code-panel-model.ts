import { toErrorMessage } from '@wrongstack/core/utils/error';
import type {
  DeadCodeCategory,
  DeadCodeConfidence,
  DeadCodeFinding,
  DeadCodeScanResult,
} from '@wrongstack/tools/dead-code';

/** Shared types, tables, and HTTP/prompt helpers for the Dead Code panel. */

export type ScanReport = Omit<DeadCodeScanResult, 'fileHashes'>;
export type ConfidenceFilter = 'high' | 'medium' | 'low';

export interface BackupInfo {
  id: string;
  createdAt: string;
  files: number;
  findingIds: string[];
}

export interface UndoResult {
  restored: string[];
  conflicts: string[];
}

export const CATEGORY_ORDER: readonly DeadCodeCategory[] = [
  'unreachable-file',
  'dead-export',
  'unused-reexport',
  'unused-export',
  'unused-local',
  'unused-dependency',
  'test-only-file',
  'test-only-export',
  'unused-public-export',
];

export const CATEGORY_KEY: Record<DeadCodeCategory, string> = {
  'unreachable-file': 'unreachableFile',
  'test-only-file': 'testOnlyFile',
  'dead-export': 'deadExport',
  'unused-export': 'unusedExport',
  'unused-reexport': 'unusedReexport',
  'test-only-export': 'testOnlyExport',
  'unused-local': 'unusedLocal',
  'unused-dependency': 'unusedDependency',
  'unused-public-export': 'unusedPublicExport',
};

export const CONFIDENCE_RANK: Record<DeadCodeConfidence, number> = { high: 0, medium: 1, low: 2 };

export const CONFIDENCE_CLASS: Record<DeadCodeConfidence, string> = {
  high: 'border-destructive/40 text-destructive',
  medium: 'border-warning/50 text-warning',
  low: 'border-border text-muted-foreground',
};

export const PAGE = 300;

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson<T>(res);
}

export async function readJson<T>(res: Response): Promise<T> {
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`HTTP ${res.status}: the server returned a non-JSON response`);
  }
  if (!res.ok) {
    const err =
      parsed && typeof parsed === 'object'
        ? (parsed as { error?: string; detail?: string })
        : undefined;
    throw new Error(err?.detail ?? err?.error ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}

export function errorText(err: unknown): string {
  return toErrorMessage(err);
}

export function agentPrompt(findings: readonly DeadCodeFinding[]): string {
  const lines = findings.slice(0, 200).map((f) => {
    const at = f.line ? `${f.file}:${f.line}` : f.file;
    const what = f.name ? ` \`${f.name}\`` : '';
    const how = f.fix ? `fix: ${f.fix}` : `manual: ${f.manualReason ?? 'review'}`;
    return `- [${f.id}] ${f.category} (${f.confidence})${what} at ${at} — ${f.reason} (${how})`;
  });
  return [
    'Review these dead-code findings from the Dead Code panel and clean them up with me.',
    'Verify each one before removing anything (dead-code-scan with previewIds shows the exact diff).',
    'Use dead-code-fix for findings that have a fix; for manual ones (e.g. test-only code) propose the change and wait for my go-ahead.',
    '',
    ...lines,
    findings.length > 200 ? `… and ${findings.length - 200} more (re-run dead-code-scan).` : '',
  ]
    .filter((l, i, a) => l !== '' || i < a.length - 1)
    .join('\n');
}
