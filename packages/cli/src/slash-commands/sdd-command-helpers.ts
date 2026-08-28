interface SddSubtaskInput {
  title: string;
  description: string;
}

export const SDD_KNOWN_SUBCOMMANDS = [
  'new',
  'approve',
  'execute',
  'parallel',
  'stop',
  'clean',
  'rollback',
  'destroy',
  'retry-failed',
  'split',
  'plan',
  'spec',
  'tasks',
  'done',
  'skip',
  'fail',
  'review',
  'edit',
  'undo',
  'next',
  'status',
  'graph',
  'critical',
  'cancel',
  'resume',
  'list',
  'show',
  'templates',
  'from',
  'history',
];

interface SddDestroyResult {
  worktreesRemoved: number;
  deleted: readonly string[];
  reverted: number;
  revertOk?: boolean | undefined;
  revertReason?: string | undefined;
}

export function formatExistingSddSessionMessage(existing: {
  title: string;
  phase: string;
  questionCount: number;
}): string {
  return [
    `An existing SDD session was found:`,
    `  Feature: "${existing.title}"`,
    `  Phase: ${existing.phase}`,
    `  Questions: ${existing.questionCount}`,
    '',
    'Use /sdd resume to continue, or /sdd new --force to start fresh.',
  ].join('\n');
}

export function parseParallelSlots(input: string): { parallelSlots: number } | undefined {
  const slots = input.trim() ? Number.parseInt(input.trim(), 10) : undefined;
  return slots && Number.isFinite(slots)
    ? { parallelSlots: Math.min(16, Math.max(1, slots)) }
    : undefined;
}

export function parseSddSubtasks(parts: readonly string[]): SddSubtaskInput[] {
  return parts
    .join(' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((piece) => {
      const [title, ...rest] = piece.split('::');
      const t = (title ?? '').trim();
      const d = rest.join('::').trim();
      return { title: t, description: d || t };
    })
    .filter((s) => s.title);
}

export function formatSddDestroyResult(res: SddDestroyResult, revertMerged: boolean): string {
  const mergedNote = revertMerged
    ? res.revertOk === false
      ? `  Merged-commit revert refused: ${res.revertReason ?? 'unknown reason'}.`
      : res.reverted > 0
        ? `  Reverted ${res.reverted} merged commit${res.reverted === 1 ? '' : 's'}.`
        : '  No merged commits to revert.'
    : `  (Merged commits left intact — use /sdd destroy --revert or /sdd rollback to undo them.)`;
  return [
    `SDD project destroyed.`,
    res.worktreesRemoved > 0
      ? `  Removed ${res.worktreesRemoved} worktree${res.worktreesRemoved === 1 ? '' : 's'}.`
      : '',
    res.deleted.length ? `  Deleted: ${res.deleted.join(', ')}.` : '',
    mergedNote,
  ]
    .filter(Boolean)
    .join('\n');
}
