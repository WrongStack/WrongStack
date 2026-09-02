import * as path from 'node:path';
import * as os from 'node:os';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteSageStore } from '../src/sqlite-store.js';

let tempDir: string;
let store: SqliteSageStore;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-session-iso-'));
  store = new SqliteSageStore({ projectRoot: tempDir });
  await store.initialize();
});

afterAll(async () => {
  store.close();
  await rm(tempDir, { recursive: true, force: true });
});

// fs is used only in beforeAll; import inline to keep the test file self-contained.
import * as fs from 'node:fs/promises';

describe('Cross-session isolation (P0-1c regression tests)', () => {
  const SESSION_A = 'session-alpha-001';
  const SESSION_B = 'session-beta-002';

  it('session-A memory is not returned by session-B search', async () => {
    await store.rememberSage({
      text: 'Session A scratch note about a temporary debugging task',
      scope: 'session',
      ownerSessionId: SESSION_A,
      kind: 'fact',
      importance: 0.8,
    });

    // Session B searches for the same text — must NOT find session A's memory.
    const sessionBResults = await store.searchSage('session scratch temporary debugging', {
      sessionId: SESSION_B,
      limit: 10,
    });
    expect(
      sessionBResults.every((m) => m.scope !== 'session' || m.ownerSessionId === SESSION_B),
    ).toBe(true);
    expect(sessionBResults.find((m) => m.text.includes('Session A scratch'))).toBeUndefined();
  });

  it('session-A memory IS returned by session-A search', async () => {
    const sessionAResults = await store.searchSage('session scratch temporary debugging', {
      sessionId: SESSION_A,
      limit: 10,
    });
    const sessionAMem = sessionAResults.find((m) => m.text.includes('Session A scratch'));
    expect(sessionAMem).toBeDefined();
    expect(sessionAMem?.ownerSessionId).toBe(SESSION_A);
  });

  it('session-A memory is not returned when no sessionId is provided', async () => {
    // Unscoped callers should not see session-owned memories.
    const results = await store.searchSage('session scratch temporary debugging', {
      limit: 10,
    });
    expect(results.find((m) => m.text.includes('Session A scratch'))).toBeUndefined();
  });

  it('includeAllSessions returns session-A memory even without sessionId', async () => {
    const results = await store.searchSage('session scratch temporary debugging', {
      limit: 10,
      includeAllSessions: true,
    });
    const sessionAMem = results.find((m) => m.text.includes('Session A scratch'));
    expect(sessionAMem).toBeDefined();
  });

  it('scope=session without ownerSessionId is rejected', async () => {
    await expect(
      store.rememberSage({
        text: 'This should be rejected because no ownerSessionId',
        scope: 'session',
        kind: 'fact',
        importance: 0.5,
      }),
    ).rejects.toThrow(/ownerSessionId/);
  });

  it('session-A memory is not returned by session-B retrieveForPath', async () => {
    // Create a session-A memory anchored to a file.
    const anchored = await store.rememberSage({
      text: 'Session A file-specific note about this path',
      scope: 'session',
      ownerSessionId: SESSION_A,
      kind: 'file_note',
      importance: 0.8,
      anchors: [{ type: 'file', path: 'src/config.ts' }],
    });
    expect(anchored.ownerSessionId).toBe(SESSION_A);

    // Session B retrieves for the same path — must NOT find session A's memory.
    const sessionBResults = await store.retrieveForPath(['src/config.ts'], {
      path: 'src/config.ts',
      sessionId: SESSION_B,
      includeAudienceScoped: false,
    });
    expect(sessionBResults.find((m) => m.text.includes('Session A file-specific'))).toBeUndefined();
  });

  it('session-A memory IS returned by session-A retrieveForPath', async () => {
    const sessionAResults = await store.retrieveForPath(['src/config.ts'], {
      path: 'src/config.ts',
      sessionId: SESSION_A,
      includeAudienceScoped: false,
    });
    const found = sessionAResults.find((m) => m.text.includes('Session A file-specific'));
    expect(found).toBeDefined();
    expect(found?.ownerSessionId).toBe(SESSION_A);
  });

  it('session-A memory not visible to session-B in empty-query (importance-ordered) path', async () => {
    // Empty-query returns top-N by importance — session A's memory should be filtered out for B.
    const sessionBResults = await store.searchSage('', {
      sessionId: SESSION_B,
      limit: 50,
    });
    expect(sessionBResults.find((m) => m.text.includes('Session A'))).toBeUndefined();
  });

  it('session-scoped remember does not merge across sessions', async () => {
    // Session A creates a memory.
    const sessionAMem = await store.rememberSage({
      text: 'Cross-session dedup test unique phrase alpha',
      scope: 'session',
      ownerSessionId: SESSION_A,
      kind: 'fact',
      importance: 0.7,
    });

    // Session B creates an identical-text memory — should NOT merge into A's.
    const sessionBMem = await store.rememberSage({
      text: 'Cross-session dedup test unique phrase alpha',
      scope: 'session',
      ownerSessionId: SESSION_B,
      kind: 'fact',
      importance: 0.7,
    });

    // They must be distinct records with different owners.
    expect(sessionAMem.id).not.toBe(sessionBMem.id);
    expect(sessionAMem.ownerSessionId).toBe(SESSION_A);
    expect(sessionBMem.ownerSessionId).toBe(SESSION_B);
  });

  it('session-A memory is not returned by session-B findRelatedSage (graph/tag expansion)', async () => {
    const seedA = await store.rememberSage({
      text: 'Session A seed memory for graph isolation probe',
      scope: 'session',
      ownerSessionId: SESSION_A,
      kind: 'fact',
      importance: 0.8,
      tags: ['isolation-graph'],
    });
    const relatedA = await store.rememberSage({
      text: 'Session A related memory sharing the isolation graph tag',
      scope: 'session',
      ownerSessionId: SESSION_A,
      kind: 'fact',
      importance: 0.8,
      tags: ['isolation-graph'],
    });
    const relatedB = await store.rememberSage({
      text: 'Session B related memory sharing the isolation graph tag',
      scope: 'session',
      ownerSessionId: SESSION_B,
      kind: 'fact',
      importance: 0.8,
      tags: ['isolation-graph'],
    });

    // Session B expands from session A's seed: sees its own related memory,
    // never session A's.
    const forB = await store.findRelatedSage([seedA.id], {
      limit: 20,
      sessionId: SESSION_B,
    });
    expect(forB.find((m) => m.id === relatedB.id)).toBeDefined();
    expect(forB.find((m) => m.id === relatedA.id)).toBeUndefined();

    // Session A expands from its own seed: sees its own related memory,
    // never session B's.
    const forA = await store.findRelatedSage([seedA.id], {
      limit: 20,
      sessionId: SESSION_A,
    });
    expect(forA.find((m) => m.id === relatedA.id)).toBeDefined();
    expect(forA.find((m) => m.id === relatedB.id)).toBeUndefined();

    // Admin opt-out sees both sessions' related memories.
    const all = await store.findRelatedSage([seedA.id], {
      limit: 20,
      sessionId: SESSION_B,
      includeAllSessions: true,
    });
    expect(all.find((m) => m.id === relatedA.id)).toBeDefined();
    expect(all.find((m) => m.id === relatedB.id)).toBeDefined();

    // Unscoped callers only see unowned session memories — both related
    // records are owned, so neither is visible.
    const unscoped = await store.findRelatedSage([seedA.id], { limit: 20 });
    expect(unscoped.find((m) => m.id === relatedA.id)).toBeUndefined();
    expect(unscoped.find((m) => m.id === relatedB.id)).toBeUndefined();
  });

  it('session-scoped audience memories are isolated by session', async () => {
    const audA = await store.rememberSage({
      text: 'Session A reviewer-only audience memory',
      scope: 'session',
      ownerSessionId: SESSION_A,
      kind: 'fact',
      importance: 0.8,
      audience: { roles: ['reviewer'] },
    });
    const audB = await store.rememberSage({
      text: 'Session B reviewer-only audience memory',
      scope: 'session',
      ownerSessionId: SESSION_B,
      kind: 'fact',
      importance: 0.8,
      audience: { roles: ['reviewer'] },
    });

    // Session A sees only its own reviewer-audience memory.
    const forA = await store.retrieveForAudience(
      { role: 'reviewer' },
      undefined,
      undefined,
      SESSION_A,
    );
    expect(forA.find((m) => m.id === audA.id)).toBeDefined();
    expect(forA.find((m) => m.id === audB.id)).toBeUndefined();

    // Session B sees only its own.
    const forB = await store.retrieveForAudience(
      { role: 'reviewer' },
      undefined,
      undefined,
      SESSION_B,
    );
    expect(forB.find((m) => m.id === audB.id)).toBeDefined();
    expect(forB.find((m) => m.id === audA.id)).toBeUndefined();

    // Unscoped: owned session memories are hidden.
    const unscoped = await store.retrieveForAudience({ role: 'reviewer' });
    expect(unscoped.find((m) => m.id === audA.id)).toBeUndefined();
    expect(unscoped.find((m) => m.id === audB.id)).toBeUndefined();

    // Admin opt-out: both visible.
    const all = await store.retrieveForAudience(
      { role: 'reviewer' },
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(all.find((m) => m.id === audA.id)).toBeDefined();
    expect(all.find((m) => m.id === audB.id)).toBeDefined();
  });

  it('unifiedSearchService is session-isolated', async () => {
    const uA = await store.rememberSage({
      text: 'isolation unified probe alpha',
      scope: 'session',
      ownerSessionId: SESSION_A,
      kind: 'fact',
      importance: 0.8,
    });
    const uB = await store.rememberSage({
      text: 'isolation unified probe alpha',
      scope: 'session',
      ownerSessionId: SESSION_B,
      kind: 'fact',
      importance: 0.8,
    });

    // Session A only sees its own copy.
    const forA = await store.unifiedSearchService(
      { text: 'isolation unified probe' },
      { sessionId: SESSION_A },
    );
    const forAIds = forA.hits.map((hit) => hit.id);
    expect(forAIds).toContain(uA.id);
    expect(forAIds).not.toContain(uB.id);

    // Session B only sees its own copy.
    const forB = await store.unifiedSearchService(
      { text: 'isolation unified probe' },
      { sessionId: SESSION_B },
    );
    const forBIds = forB.hits.map((hit) => hit.id);
    expect(forBIds).toContain(uB.id);
    expect(forBIds).not.toContain(uA.id);

    // Unscoped: owned session memories are hidden from both.
    const unscoped = await store.unifiedSearchService({ text: 'isolation unified probe' });
    const unscopedIds = unscoped.hits.map((hit) => hit.id);
    expect(unscopedIds).not.toContain(uA.id);
    expect(unscopedIds).not.toContain(uB.id);

    // Admin opt-out: both visible.
    const all = await store.unifiedSearchService(
      { text: 'isolation unified probe' },
      { includeAllSessions: true },
    );
    const allIds = all.hits.map((hit) => hit.id);
    expect(allIds).toContain(uA.id);
    expect(allIds).toContain(uB.id);
  });
});
