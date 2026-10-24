/**
 * Regression shield for carrying SAGE memory back into model context across
 * tool calls and provider requests (2026-09-15 audit).
 *
 * Each block pins one defect that shipped silently:
 *  - tool calls of one step overwrote each other's memory evidence
 *  - the once-per-session cooldown outlived the evidence (`/clear` barred a
 *    memory for the rest of the session)
 *  - usefulness was credited only by the opt-in turn middleware, and could be
 *    credited from an assistant message written before the injection
 *  - `retrieveForPath` ignored `includeStatuses`, so reads injected stale rows
 *  - re-remembering a stale memory left it stale (unfindable)
 *  - turn-context re-renders counted as fresh injections every request
 *  - the domain-term extractor re-mined an unchanged conversation per request
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSageContextMonitorMiddleware } from '../src/middleware/context-monitor.js';
import { createSageDomainTermExtractorMiddleware } from '../src/middleware/domain-term-extractor-middleware.js';
import { InjectionTracker } from '../src/middleware/injection-tracker.js';
import { createSageOutcomeCaptureMiddleware } from '../src/middleware/outcome-capture.js';
import { createSagePathRemapMiddleware, replaceIdentifier } from '../src/middleware/path-remap.js';
import {
  createSageToolCallMiddleware,
  type SageRetrieverLike,
} from '../src/middleware/tool-call-memory.js';
import {
  memoryIdsInEvidence,
  mergeMemoryEvidence,
  TOOL_MEMORY_EVIDENCE_SOURCE,
} from '../src/middleware/tool-call-memory-trace.js';
import { createSageTurnMiddleware } from '../src/middleware/turn-memory.js';
import { isSqliteAvailable, SqliteSageStore } from '../src/sqlite-store.js';
import type { Sage } from '../src/types.js';

let tmpDir: string;
let openStores: SqliteSageStore[] = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-carry-'));
  openStores = [];
});

afterEach(async () => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  // Give Windows a tick to release WAL file handles before removing the dir.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeStore(): SqliteSageStore {
  const store = new SqliteSageStore({ projectRoot: tmpDir });
  openStores.push(store);
  return store;
}

function asRetriever(store: SqliteSageStore): SageRetrieverLike & {
  recordInjection: ReturnType<typeof vi.fn>;
} {
  return {
    retrieveForPath: (opts) => store.retrieveForPath([opts.path], opts),
    searchSage: (query, opts) => store.searchSage(query, opts),
    findRelatedSage: (memoryIds, opts) => store.findRelatedSage(memoryIds, opts),
    recordInjection: vi.fn((memoryIds: string[], trigger: string, sessionId?: string) =>
      store.recordInjection(memoryIds, trigger, sessionId),
    ),
    recordUse: (memoryIds, source, sessionId) => store.recordUse(memoryIds, source, sessionId),
  };
}

interface EvidenceCtx {
  projectRoot: string;
  cwd: string;
  session: { id: string };
  signal: AbortSignal;
  memoryEvidence: Array<{ source: string; text: string }>;
  setMemoryEvidence(source: string, text: string, maxChars?: number): void;
  clearMemoryEvidence(): void;
}

/** A context with core's REPLACE-per-source evidence semantics. */
function makeCtx(): EvidenceCtx {
  return {
    projectRoot: tmpDir,
    cwd: tmpDir,
    session: { id: 'sess-carry' },
    signal: new AbortController().signal,
    memoryEvidence: [],
    setMemoryEvidence(source, text, maxChars = 6_000) {
      this.memoryEvidence = [
        ...this.memoryEvidence.filter((entry) => entry.source !== source),
        { source, text: text.slice(0, maxChars) },
      ];
    },
    clearMemoryEvidence() {
      this.memoryEvidence = [];
    },
  };
}

function readPayload(ctx: EvidenceCtx, file: string, id: string): ToolCallPipelinePayload {
  return {
    toolUse: { type: 'tool_use', id, name: 'read', input: { path: file } },
    result: { type: 'tool_result', tool_use_id: id, name: 'read', content: 'file content' },
    ctx,
  } as unknown as ToolCallPipelinePayload;
}

