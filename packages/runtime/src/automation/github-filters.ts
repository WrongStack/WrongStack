export interface GitHubFilters {
  mention?: string | undefined;
  label?: string | undefined;
  branch?: string | undefined;
  draft?: boolean | undefined;
  conclusion?: string | undefined;
  excludeBots?: boolean | undefined;
}

export function validateGitHubFilters(filters: GitHubFilters): void {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters))
    throw new Error('Invalid GitHub filters');
  for (const [key, value] of Object.entries(filters)) {
    if (!['draft', 'excludeBots', 'mention', 'label', 'branch', 'conclusion'].includes(key))
      throw new Error('Unknown GitHub filter');
    if (value === undefined) continue;
    if (key === 'draft' || key === 'excludeBots') {
      if (typeof value !== 'boolean') throw new Error(`Invalid GitHub ${key} filter`);
    } else if (['mention', 'label', 'branch', 'conclusion'].includes(key)) {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > 256 ||
        /[\x00-\x1f]/.test(value)
      )
        throw new Error(`Invalid GitHub ${key} filter`);
    } else throw new Error('Unknown GitHub filter');
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Used by signed ingestion and read-only preview; missing fields never satisfy a filter. */
export function evaluateGitHubFilters(
  filters: GitHubFilters | undefined,
  payload: unknown,
): { matches: boolean; reasons: string[] } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Invalid GitHub event');
  if (!filters) return { matches: true, reasons: [] };
  validateGitHubFilters(filters);
  const data = record(payload);
  const issue = record(data['pull_request'] ?? data['issue']);
  const comment = record(data['comment']);
  const check = record(data['check_run'] ?? data['check_suite']);
  const reasons: string[] = [];
  if (
    filters.mention &&
    (typeof comment['body'] !== 'string' || !comment['body'].includes(filters.mention))
  )
    reasons.push('mention');
  if (
    filters.label &&
    (!Array.isArray(issue['labels']) ||
      !issue['labels'].some((label) =>
        typeof label === 'string'
          ? label === filters.label
          : record(label)['name'] === filters.label,
      ))
  )
    reasons.push('label');
  if (filters.branch) {
    const branch =
      record(issue['base'])['ref'] ??
      check['head_branch'] ??
      record(check['check_suite'])['head_branch'] ??
      (typeof data['ref'] === 'string' ? data['ref'].replace(/^refs\/heads\//, '') : undefined);
    if (branch !== filters.branch) reasons.push('branch');
  }
  if (filters.draft !== undefined && issue['draft'] !== filters.draft) reasons.push('draft');
  if (filters.conclusion && check['conclusion'] !== filters.conclusion) reasons.push('conclusion');
  const sender = record(data['sender']);
  if (
    filters.excludeBots &&
    (!['User', 'Organization'].includes(String(sender['type'])) ||
      typeof sender['login'] !== 'string' ||
      sender['login'].endsWith('[bot]'))
  )
    reasons.push('bot');
  return { matches: reasons.length === 0, reasons };
}
