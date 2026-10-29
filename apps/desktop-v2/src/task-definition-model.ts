/** A task's editable definition fields in the shape the inspector sends them. */
function definitionValues(task: Record<string, unknown>): Record<string, unknown> {
  return {
    title: String(task['title'] ?? ''),
    description: String(task['description'] ?? ''),
    priority: task['priority'] ?? 'medium',
    type: task['type'] ?? 'chore',
    status: task['status'] ?? 'pending',
    labels: task['labels'] ?? [],
    dueDate: typeof task['dueDate'] === 'string' ? task['dueDate'].slice(0, 10) : null,
    dependsOn: task['dependsOn'] ?? [],
    estimatedHours: task['estimatedHours'] ?? 0,
    actualHours: task['actualHours'] ?? 0,
    retryPolicy: task['retryPolicy'] ?? 'off',
    costCeilingUsd: task['costCeilingUsd'] ?? null,
  };
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Only the fields the draft changed from the baseline (plus the activity note). */
export function taskDefinitionPatch(
  baseline: Record<string, unknown>,
  draft: Record<string, unknown>,
) {
  const original = definitionValues(baseline);
  return Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) => key === 'activityNote' || !same(original[key], value),
    ),
  );
}

export interface FieldConflict {
  field: string;
  theirs: unknown;
  mine: unknown;
}

/**
 * Fields this edit changes that someone else also changed to a different value since the
 * inspector opened. Fields only they changed are not in the patch, so they are kept anyway.
 */
export function sameFieldConflicts(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): FieldConflict[] {
  const before = definitionValues(baseline),
    now = definitionValues(current);
  return Object.entries(patch)
    .filter(
      ([field, mine]) =>
        field in before && !same(before[field], now[field]) && !same(now[field], mine),
    )
    .map(([field, mine]) => ({ field, theirs: now[field], mine }));
}