function toolEvidence(ctx: EvidenceCtx): string {
  return (
    ctx.memoryEvidence.find((entry) => entry.source === TOOL_MEMORY_EVIDENCE_SOURCE)?.text ?? ''
  );
}

async function rememberFileNote(store: SqliteSageStore, file: string, text: string): Promise<Sage> {
  return store.rememberSage({
    text,
    importance: 0.95,
    anchors: [{ type: 'file', path: file }],
  });
}

describe.skipIf(!isSqliteAvailable())('tool-memory evidence window', () => {
  it('keeps the memories of every tool call in one step', async () => {
    const store = makeStore();
    const a = await rememberFileNote(store, 'src/alpha.ts', 'Alpha module owns the retry budget.');
    const b = await rememberFileNote(store, 'src/beta.ts', 'Beta module serializes every writer.');
    const mw = createSageToolCallMiddleware({ memory: asRetriever(store) });
    const ctx = makeCtx();

    await mw.handler(readPayload(ctx, 'src/alpha.ts', 't1'), async (p) => p);
    await mw.handler(readPayload(ctx, 'src/beta.ts', 't2'), async (p) => p);

    const ids = memoryIdsInEvidence(toolEvidence(ctx));
    expect([...ids].sort()).toEqual([a.id, b.id].sort());
    expect(toolEvidence(ctx)).toContain('Alpha module owns the retry budget.');
    expect(toolEvidence(ctx)).toContain('Beta module serializes every writer.');
  });

  it('holds the cooldown while the memory is in context and releases it once cleared', async () => {
    const store = makeStore();
    const note = await rememberFileNote(
      store,
      'src/gamma.ts',
      'Gamma handlers must stay idempotent.',
    );
    const retriever = asRetriever(store);
    // Default cooldown: once while visible.
    const mw = createSageToolCallMiddleware({ memory: retriever });
    const ctx = makeCtx();

    await mw.handler(readPayload(ctx, 'src/gamma.ts', 't1'), async (p) => p);
    await mw.handler(readPayload(ctx, 'src/gamma.ts', 't2'), async (p) => p);
    expect(retriever.recordInjection).toHaveBeenCalledTimes(1);

    ctx.clearMemoryEvidence();
    await mw.handler(readPayload(ctx, 'src/gamma.ts', 't3'), async (p) => p);
    expect(retriever.recordInjection).toHaveBeenCalledTimes(2);
    expect(memoryIdsInEvidence(toolEvidence(ctx)).has(note.id)).toBe(true);
  });

  it('does not inject a memory verification marked stale on a read trigger', async () => {
    const store = makeStore();
    const note = await rememberFileNote(
      store,
      'src/delta.ts',
      'Delta cache is rebuilt at boot only.',
    );
    await store.updateSage(note.id, { status: 'stale' });
    const mw = createSageToolCallMiddleware({ memory: asRetriever(store) });
    const ctx = makeCtx();

    await mw.handler(readPayload(ctx, 'src/delta.ts', 't1'), async (p) => p);

    expect(toolEvidence(ctx)).toBe('');
  });
});

describe('mergeMemoryEvidence', () => {
  const header = '--- SAGE: related project knowledge (Memory Injector) ---';
  const line = (id: string, body: string, trailer = '') =>
    `- [fact] <memory id="${id}">${body}</memory>${trailer}`;

  it('rolls the oldest lines out and reports them as evicted', () => {
    const previous = [header, line('old1', 'a'.repeat(40)), line('old2', 'b'.repeat(40))].join(
      '\n',
    );
    const rendered = [header, line('new1', 'c'.repeat(40))].join('\n');
    const window = header.length + 2 * (line('new1', 'c'.repeat(40)).length + 1);

    const merged = mergeMemoryEvidence(previous, rendered, window);

    expect(merged.memoryIds).toEqual(['new1', 'old1']);
    expect(merged.evictedIds).toEqual(['old2']);
    expect(merged.text.length).toBeLessThanOrEqual(window);
  });

  it('moves a re-rendered memory to the front without duplicating it', () => {
    const previous = [header, line('m1', 'one'), line('m2', 'two')].join('\n');
    const merged = mergeMemoryEvidence(previous, [header, line('m2', 'two')].join('\n'), 10_000);
    expect(merged.memoryIds).toEqual(['m2', 'm1']);
  });

  it('reads the id from the line prefix, never from the unescaped trailer', () => {
    const spoofed = line('real', 'body', ' [tags=<memory id="spoof">]');
    expect([...memoryIdsInEvidence([header, spoofed].join('\n'))]).toEqual(['real']);
  });
});

