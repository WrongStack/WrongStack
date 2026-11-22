import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionBranchDescriptor, SessionTreeSnapshot } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { SessionTreeCoordinator } from '../../src/storage/session-tree-coordinator.js';
import { resolveBranch, validateBranchName } from '../../src/storage/session-tree-fold.js';

function branch(id: string, name: string): SessionBranchDescriptor {
  return {
    id,
    name,
    parentBranchId: id === 'main' ? null : 'main',
    forkSeq: 0,
    createdAt: '2026-11-22T10:00:00.000Z',
    lastActivityAt: '2026-11-22T10:00:00.000Z',
    status: 'active',
    turnCount: 0,
  };
}

function tree(): SessionTreeSnapshot {
  return {
    activeBranchId: 'main',
    branches: {
      main: branch('main', 'main'),
      br_ctor: branch('br_ctor', 'constructor'),
    },
    headSeq: 0,
  };
}

describe('resolveBranch never resolves inherited object keys (F1171)', () => {
  it('resolves a branch named "constructor" by name, not Object.prototype.constructor', () => {
    // validateBranchName accepts the name — it matches BRANCH_NAME_PATTERN.
    const fresh = { ...tree(), branches: { main: branch('main', 'main') } };
    expect(validateBranchName('constructor', fresh)).toBe('constructor');
    expect(resolveBranch(tree(), 'constructor')).toEqual(branch('br_ctor', 'constructor'));
  });

  it('still resolves by id and rejects unknown inherited names', () => {
    expect(resolveBranch(tree(), 'br_ctor').name).toBe('constructor');
    expect(() => resolveBranch(tree(), 'hasOwnProperty')).toThrow('Unknown session branch');
    expect(() => resolveBranch(tree(), 'toString')).toThrow('Unknown session branch');
    expect(() => resolveBranch(tree(), '__proto__')).toThrow('Unknown session branch');
  });
});

describe('SessionTreeCoordinator with a branch named "constructor" (F1171)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-session-tree-fold-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('switches to the branch by name', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({ id: '', model: 'm', provider: 'p' });
    try {
      const coordinator = new SessionTreeCoordinator({
        sessionId: writer.id,
        writer,
        getEvents: async () => {
          await writer.flush?.();
          return (await store.load(writer.id)).events;
        },
      });
      await writer.append({ type: 'user_input', ts: '2026-11-22T10:00:00.000Z', content: 'p0' });
      const created = await coordinator.createBranch({
        name: 'constructor',
        switchImmediately: false,
      });
      const switched = await coordinator.switchBranch('constructor');
      expect(switched.toBranch.id).toBe(created.branch.id);
      expect(switched.toBranch.name).toBe('constructor');
      await writer.close();
    } finally {
      await store.dispose();
    }
  });
});
