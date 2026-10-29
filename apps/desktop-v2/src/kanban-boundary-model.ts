import { entries, record } from './engine-values';

export const SELECTOR_KINDS = ['directory', 'file', 'package', 'glob'] as const;
export const SELECTOR_ACCESS = ['read_write', 'write', 'read'] as const;
export interface BoundarySelector {
  kind: (typeof SELECTOR_KINDS)[number];
  path: string;
  access: (typeof SELECTOR_ACCESS)[number];
  note: string;
}
export interface BoundaryPolicy {
  enabled: boolean;
  enforcement: 'confirm' | 'block';
  shellAccess: 'allow' | 'confirm' | 'block';
  allow: BoundarySelector[];
  deny: BoundarySelector[];
}

export const emptySelector = (): BoundarySelector => ({
  kind: 'directory',
  path: '',
  access: 'read_write',
  note: '',
});

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.find((option) => option === value) ?? fallback;

function selectors(value: unknown): BoundarySelector[] {
  return entries(value).map((item) => ({
    kind: pick(SELECTOR_KINDS, item['kind'], 'directory'),
    path: typeof item['path'] === 'string' ? item['path'] : '',
    access: pick(SELECTOR_ACCESS, item['access'], 'read_write'),
    note: typeof item['note'] === 'string' ? item['note'] : '',
  }));
}

/** The stored policy, or null when the task has none (it then only inherits the board's). */
export function boundaryPolicy(value: unknown): BoundaryPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const policy = record(value);
  return {
    enabled: policy['enabled'] === true,
    enforcement: pick(['confirm', 'block'] as const, policy['enforcement'], 'confirm'),
    shellAccess: pick(['allow', 'confirm', 'block'] as const, policy['shellAccess'], 'confirm'),
    allow: selectors(policy['allow']),
    deny: selectors(policy['deny']),
  };
}

export const newBoundary = (): BoundaryPolicy => ({
  enabled: true,
  enforcement: 'confirm',
  shellAccess: 'confirm',
  allow: [],
  deny: [],
});

/**
 * Problems the engine would refuse, found before sending: empty, absolute or escaping paths.
 * The engine still validates and normalizes every selector itself.
 */
export function boundaryErrors(policy: BoundaryPolicy): string[] {
  const errors: string[] = [];
  for (const [list, items] of [
    ['Allow', policy.allow],
    ['Deny', policy.deny],
  ] as const)
    items.forEach((item, index) => {
      const path = item.path.trim().replace(/\\/g, '/');
      const label = `${list} ${index + 1}`;
      if (!path) errors.push(`${label}: enter a project-relative path.`);
      else if (/^([a-z]:|\/)/i.test(path)) errors.push(`${label}: use a project-relative path.`);
      else if (path === '..' || path.startsWith('../') || path.includes('/../'))
        errors.push(`${label}: the path must stay inside the project.`);
    });
  return errors;
}

/** The policy as the engine stores it: notes only when written, deny only when present. */
export function boundaryPayload(policy: BoundaryPolicy) {
  const out = (item: BoundarySelector) => ({
    kind: item.kind,
    path: item.path.trim(),
    access: item.access,
    ...(item.note.trim() ? { note: item.note.trim() } : {}),
  });
  return {
    enabled: policy.enabled,
    enforcement: policy.enforcement,
    shellAccess: policy.shellAccess,
    allow: policy.allow.map(out),
    ...(policy.deny.length ? { deny: policy.deny.map(out) } : {}),
  };
}

/** Same policy after normalization of what the editor can express. */
export function sameBoundary(left: unknown, right: unknown): boolean {
  const a = boundaryPolicy(left),
    b = boundaryPolicy(right);
  return JSON.stringify(a && boundaryPayload(a)) === JSON.stringify(b && boundaryPayload(b));
}