describe('usefulness crediting in the context monitor', () => {
  const TEXT_A = 'Use pnpm for installing dependencies in this repo';
  const REFERENCE_A = 'I will use pnpm for installing dependencies now.';

  function setup() {
    const tracker = new InjectionTracker();
    const recordUse = vi.fn(async () => {});
    const middleware = createSageContextMonitorMiddleware({
      tracker,
      events: new EventBus(),
      getSessionId: () => 'sess',
      memory: { recordUse },
    });
    const run = (
      system: string[],
      messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    ) =>
      middleware.handler(
        {
          model: 'test',
          system: system.map((text) => ({ type: 'text' as const, text })),
          messages,
        },
        async (request) => request,
      );
    return { tracker, recordUse, run };
  }

  it('credits a memory the model could see when it wrote, exactly once', async () => {
    const { tracker, recordUse, run } = setup();
    tracker.record('mem_a', TEXT_A, Date.now(), 'sess');
    const user = { role: 'user' as const, content: 'install deps' };

    await run([TEXT_A], [user]);
    await run([TEXT_A], [user, { role: 'assistant', content: REFERENCE_A }]);
    // A tool loop re-sends the same latest assistant message.
    await run([TEXT_A], [user, { role: 'assistant', content: REFERENCE_A }]);

    expect(recordUse).toHaveBeenCalledTimes(1);
    expect(recordUse).toHaveBeenCalledWith(['mem_a'], 'assistant_reference', 'sess');
  });

  it('does not credit a memory injected after the assistant message was written', async () => {
    const { tracker, recordUse, run } = setup();
    const user = { role: 'user' as const, content: 'install deps' };
    await run([], [user]);
    // The assistant step asks for a tool; the tool call then injects mem_a,
    // whose vocabulary matches the request that retrieved it.
    const toolStep = { role: 'assistant' as const, content: REFERENCE_A };
    tracker.record('mem_a', TEXT_A, Date.now(), 'sess');
    await run([TEXT_A], [user, toolStep]);
    expect(recordUse).not.toHaveBeenCalled();

    // The next message was written with mem_a in context.
    await run([TEXT_A], [user, toolStep, { role: 'assistant', content: `${REFERENCE_A} Done.` }]);
    expect(recordUse).toHaveBeenCalledWith(['mem_a'], 'assistant_reference', 'sess');
  });
});

