import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSageTools } from '../src/tools/memory-tools.js';
import { getSageService, SqliteMemoryPort } from '../src/memory-port.js';
import type { Sage } from '../src/types.js';

/**
 * Session identity is ambient: the agent loop holds it, the model does not.
 * Every SQL retrieval surface enforces the same visibility rule via
 * `buildSessionClause`, but the tool layer passed no session at all — so
 * `memory_for_file` (which filters in JS and had no clause) returned every
 * session's private memories to any caller, while the search/path tools could
 * not read back even their own session's records.
 */
describe('session isolation across the memory tool surface', () => {
  let dir: string;
  let store: SqliteMemoryPort;
  let tools: ReturnType<typeof createSageTools>;

  const ctxFor = (sessionId?: string) =>
    ({ session: sessionId ? { id: sessionId } : undefined, meta: {} }) as never;
  const runOpts = { signal: new AbortController().signal } as never;

  const tool = (name: string) => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`tool ${name} not registered`);
    return found;
  };

  const anchors = [{ type: 'file' as const, path: 'src/auth/index.ts' }];
  let s1: Sage;
  let s2: Sage;
  let project: Sage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sage-tool-sess-'));
    // The production wiring: tools run against the port's service capability,
    // which is what adapts `retrieveForPath`'s object form to the store call.
    store = new SqliteMemoryPort({ projectRoot: dir });
    await store.initialize();
    const service = getSageService(store);
    if (!service) throw new Error('SAGE service capability missing');
    tools = createSageTools(service);

    s1 = await store.rememberSage({
      text: 'Session one private note about the auth rollout',
      kind: 'fact',
      scope: 'session',
      ownerSessionId: 'S1',
      anchors,
      importance: 0.9,
      confidence: 0.9,
    });
    s2 = await store.rememberSage({
      text: 'Session two private note about the auth rollout',
      kind: 'fact',
      scope: 'session',
      ownerSessionId: 'S2',
      anchors,
      importance: 0.9,
      confidence: 0.9,
    });
    project = await store.rememberSage({
      text: 'Project note about the auth rollout entry point',
      kind: 'file_note',
      scope: 'project',
      anchors,
      importance: 0.9,
      confidence: 0.9,
    });
  });

  afterEach(async () => {
    await store.close?.();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the sqlite handle; the temp dir is disposable.
    }
  });

  const forFileIds = async (sessionId?: string): Promise<Set<string>> => {
    const result = (await tool('memory_for_file').execute(
      { path: 'src/auth/index.ts', limit: 50 } as never,
      ctxFor(sessionId),
      runOpts,
    )) as {
      primaryMatches: Array<{ memory: Sage }>;
      symbolMatches: Array<{ memory: Sage }>;
      relatedMatches: Array<{ memory: Sage }>;
    };
    return new Set(
      [...result.primaryMatches, ...result.symbolMatches, ...result.relatedMatches].map(
        (match) => match.memory.id,
      ),
    );
  };

  it('never shows one session its neighbour’s private memory through memory_for_file', async () => {
    const asS1 = await forFileIds('S1');

    expect(asS1.has(s1.id)).toBe(true);
    expect(asS1.has(project.id)).toBe(true);
    expect(asS1.has(s2.id)).toBe(false);
  });

  it('hides every owned session memory from a caller with no session', async () => {
    // Fail-closed: the MCP server's synthetic context has no session, and the
    // right answer there is project knowledge only.
    const anonymous = await forFileIds(undefined);

    expect(anonymous.has(project.id)).toBe(true);
    expect(anonymous.has(s1.id)).toBe(false);
    expect(anonymous.has(s2.id)).toBe(false);
  });

  it('lets memory_search read back the calling session’s own memory', async () => {
    const hits = (await tool('memory_search').execute(
      { query: 'auth rollout', limit: 20 } as never,
      ctxFor('S1'),
      runOpts,
    )) as Sage[];
    const ids = new Set(hits.map((memory) => memory.id));

    expect(ids.has(s1.id)).toBe(true);
    expect(ids.has(s2.id)).toBe(false);
  });

  it('lets memory_for_path read back the calling session’s own memory', async () => {
    const hits = (await tool('memory_for_path').execute(
      { path: 'src/auth/index.ts', limit: 20 } as never,
      ctxFor('S2'),
      runOpts,
    )) as Sage[];
    const ids = new Set(hits.map((memory) => memory.id));

    expect(ids.has(s2.id)).toBe(true);
    expect(ids.has(s1.id)).toBe(false);
  });

  it('closes the write/read round trip without the model supplying a session id', async () => {
    const written = (await tool('remember').execute(
      {
        text: 'A session-scoped note written without naming the session',
        kind: 'fact',
        scope: 'session',
        importance: 0.9,
        confidence: 0.9,
      } as never,
      ctxFor('S3'),
      runOpts,
    )) as Sage;

    expect(written.ownerSessionId).toBe('S3');

    const hits = (await tool('memory_search').execute(
      { query: 'session-scoped note written without naming', limit: 20 } as never,
      ctxFor('S3'),
      runOpts,
    )) as Sage[];
    expect(hits.map((memory) => memory.id)).toContain(written.id);

    const otherSession = (await tool('memory_search').execute(
      { query: 'session-scoped note written without naming', limit: 20 } as never,
      ctxFor('S1'),
      runOpts,
    )) as Sage[];
    expect(otherSession.map((memory) => memory.id)).not.toContain(written.id);
  });

  it('does not let bulk enumeration page through another session’s memories', async () => {
    const batch = (await tool('memory_gather_batch').execute(
      { limit: 500 } as never,
      ctxFor('S1'),
      runOpts,
    )) as { memories: Sage[] };
    const ids = new Set(batch.memories.map((memory) => memory.id));

    expect(ids.has(s1.id)).toBe(true);
    expect(ids.has(project.id)).toBe(true);
    expect(ids.has(s2.id)).toBe(false);
  });

  it.each([
    ['memory_update', { text: 'Overwritten from another session' }],
    ['memory_delete', { force: true, reason: 'cleanup' }],
    ['memory_recover', { reason: 'restore' }],
  ])('refuses %s against another session’s memory', async (name, extra) => {
    await expect(
      tool(name).execute({ id: s2.id, ...extra } as never, ctxFor('S1'), runOpts),
    ).rejects.toThrow(/owned by another session/);

    // The record is untouched.
    const after = await store.getSage(s2.id);
    expect(after?.status).toBe('active');
    expect(after?.text).toBe(s2.text);
  });

  it('still allows a session to mutate its own memory', async () => {
    const updated = (await tool('memory_update').execute(
      { id: s2.id, text: 'Revised by its owning session' } as never,
      ctxFor('S2'),
      runOpts,
    )) as Sage;

    expect(updated.text).toBe('Revised by its owning session');
  });

  it('leaves project-scoped memories mutable from any session', async () => {
    const updated = (await tool('memory_update').execute(
      { id: project.id, text: 'Shared project knowledge, revised' } as never,
      ctxFor('S1'),
      runOpts,
    )) as Sage;

    expect(updated.text).toBe('Shared project knowledge, revised');
  });

  it('still honours an explicitly supplied owner session', async () => {
    const written = (await tool('remember').execute(
      {
        text: 'A note attributed to a session other than the caller',
        kind: 'fact',
        scope: 'session',
        ownerSessionId: 'S9',
        importance: 0.9,
        confidence: 0.9,
      } as never,
      ctxFor('S3'),
      runOpts,
    )) as Sage;

    expect(written.ownerSessionId).toBe('S9');
  });
});
