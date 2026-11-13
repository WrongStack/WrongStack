export type ArchitectureDecisionCheck = {
  id: string;
  path: string;
} & (
  | { kind: 'file_exists' }
  | { kind: 'contains_text' | 'excludes_text'; text: string }
  | { kind: 'json_equals'; pointer: string; value: string | number | boolean | null }
);

export function validateArchitectureDecisionChecks(value: unknown): ArchitectureDecisionCheck[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16)
    throw new Error('ADR checks must contain at most 16 rules.');
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid ADR check.');
    const rule = entry as Record<string, unknown>;
    if (
      typeof rule.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(rule.id) ||
      ids.has(rule.id)
    )
      throw new Error(
        'ADR check ids must be unique and contain only letters, numbers, dots, underscores or hyphens.',
      );
    ids.add(rule.id);
    if (typeof rule.path !== 'string' || rule.path.length > 500)
      throw new Error('ADR check path is required.');
    const path = rule.path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (
      !path ||
      path.startsWith('/') ||
      /^[a-zA-Z]:/.test(path) ||
      /[*?\x00-\x1f]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error(
        'ADR check path must be a project-relative file without traversal or wildcards.',
      );
    const base = { id: rule.id, path };
    let check: ArchitectureDecisionCheck;
    if (rule.kind === 'file_exists') check = { ...base, kind: rule.kind };
    else if (rule.kind === 'contains_text' || rule.kind === 'excludes_text') {
      if (typeof rule.text !== 'string' || !rule.text || rule.text.length > 2000)
        throw new Error('ADR text checks require 1–2000 literal characters.');
      check = { ...base, kind: rule.kind, text: rule.text };
    } else if (rule.kind === 'json_equals') {
      if (
        typeof rule.pointer !== 'string' ||
        rule.pointer.length > 500 ||
        (rule.pointer !== '' && !rule.pointer.startsWith('/')) ||
        /~(?![01])/.test(rule.pointer)
      )
        throw new Error('ADR JSON checks require a valid JSON pointer.');
      if (
        !(
          rule.value === null ||
          typeof rule.value === 'boolean' ||
          (typeof rule.value === 'string' && rule.value.length <= 2000) ||
          (typeof rule.value === 'number' && Number.isFinite(rule.value))
        )
      )
        throw new Error('ADR JSON expected values must be finite JSON scalars.');
      check = { ...base, kind: rule.kind, pointer: rule.pointer, value: rule.value };
    } else
      throw new Error('Unsupported ADR check kind. Shell commands and scripts are not supported.');
    if (Object.keys(rule).some((key) => !Object.hasOwn(check, key)))
      throw new Error('Unknown ADR check field.');
    return check;
  });
}