describe('turn-context injection counting', () => {
  it('counts an injection when a memory enters the block, not on every request', async () => {
    const memory: Sage = {
      id: 'mem_turn',
      revision: 1,
      scope: 'project',
      kind: 'convention',
      status: 'active',
      text: 'Always run lifecycle tests with pnpm vitest before committing.',
      importance: 0.95,
      confidence: 0.95,
      freshness: 0.9,
      tags: [],
      anchors: [],
      sources: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const service = {
      searchSage: vi.fn(async () => [memory]),
      recordInjection: vi.fn(async () => {}),
    };
    const middleware = createSageTurnMiddleware({ memory: service, getSessionId: () => 'sess' });
    const request = {
      model: 'test',
      system: [],
      messages: [{ role: 'user' as const, content: 'How do I run the lifecycle tests?' }],
    };

    for (let i = 0; i < 3; i++) await middleware.handler(request as never, async (next) => next);
    expect(service.recordInjection).toHaveBeenCalledTimes(1);
    expect(service.recordInjection).toHaveBeenCalledWith(['mem_turn'], 'turn_context', 'sess');

    service.searchSage.mockResolvedValueOnce([]);
    await middleware.handler(request as never, async (next) => next);
    await middleware.handler(request as never, async (next) => next);
    expect(service.recordInjection).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!isSqliteAvailable())('store status handling', () => {
  it('retrieveForPath honors includeStatuses', async () => {
    const store = makeStore();
    const note = await rememberFileNote(store, 'src/eps.ts', 'Epsilon parser rejects BOM input.');
    await store.updateSage(note.id, { status: 'stale' });

    const activeOnly = await store.retrieveForPath(['src/eps.ts'], {
      path: 'src/eps.ts',
      includeStatuses: ['active'],
    });
    const byDefault = await store.retrieveForPath(['src/eps.ts'], { path: 'src/eps.ts' });

    expect(activeOnly.map((m) => m.id)).not.toContain(note.id);
    expect(byDefault.map((m) => m.id)).toContain(note.id);
  });

  it('re-remembering a stale memory reactivates it', async () => {
    const store = makeStore();
    const text = 'Zeta exporter writes UTF-8 without BOM.';
    const note = await rememberFileNote(store, 'src/zeta.ts', text);
    await store.updateSage(note.id, { status: 'stale' });

    const again = await rememberFileNote(store, 'src/zeta.ts', text);

    expect(again.id).toBe(note.id);
    expect(again.status).toBe('active');
    expect((await store.searchSage('Zeta exporter')).map((m) => m.id)).toContain(note.id);
  });
});

describe('rename remapping', () => {
  it('rewrites whole identifiers only', () => {
    expect(replaceIdentifier('Call get() before getUser and $get.', 'get', 'fetch')).toBe(
      'Call fetch() before getUser and $get.',
    );
    expect(replaceIdentifier('uses a.b', 'a', '$&x')).toBe('uses $&x.b');
  });

  it('remaps and reactivates a stale memory after a file move', async () => {
    const stale: Sage = {
      id: 'mem_moved',
      revision: 1,
      scope: 'project',
      kind: 'file_note',
      status: 'stale',
      staleReason: 'verification',
      text: 'Parser entry point.',
      importance: 0.8,
      confidence: 0.8,
      freshness: 1,
      tags: [],
      anchors: [{ type: 'file', path: 'src/old.ts' }],
      sources: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const listSage = vi.fn(async () => [stale]);
    const updateSage = vi.fn(async () => stale);
    const port = {
      getCapability: () => ({ listSage, updateSage }),
    } as never;
    const middleware = createSagePathRemapMiddleware({ memory: port });
    await middleware.handler(
      {
        toolUse: {
          type: 'tool_use',
          id: 't',
          name: 'bash',
          input: { command: 'git mv src/old.ts src/new.ts' },
        },
        result: { type: 'tool_result', tool_use_id: 't', content: '' },
        ctx: { projectRoot: tmpDir, cwd: tmpDir },
      } as never,
      async (payload) => payload,
    );

    expect(listSage).toHaveBeenCalledWith(['active', 'stale']);
    expect(updateSage).toHaveBeenCalledWith('mem_moved', {
      anchors: [{ type: 'file', path: 'src/new.ts' }],
      status: 'active',
    });
  });
});

describe.skipIf(!isSqliteAvailable())('hygiene reactivation', () => {
  async function writeFile(relative: string, body = 'export {};\n'): Promise<void> {
    const absolute = path.join(tmpDir, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, body, 'utf8');
  }

  it('restores a memory verification staled once its file is back', async () => {
    const store = makeStore();
    await writeFile('src/theta.ts');
    const note = await rememberFileNote(store, 'src/theta.ts', 'Theta owns the retry queue.');

    await fs.rm(path.join(tmpDir, 'src/theta.ts'));
    await store.hygiene();
    expect(await store.getSage(note.id)).toMatchObject({
      status: 'stale',
      staleReason: 'verification',
    });

    await writeFile('src/theta.ts');
    const report = await store.hygiene();
    const restored = await store.getSage(note.id);
    expect(report.reactivated).toBe(1);
    expect(restored?.status).toBe('active');
    expect(restored?.staleReason).toBeUndefined();
  });

  it('reactivates a verification-staled memory anchored to an in-root ..-prefixed path', async () => {
    const store = makeStore();
    const hidden = await rememberFileNote(
      store,
      '..hidden/theme.css',
      'Hidden theme tokens anchor the shell palette decisions.',
    );
    const plain = await rememberFileNote(
      store,
      'src/plain.ts',
      'Plain retry queue owns the backpressure budget for streams.',
    );
    // rememberSage correctly rejects real ../ escapes, so the escape control
    // is written through the internal upsert — the corrupted/imported-row
    // shape this containment layer exists to guard against.
    const escapeRow = await rememberFileNote(
      store,
      'src/escape-placeholder.ts',
      'Deprecated exporter warning lives outside the root tree.',
    );
    const outsideRel = `../outside-${path.basename(tmpDir)}.ts`;
    (
      store as unknown as {
        upsertMemory(memory: { id: string; anchors: unknown; [key: string]: unknown }): void;
      }
    ).upsertMemory({
      ...(await store.getSage(escapeRow.id))!,
      anchors: [{ type: 'file', path: outsideRel }],
    });

    await store.hygiene();
    expect(await store.getSage(hidden.id)).toMatchObject({
      status: 'stale',
      staleReason: 'verification',
    });

    await writeFile('..hidden/theme.css');
    await writeFile('src/plain.ts');
    await fs.writeFile(path.resolve(tmpDir, outsideRel), 'export {};\n', 'utf8');

    const report = await store.hygiene();
    // "..hidden\theme.css" is INSIDE the root: the containment predicate must
    // not misread a '..-prefixed first segment as an escape.
    expect(await store.getSage(hidden.id)).toMatchObject({ status: 'active' });
    expect(await store.getSage(plain.id)).toMatchObject({ status: 'active' });
    expect(await store.getSage(escapeRow.id)).toMatchObject({ status: 'stale' });
    expect(report.reactivated).toBe(2);
    await fs.rm(path.resolve(tmpDir, outsideRel), { force: true });
  });

  it('demotes an active anchor moved outside through a directory link while preserving in-root links', async () => {
    const project = path.join(tmpDir, 'project');
    const outside = path.join(tmpDir, 'outside');
    const inside = path.join(project, 'inside');
    await fs.mkdir(path.join(project, 'escape'), { recursive: true });
    await fs.mkdir(path.join(project, 'safe'), { recursive: true });
    await fs.mkdir(outside);
    await fs.mkdir(inside);
    await fs.writeFile(path.join(project, 'escape', 'note.ts'), 'export {};\n');
    await fs.writeFile(path.join(project, 'safe', 'note.ts'), 'export {};\n');
    await fs.writeFile(path.join(outside, 'note.ts'), 'export {};\n');
    await fs.writeFile(path.join(inside, 'note.ts'), 'export {};\n');
    const store = new SqliteSageStore({ projectRoot: project });
    openStores.push(store);
    const escaped = await rememberFileNote(
      store,
      'escape/note.ts',
      'The orchid parser tracks the external data connector.',
    );
    const safe = await rememberFileNote(
      store,
      'safe/note.ts',
      'The copper parser tracks the internal data connector.',
    );

    await fs.rm(path.join(project, 'escape'), { recursive: true });
    await fs.rm(path.join(project, 'safe'), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(outside, path.join(project, 'escape'), linkType);
    await fs.symlink(inside, path.join(project, 'safe'), linkType);
    expect(await fs.realpath(path.join(project, 'escape', 'note.ts'))).toBe(
      await fs.realpath(path.join(outside, 'note.ts')),
    );

    await store.hygiene({ nearDedup: false });
    expect(await store.getSage(escaped.id)).toMatchObject({
      status: 'stale',
      staleReason: 'verification',
    });
    expect(await store.getSage(safe.id)).toMatchObject({ status: 'active' });
  });

  it('never revives a memory someone retired by hand', async () => {
    const store = makeStore();
    await writeFile('src/iota.ts');
    const note = await rememberFileNote(store, 'src/iota.ts', 'Iota exporter is deprecated.');
    await store.updateSage(note.id, { status: 'stale' });

    const report = await store.hygiene();

    expect(report.reactivated).toBe(0);
    expect(await store.getSage(note.id)).toMatchObject({ status: 'stale', staleReason: 'manual' });
  });

  it('does not let an existence check undo a content-hash staleness', async () => {
    const store = makeStore();
    await writeFile('src/kappa.ts');
    const note = await store.rememberSage({
      text: 'Kappa config shape is frozen.',
      importance: 0.95,
      anchors: [{ type: 'file', path: 'src/kappa.ts', contentHash: 'sha256:outdated' }],
    });
    await store.verify(note.id);
    expect(await store.getSage(note.id)).toMatchObject({
      status: 'stale',
      staleReason: 'verification',
    });

    const report = await store.hygiene();

    expect(report.reactivated).toBe(0);
    expect((await store.getSage(note.id))?.status).toBe('stale');
  });
});

describe.skipIf(!isSqliteAvailable())('candidate acceptance', () => {
  it('refuses to accept a review proposal and leaves its target untouched', async () => {
    const store = makeStore();
    const target = await rememberFileNote(store, 'src/lambda.ts', 'Lambda cache is per process.');
    const proposal = await store.createCandidate({
      text: target.text,
      kind: 'memory_review',
      targetMemoryId: target.id,
      tags: ['persistence:long_lived'],
    });

    await expect(store.acceptCandidate(proposal.id)).rejects.toThrow(/resolve it with a decision/);

    expect((await store.getSage(target.id))?.tags).toEqual(target.tags);
    expect((await store.listCandidates()).map((c) => c.id)).toContain(proposal.id);
  });

  it('returns a candidate to pending when writing its memory fails', async () => {
    const store = makeStore();
    const candidate = await store.createCandidate({ text: 'Mu scheduler drains on shutdown.' });
    const write = vi.spyOn(store, 'rememberSage').mockRejectedValueOnce(new Error('disk full'));

    await expect(store.acceptCandidate(candidate.id)).rejects.toThrow('disk full');
    expect((await store.listCandidates()).map((c) => c.id)).toContain(candidate.id);

    write.mockRestore();
    const memory = await store.acceptCandidate(candidate.id);
    expect(memory?.text).toBe('Mu scheduler drains on shutdown.');
    expect(await store.listCandidates()).toEqual([]);
  });
});

describe('outcome capture', () => {
  it('never anchors a non-command tool error as a shell command', async () => {
    const rememberSage = vi.fn(async (_input: { anchors?: unknown[] }) => ({}));
    const port = { getCapability: () => ({ rememberSage }) } as never;
    const middleware = createSageOutcomeCaptureMiddleware({ memory: port, errorPatterns: true });
    await middleware.handler(
      {
        toolUse: { type: 'tool_use', id: 't', name: 'read', input: { path: 'src/missing.ts' } },
        result: {
          type: 'tool_result',
          tool_use_id: 't',
          content: `ENOENT unique-${Date.now()}`,
          is_error: true,
        },
        ctx: {},
      } as never,
      async (payload) => payload,
    );

    expect(rememberSage).toHaveBeenCalledTimes(1);
    expect(rememberSage.mock.calls[0]?.[0]).toMatchObject({ anchors: [] });
  });
});

describe('domain-term extraction', () => {
  it('mines a conversation snapshot once, not once per provider request', async () => {
    const extractFromConversation = vi.fn(() => []);
    const middleware = createSageDomainTermExtractorMiddleware({
      memory: {} as never,
      extractorFactory: () => ({ extractFromConversation }) as never,
    });
    const messages = [{ role: 'user' as const, content: 'The Brainstem supervisor owns retries.' }];
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    await middleware.handler({ model: 'm', messages } as never, async (r) => r);
    await middleware.handler({ model: 'm', messages } as never, async (r) => r);
    await flush();
    expect(extractFromConversation).toHaveBeenCalledTimes(1);

    await middleware.handler(
      { model: 'm', messages: [...messages, { role: 'assistant', content: 'Noted.' }] } as never,
      async (r) => r,
    );
    await flush();
    expect(extractFromConversation).toHaveBeenCalledTimes(2);
  });
});
