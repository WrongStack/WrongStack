export interface DraftDiagnostics {
  revisions: {
    text: number | undefined;
    references: number | undefined;
    attachments: number | undefined;
    mode: number | undefined;
  };
  pending: boolean;
}
export function recoveryDraft(
  local: DraftDiagnostics | undefined,
  saved: Record<string, unknown> | undefined,
): 'match' | 'changed' | 'pending' {
  if (!local || local.pending || !saved) return 'pending';
  const parts = ['text', 'references', 'attachments', 'mode'] as const;
  if (
    parts.some(
      (part) =>
        !Number.isSafeInteger(local.revisions[part]) ||
        !Number.isSafeInteger(saved[part]) ||
        Number(local.revisions[part]) < 0 ||
        Number(saved[part]) < 0,
    )
  )
    return 'pending';
  return parts.every((part) => local.revisions[part] === saved[part]) ? 'match' : 'changed';
}
/** Native IDs address the host; compare only the two independently observed Core IDs. */
export function recoveryIdentity(
  expected: unknown,
  recorded: unknown,
  hydrating: boolean,
): 'pending' | 'match' | 'mismatch' {
  if (
    hydrating ||
    typeof expected !== 'string' ||
    !expected ||
    typeof recorded !== 'string' ||
    !recorded
  )
    return 'pending';
  return expected === recorded ? 'match' : 'mismatch';
}
export function recoveryLayout(
  value: string | null | undefined,
): { project: string; selected: string; page: string } | null {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const data = parsed as Record<string, unknown>;
    return {
      project: typeof data['project'] === 'string' ? data['project'] : '',
      selected: typeof data['selected'] === 'string' ? data['selected'] : '',
      page: typeof data['projectPage'] === 'string' ? data['projectPage'] : '',
    };
  } catch {
    return null;
  }
}
