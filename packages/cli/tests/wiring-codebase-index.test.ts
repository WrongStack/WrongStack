import * as path from 'node:path';
import { type AgentPipelines, createDefaultPipelines } from '@wrongstack/core/agent';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the background indexer entry points the wiring drives.
const {
  runStartupIndexMock,
  enqueueReindexMock,
  ensureCodebaseIndexServerMock,
  cancelPendingReindexesMock,
} = vi.hoisted(() => ({
  runStartupIndexMock: vi.fn(async () => ({
    filesIndexed: 3,
    symbolsIndexed: 42,
    langStats: {},
    durationMs: 5,
    errors: [],
  })),
  enqueueReindexMock: vi.fn(),
  ensureCodebaseIndexServerMock: vi.fn(async () => {}),
  cancelPendingReindexesMock: vi.fn(),
}));
vi.mock('@wrongstack/tools', () => ({
  runStartupIndex: runStartupIndexMock,
  enqueueReindex: enqueueReindexMock,
  ensureCodebaseIndexServer: ensureCodebaseIndexServerMock,
  cancelPendingReindexes: cancelPendingReindexesMock,
  shutdownCodebaseIndexHost: vi.fn(),
  isIndexableFile: (p: string) => /\.(ts|tsx|js|jsx|go|py|rs)$/.test(p),
}));

const { setupCodebaseIndexing } = await import('../src/wiring/codebase-index.js');

const PROJECT = '/proj';
const logger = new DefaultLogger({ level: 'error' });

function fakeCtx() {
  return { cwd: PROJECT, projectRoot: PROJECT } as never;
}

function deps(indexing: unknown, pipelines: AgentPipelines) {
  return {
    config: { indexing } as never,
    context: fakeCtx(),
    pipelines,
    projectRoot: PROJECT,
    logger,
  };
}

function toolCallPayload(
  toolName: string,
  mutating: boolean,
  input: unknown,
  result: { ok: boolean; content?: unknown } = { ok: true, content: 'ok' },
) {
  return {
    toolUse: { type: 'tool_use', id: 't1', name: toolName, input },
    result: result.ok
      ? { type: 'tool_result', tool_use_id: 't1', content: result.content ?? 'ok' }
      : { type: 'tool_result', tool_use_id: 't1', content: String(result.content ?? 'err'), is_error: true },
    ctx: fakeCtx(),
    tool: { name: toolName, mutating },
  } as never;
}

beforeEach(() => {
  runStartupIndexMock.mockClear();
  enqueueReindexMock.mockClear();
  ensureCodebaseIndexServerMock.mockClear();
  cancelPendingReindexesMock.mockClear();
});

describe('setupCodebaseIndexing — startup', () => {
  it('starts a background startup index when onSessionStart is true', async () => {
    const p = createDefaultPipelines();
    await setupCodebaseIndexing(
      deps({ onSessionStart: true, onEdit: false, watchExternal: false, debounceMs: 400 }, p),
    );
    expect(runStartupIndexMock).toHaveBeenCalledTimes(1);
    expect(ensureCodebaseIndexServerMock).toHaveBeenCalledWith({
      projectRoot: PROJECT,
      watchExternal: false,
      debounceMs: 400,
    });
    expect(runStartupIndexMock).toHaveBeenCalledWith({ projectRoot: PROJECT });
  });

  it('does not block setup on the startup index completing', async () => {
    // Startup index that never resolves during this test.
    let resolveIdx: (v: unknown) => void = () => {};
    runStartupIndexMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveIdx = res;
      }),
    );
    const p = createDefaultPipelines();
    // setup resolves even though the index promise is still pending → non-blocking.
    const dispose = await setupCodebaseIndexing(
      deps({ onSessionStart: true, onEdit: false, watchExternal: false, debounceMs: 400 }, p),
    );
    expect(typeof dispose).toBe('function');
    expect(runStartupIndexMock).toHaveBeenCalledTimes(1);
    resolveIdx({ filesIndexed: 1, symbolsIndexed: 1, langStats: {}, durationMs: 1, errors: [] });
  });

  it('skips startup index when onSessionStart is false', async () => {
    const p = createDefaultPipelines();
    await setupCodebaseIndexing(
      deps({ onSessionStart: false, onEdit: false, watchExternal: false, debounceMs: 400 }, p),
    );
    expect(runStartupIndexMock).not.toHaveBeenCalled();
  });

  it('is a no-op when no indexing config is present', async () => {
    const p = createDefaultPipelines();
    await setupCodebaseIndexing(deps(undefined, p));
    expect(runStartupIndexMock).not.toHaveBeenCalled();
    // No middleware should have been registered.
    await p.toolCall.run(toolCallPayload('write', true, { path: '/proj/a.ts' }));
    expect(enqueueReindexMock).not.toHaveBeenCalled();
  });
});

