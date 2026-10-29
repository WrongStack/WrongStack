import { entries, record } from './engine-values';

export const deadCodeCategories = [
  'unreachable-file',
  'dead-export',
  'unused-reexport',
  'unused-export',
  'unused-local',
  'unused-dependency',
  'test-only-file',
  'test-only-export',
  'unused-public-export',
] as const;
const ranks: Record<string, number> = { high: 0, medium: 1, low: 2 };
export function filterDeadCode(
  findings: Record<string, unknown>[],
  category: string,
  confidence: string,
  query: string,
  fixable: boolean,
) {
  return findings.filter(
    (item) =>
      (!category || item['category'] === category) &&
      (ranks[String(item['confidence'])] ?? 3) <= (ranks[confidence] ?? 1) &&
      (!fixable || typeof item['fix'] === 'string') &&
      `${item['file']} ${item['name'] ?? ''} ${item['package'] ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
}
export function deadCodeLabel(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('-', ' ') : 'Not reported';
}
/** The engine reports pre-restore conflicts even after force restored those files. */
export function deadCodeRestoreOutcome(restored: string[], conflicts: string[]) {
  const remaining = conflicts.filter((file) => !restored.includes(file));
  return {
    remaining,
    notice: `${restored.length} ${restored.length === 1 ? 'file' : 'files'} restored${remaining.length ? `; ${remaining.length} conflicts remain` : ''}.`,
  };
}
export function deadCodeRequest(findings: Record<string, unknown>[]): string {
  return [
    'Review these project dead-code findings before changing files. Re-scan and inspect exact diffs using dead-code-scan. Use dead-code-fix only after reviewing the current evidence and following the normal permission flow. Propose manual changes for findings without a mechanical fix.',
    '',
    ...findings
      .slice(0, 200)
      .map(
        (item) =>
          `- ${item['file']}${item['line'] ? `:${item['line']}` : ''} — ${item['name'] ?? item['category']} (${item['confidence']}). ${item['reason']} ${item['fix'] ? `Mechanical action: ${item['fix']}.` : `Manual review: ${item['manualReason'] ?? 'required'}.`} Finding: ${item['id']}`,
      ),
    ...(findings.length > 200
      ? [`${findings.length - 200} additional findings omitted; re-scan the project.`]
      : []),
  ].join('\n');
}
/** Compare actual affected files, diffs, linked findings and skipped work before applying. */
export function sameDeadCodePlan(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const normalize = (plan: Record<string, unknown>) => ({
    changes: entries(plan['changes'])
      .map((change) => ({
        file: change['file'],
        action: change['action'],
        diff: change['diff'],
        findingIds: Array.isArray(change['findingIds']) ? [...change['findingIds']].sort() : [],
      }))
      .sort((a, b) => String(a.file).localeCompare(String(b.file))),
    planned: Array.isArray(plan['planned']) ? [...plan['planned']].sort() : [],
    skipped: entries(plan['skipped'])
      .map((item) => ({ id: item['id'], reason: item['reason'] }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  });
  return JSON.stringify(normalize(record(left))) === JSON.stringify(normalize(record(right)));
}

/**
 * The apply request for a reviewed preview. Its `revision` (from engines that report one) binds
 * the write: the engine writes nothing when the re-scanned plan differs and returns `stale`.
 */
export function deadCodeApplyBody(
  ids: string[],
  verify: boolean,
  plan: Record<string, unknown>,
): Record<string, unknown> {
  const revision = plan['revision'];
  return {
    ids,
    verify: verify ? 'typecheck' : 'none',
    ...(typeof revision === 'string' && revision ? { expectedRevision: revision } : {}),
  };
}
