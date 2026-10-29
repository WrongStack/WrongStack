import { describe, expect, it } from 'vitest';
import {
  boundaryErrors,
  boundaryPayload,
  boundaryPolicy,
  emptySelector,
  newBoundary,
  sameBoundary,
} from '../src/kanban-boundary-model';

describe('Kanban boundary editing', () => {
  const stored = {
    enabled: true,
    enforcement: 'block',
    shellAccess: 'confirm',
    allow: [{ kind: 'directory', path: 'src/feature', access: 'read_write' }],
    deny: [{ kind: 'glob', path: '**/*.env', access: 'read', note: 'secrets' }],
  };

  it('reads a stored policy and writes it back unchanged', () => {
    const policy = boundaryPolicy(stored)!;
    expect(policy.deny[0]).toEqual({
      kind: 'glob',
      path: '**/*.env',
      access: 'read',
      note: 'secrets',
    });
    expect(boundaryPayload(policy)).toEqual(stored);
    expect(sameBoundary(boundaryPayload(policy), stored)).toBe(true);
    expect(boundaryPolicy(undefined)).toBeNull();
    expect(boundaryPolicy([])).toBeNull();
  });

  it('omits an empty deny list and blank notes', () => {
    const policy = { ...newBoundary(), allow: [{ ...emptySelector(), path: ' src ', note: ' ' }] };
    expect(boundaryPayload(policy)).toEqual({
      enabled: true,
      enforcement: 'confirm',
      shellAccess: 'confirm',
      allow: [{ kind: 'directory', path: 'src', access: 'read_write' }],
    });
  });

  it('flags paths the engine would refuse', () => {
    const policy = {
      ...newBoundary(),
      allow: [
        { ...emptySelector(), path: '' },
        { ...emptySelector(), path: 'C:\repo' },
        { ...emptySelector(), path: 'src/../../x' },
        { ...emptySelector(), path: 'packages/core' },
      ],
      deny: [{ ...emptySelector(), path: '/etc' }],
    };
    expect(boundaryErrors(policy)).toEqual([
      'Allow 1: enter a project-relative path.',
      'Allow 2: use a project-relative path.',
      'Allow 3: the path must stay inside the project.',
      'Deny 1: use a project-relative path.',
    ]);
  });

  it('detects a boundary changed or removed elsewhere', () => {
    expect(sameBoundary(stored, { ...stored, enforcement: 'confirm' })).toBe(false);
    expect(sameBoundary(stored, undefined)).toBe(false);
    expect(sameBoundary(undefined, null)).toBe(true);
  });
});