describe('setupCodebaseIndexing — onEdit middleware', () => {
  it('reindexes file-editing tools and ignores others', async () => {
    const p = createDefaultPipelines();
    await setupCodebaseIndexing(
      deps({ onSessionStart: false, onEdit: true, watchExternal: false, debounceMs: 250 }, p),
    );

    await p.toolCall.run(toolCallPayload('write', true, { path: 'src/a.ts' }));
    expect(enqueueReindexMock).toHaveBeenCalledTimes(1);
    expect(enqueueReindexMock.mock.calls[0]?.[0]).toMatchObject({
      projectRoot: PROJECT,
      // path.resolve(ctx.cwd, path) — normalized per-platform.
      files: [path.resolve(PROJECT, 'src/a.ts')],
      debounceMs: 250,
    });

    // A failed write must not schedule a reindex — it would index a file that
    // still has the prior contents (or doesn't exist yet).
    await p.toolCall.run(
      toolCallPayload('write', true, { path: 'src/fail.ts' }, { ok: false, content: 'disk full' }),
    );
    expect(enqueueReindexMock).toHaveBeenCalledTimes(1);

    // An out-of-project path is silently dropped, never indexed.
    await p.toolCall.run(toolCallPayload('write', true, { path: '/elsewhere/a.ts' }));
    expect(enqueueReindexMock).toHaveBeenCalledTimes(1);

    // Non-file / non-mutating tools are ignored.
    await p.toolCall.run(toolCallPayload('grep', false, { pattern: 'x' }));
    await p.toolCall.run(toolCallPayload('bash', true, { command: 'ls' }));
    expect(enqueueReindexMock).toHaveBeenCalledTimes(1);
  });

  it('ignores edits to non-indexable files', async () => {
    const p = createDefaultPipelines();
    await setupCodebaseIndexing(
      deps({ onSessionStart: false, onEdit: true, watchExternal: false, debounceMs: 250 }, p),
    );
    await p.toolCall.run(toolCallPayload('write', true, { path: 'README.md' }));
    expect(enqueueReindexMock).not.toHaveBeenCalled();
  });

  it('does not register the middleware when onEdit is false', async () => {
    const p = createDefaultPipelines();
    await setupCodebaseIndexing(
      deps({ onSessionStart: false, onEdit: false, watchExternal: false, debounceMs: 250 }, p),
    );
    await p.toolCall.run(toolCallPayload('write', true, { path: 'src/a.ts' }));
    expect(enqueueReindexMock).not.toHaveBeenCalled();
  });
});

describe('setupCodebaseIndexing — dispose', () => {
  it('returns a dispose that cancels pending reindexes', async () => {
    const p = createDefaultPipelines();
    const dispose = await setupCodebaseIndexing(
      deps({ onSessionStart: false, onEdit: true, watchExternal: false, debounceMs: 250 }, p),
    );
    dispose();
    expect(cancelPendingReindexesMock).toHaveBeenCalledTimes(1);
  });
});
