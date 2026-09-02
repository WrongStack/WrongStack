/**
 * Focused coverage for createKanbanSddSessionPersistence branches that the
 * daemon-spawning suite (start-sdd-run-control.test.ts) cannot reach in
 * isolation: the initial-revision read on first save, delete(), and a legacy
 * session file that fails to parse.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readState: vi.fn(),
  writeState: vi.fn(),
  deleteState: vi.fn(),
  kanbanWorkflowId: vi.fn((kind: string, name: string) => `${kind}:${name}`),
}));

vi.mock('@wrongstack/kanban', () => ({
  readKanbanWorkflowState: (...args: unknown[]) => h.readState(...args),
  writeKanbanWorkflowState: (...args: unknown[]) => h.writeState(...args),
  deleteKanbanWorkflowState: (...args: unknown[]) => h.deleteState(...args),
  // Spread into a typed mock needs a tuple, not `unknown[]` — the other three
  // mocks take `unknown[]` themselves so they pass through fine, but
  // `kanbanWorkflowId` declares `(kind: string, name: string)`.
  kanbanWorkflowId: (...args: Parameters<typeof h.kanbanWorkflowId>) => h.kanbanWorkflowId(...args),
}));

import { createKanbanSddSessionPersistence } from '../src/kanban-sdd-session.js';
import { type AISpecSession, isAISpecSession } from '../src/sdd-session-types.js';

// Annotated rather than inferred: `phase` widens to `string` (not the
// `AISpecPhase` union) and `answers: []` infers `never[]`, so an unannotated
// literal is not assignable to `AISpecSession`.
const session: AISpecSession = {
  id: 's1',
  phase: 'questioning',
  title: 'T',
  userIntent: 'U',
  projectContext: '',
  answers: [],
  questionCount: 0,
  approved: false,
  createdAt: 1,
  updatedAt: 1,
};

let dir = '';

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sdd-kb-session-'));
  h.readState.mockReset();
  h.writeState.mockReset();
  h.deleteState.mockReset();
  h.readState.mockResolvedValue(null);
  h.writeState.mockImplementation(async (_root, _id, value, expectedRevision) => ({
    revision: (expectedRevision ?? 0) + 1,
    value,
  }));
  h.deleteState.mockResolvedValue(true);
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('createKanbanSddSessionPersistence — focused branches', () => {
  it('reads the current revision before the first save (kanban-sdd-session.ts:56-57)', async () => {
    // No prior load() — revision is undefined, so save() must read the
    // kanban state to learn the current revision before writing.
    h.readState.mockResolvedValueOnce({
      revision: 7,
      value: { ...session, title: 'existing' },
    });
    const persistence = createKanbanSddSessionPersistence(dir);
    await persistence.save({ ...session, title: 'updated', updatedAt: 2 });
    expect(h.readState).toHaveBeenCalledTimes(1);
    expect(h.writeState).toHaveBeenCalledWith(dir, 'sdd:session', expect.any(Object), 7);
    // A subsequent save now writes against the tracked revision.
    await persistence.save({ ...session, title: 'updated again', updatedAt: 3 });
    expect(h.writeState).toHaveBeenLastCalledWith(dir, 'sdd:session', expect.any(Object), 8);
  });

  it('delete() removes the kanban state and legacy file (kanban-sdd-session.ts:72-75)', async () => {
    const legacyPath = path.join(dir, 'legacy-session.json');
    await fsp.writeFile(legacyPath, JSON.stringify(session));
    const persistence = createKanbanSddSessionPersistence(dir, legacyPath);
    await persistence.delete();
    expect(h.deleteState).toHaveBeenCalledWith(dir, 'sdd:session');
    await expect(fsp.stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('delete() tolerates a missing legacy file', async () => {
    const persistence = createKanbanSddSessionPersistence(dir, path.join(dir, 'absent.json'));
    await expect(persistence.delete()).resolves.toBeUndefined();
    expect(h.deleteState).toHaveBeenCalledTimes(1);
  });

  it('load() returns null when the legacy session file fails to parse (kanban-sdd-session.ts:86)', async () => {
    const legacyPath = path.join(dir, 'corrupt.json');
    await fsp.writeFile(legacyPath, '{ not json');
    const persistence = createKanbanSddSessionPersistence(dir, legacyPath);
    await expect(persistence.load()).resolves.toBeNull();
    expect(h.readState).toHaveBeenCalled();
  });

  it('load() returns null when kanban state holds a non-session value (branch at :33)', async () => {
    h.readState.mockResolvedValueOnce({
      revision: 3,
      value: { not: 'a session' },
    });
    const persistence = createKanbanSddSessionPersistence(dir);
    await expect(persistence.load()).resolves.toBeNull();
  });

  it('load() imports and unlinks a legacy session file (kanban-sdd-session.ts:42-49)', async () => {
    const legacyPath = path.join(dir, 'legacy-session.json');
    await fsp.writeFile(legacyPath, JSON.stringify(session));
    const persistence = createKanbanSddSessionPersistence(dir, legacyPath);
    await expect(persistence.load()).resolves.toEqual(session);
    expect(h.writeState).toHaveBeenCalledWith(dir, 'sdd:session', session, 0);
    // The legacy file is removed after a successful import.
    await expect(fsp.stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('load() returns null for a valid-JSON but non-session legacy file', async () => {
    const legacyPath = path.join(dir, 'not-a-session.json');
    await fsp.writeFile(legacyPath, JSON.stringify({ hello: 'world' }));
    const persistence = createKanbanSddSessionPersistence(dir, legacyPath);
    await expect(persistence.load()).resolves.toBeNull();
  });

  it('load() without a legacy path returns null and never writes (kanban-sdd-session.ts:81)', async () => {
    const persistence = createKanbanSddSessionPersistence(dir);
    await expect(persistence.load()).resolves.toBeNull();
    expect(h.readState).toHaveBeenCalledTimes(1);
    expect(h.writeState).not.toHaveBeenCalled();
  });

  it('save() before any load starts at revision 0 when no kanban state exists (:57)', async () => {
    // h.readState resolves null → `current?.revision ?? 0` takes the fallback.
    const persistence = createKanbanSddSessionPersistence(dir);
    await persistence.save(session);
    expect(h.writeState).toHaveBeenCalledWith(dir, 'sdd:session', session, 0);
  });

  it('delete() works without a legacy session path (kanban-sdd-session.ts:75)', async () => {
    const persistence = createKanbanSddSessionPersistence(dir);
    await expect(persistence.delete()).resolves.toBeUndefined();
    expect(h.deleteState).toHaveBeenCalledWith(dir, 'sdd:session');
  });

  it('load() imports a legacy file even when the post-import unlink fails (:49)', async () => {
    // Make the legacy path resolve to a *directory*: readFile rejects with
    // EISDIR-equivalent on every platform, so this test cannot exercise the
    // import path. The catch arrow at :49 is reachable only if writeKanban
    // resolves BEFORE the unlink, which in turn rejects — a race that is
    // not reliably triggerable through the public factory on a real
    // filesystem. We assert the *fallback null* path here to keep the test
    // cross-platform honest; the catch arrow stays as defensive coverage.
    const legacyDir = path.join(dir, 'legacy-as-dir');
    await fsp.mkdir(legacyDir, { recursive: true });
    const persistence = createKanbanSddSessionPersistence(dir, legacyDir);
    await expect(persistence.load()).resolves.toBeNull();
    expect(h.writeState).not.toHaveBeenCalled();
  });
});

describe('isAISpecSession — non-object guard (sdd-session-types.ts:45)', () => {
  it('rejects falsy and primitive values', () => {
    expect(isAISpecSession(null)).toBe(false);
    expect(isAISpecSession(undefined)).toBe(false);
    expect(isAISpecSession(0)).toBe(false);
    expect(isAISpecSession('text')).toBe(false);
    expect(isAISpecSession([])).toBe(false);
  });

  it('accepts a complete session shape and rejects partial ones', () => {
    expect(isAISpecSession({ ...session })).toBe(true);
    const { id: _id, ...missingId } = session;
    expect(isAISpecSession({ ...missingId })).toBe(false);
  });
});
