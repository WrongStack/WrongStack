import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Request } from '@wrongstack/contracts/types';
import { createDefaultPipelines, type ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { formatMemoryEvidenceBlock } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { setupSage } from '../src/host-wiring.js';
import { SqliteMemoryPort } from '../src/memory-port.js';
import { createSageEvidenceRefreshMiddleware } from '../src/middleware/evidence-refresh.js';
import { InjectionTracker } from '../src/middleware/injection-tracker.js';
import { createSageToolCallMiddleware } from '../src/middleware/tool-call-memory.js';
import { TOOL_MEMORY_EVIDENCE_SOURCE } from '../src/middleware/tool-call-memory-trace.js';
import { isSqliteAvailable } from '../src/sqlite-store.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-evidence-freshness-'));
  let now = new Date('2026-10-03T12:00:00.000Z');
  const memory = new SqliteMemoryPort({ projectRoot: dir, now: () => now });
  const pipelines = createDefaultPipelines();
  const events = new EventBus();
  const snapshots: Array<{ activeMemoryIds: string[] }> = [];
  events.on('memory.context_snapshot', (snapshot) => snapshots.push(snapshot));
  const teardown = setupSage({
    config: { features: { memory: true }, Sage: { inject: { turnContext: false } } } as Config,
    pipelines,
    memoryStore: memory,
    events,
    logger: { debug: vi.fn() } as never,
    getSessionId: () => 'session-a',
  });
  cleanups.push(async () => {
    await teardown();
    memory.close();
    await removeProjectFixtureDirectory(dir, { maxRetries: 5, retryDelay: 100 });
  });
  const ctx = {
    cwd: dir,
    projectRoot: dir,
    session: { id: 'session-a' },
    signal: new AbortController().signal,
    memoryEvidence: [] as Array<{ source: string; text: string }>,
  };
  const read = () =>
    pipelines.toolCall.run({
      toolUse: { type: 'tool_use', id: 'read-a', name: 'read', input: { path: 'a.ts' } },
      result: { type: 'tool_result', tool_use_id: 'read-a', content: 'file content' },
      ctx,
    } as unknown as ToolCallPipelinePayload);
  const request = (): Request => ({
    model: 'test',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'continue', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: '[live_context]' },
          ...ctx.memoryEvidence.map(({ source, text }) => ({
            type: 'text' as const,
            text: formatMemoryEvidenceBlock(source, text),
          })),
        ],
      },
    ],
  });
  const note = await memory.rememberSage({
    text: 'The package dependency is missing.',
    importance: 0.95,
    anchors: [{ type: 'file', path: 'a.ts' }],
  });
  await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1;');
  return {
    memory,
    pipelines,
    ctx,
    read,
    request,
    note,
    snapshots,
    setTime: (value: string) => {
      now = new Date(value);
    },
  };
}

describe.skipIf(!isSqliteAvailable())('injected evidence freshness (#401)', () => {
  it('refreshes text, revision and verification from the store on every provider request', async () => {
    const { memory, pipelines, read, request, note, snapshots, setTime } = await fixture();
    await read();
    const original = request();
    expect(JSON.stringify(original)).toContain('dependency is missing');
    expect(JSON.stringify(original)).toContain('updated=2026-10-03');
    setTime('2026-10-04T12:00:00.000Z');
    await memory.updateSage(note.id, { text: 'The package dependency is installed.' });
    const [verification] = await memory.verify(note.id);
    expect(verification?.status).toBe('verified');
    const current = await memory.getSage(note.id);
    const sent = await pipelines.request.run(original);
    expect(JSON.stringify(sent)).toContain('dependency is installed');
    expect(JSON.stringify(sent)).not.toContain('dependency is missing');
    expect(JSON.stringify(sent)).toContain(`revision=${current!.revision}`);
    expect(JSON.stringify(sent)).toContain('updated=2026-10-04');
    expect(JSON.stringify(sent)).toContain(
      `anchorVerified=${verification!.checkedAt.slice(0, 10)}`,
    );
    expect(JSON.stringify(original)).toContain('dependency is missing');
    expect((sent.messages[0]!.content as unknown[])[0]).toEqual(
      (original.messages[0]!.content as unknown[])[0],
    );
    expect(snapshots.at(-1)?.activeMemoryIds).toContain(note.id);
    setTime('2026-10-05T12:00:00.000Z');
    await memory.verify(note.id);
    const sentAgain = await pipelines.request.run(request());
    expect(JSON.stringify(sentAgain)).toContain('anchorVerified=2026-10-05');
    expect((await memory.getSage(note.id))!.injectionCount).toBe(1);
  });

  it.each(['archived', 'stale', 'deleted'] as const)(
    'removes %s evidence before the next request without another retrieval',
    async (state) => {
      const { memory, pipelines, read, request, note } = await fixture();
      await read();
      if (state === 'deleted') await memory.deleteSage(note.id, 'test', { force: true });
      else await memory.updateSage(note.id, { status: state });
      const sent = await pipelines.request.run(request());
      expect(JSON.stringify(sent)).not.toContain(note.id);
    },
  );

  it('removes a retained never-inject record even when a by-id reader returns it', async () => {
    const { read, request, note } = await fixture();
    await read();
    const middleware = createSageEvidenceRefreshMiddleware({
      getMemory: async () => ({ ...note, contextPolicy: 'never' }),
    });
    const sent = await middleware.handler(request(), async (r) => r);
    expect(JSON.stringify(sent)).not.toContain(note.id);
  });

  it('uses the owning request session and removes evidence whose ownership changed', async () => {
    const { read, request, note } = await fixture();
    await read();
    const middleware = createSageEvidenceRefreshMiddleware({
      getMemory: async () => ({ ...note, scope: 'session', ownerSessionId: 'session-a' }),
      getSessionId: () => 'session-a',
    });
    const req = request();
    req.cache = { sessionId: 'session-b' };
    const sent = await middleware.handler(req, async (r) => r);
    expect(JSON.stringify(sent)).not.toContain(note.id);
  });

  it('refreshes system fallback evidence and preserves historical copies', async () => {
    const { memory, pipelines, read, request, note } = await fixture();
    await read();
    const block = (request().messages[0]!.content as Array<{ type: 'text'; text: string }>)[2]!;
    await memory.updateSage(note.id, {
      text: 'Current dependency installation has been verified.',
    });
    const req: Request = {
      model: 'test',
      system: [block],
      messages: [{ role: 'assistant', content: [block] }],
    };
    const sent = await pipelines.request.run(req);
    expect(sent.system![0]!.text).toContain('installation has been verified');
    expect(sent.messages[0]).toBe(req.messages[0]);
    expect(block.text).toContain('dependency is missing');
  });

  it('drops unverifiable retained rows when the current store read fails', async () => {
    const { read, request, note } = await fixture();
    await read();
    const middleware = createSageEvidenceRefreshMiddleware({
      getMemory: async () => {
        throw new Error('unavailable');
      },
    });
    const sent = await middleware.handler(request(), async (r) => r);
    expect(JSON.stringify(sent)).not.toContain(note.id);
  });

  it('does not restore evidence cleared while a tool refresh awaited the store', async () => {
    const { ctx, read, note } = await fixture();
    await read();
    let resolveRead!: (value: typeof note) => void;
    let signalRead!: () => void;
    const started = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const middleware = createSageToolCallMiddleware({
      memory: { searchSage: async () => [], retrieveForPath: async () => [] },
      getMemory: () => {
        signalRead();
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    });
    const running = middleware.handler(
      {
        toolUse: { type: 'tool_use', id: 'u', name: 'memory_update', input: {} },
        result: { type: 'tool_result', tool_use_id: 'u', content: 'updated' },
        ctx,
      } as unknown as ToolCallPipelinePayload,
      async (p) => p,
    );
    await started;
    ctx.memoryEvidence = [];
    resolveRead(note);
    await running;
    expect(ctx.memoryEvidence).toEqual([]);
  });

  it('refreshes the retained context on a non-retrieval tool call', async () => {
    const { memory, pipelines, ctx, read, note } = await fixture();
    await read();
    await memory.updateSage(note.id, { text: 'Dependency installation is confirmed.' });
    await pipelines.toolCall.run({
      toolUse: { type: 'tool_use', id: 'update', name: 'memory_update', input: { id: note.id } },
      result: { type: 'tool_result', tool_use_id: 'update', content: 'updated' },
      ctx,
    } as unknown as ToolCallPipelinePayload);
    expect(
      ctx.memoryEvidence.find((e) => e.source === TOOL_MEMORY_EVIDENCE_SOURCE)?.text,
    ).toContain('Dependency installation is confirmed.');
  });

  it('rejects inactive and never-inject records from an alternate retriever before text deduplication', async () => {
    const { memory, ctx, note } = await fixture();
    const active = await memory.getSage(note.id);
    const middleware = createSageToolCallMiddleware({
      memory: {
        retrieveForPath: async () => [
          { ...active!, id: 'archived', text: 'Archived package fact.', status: 'archived' },
          {
            ...active!,
            id: 'never',
            text: 'Never inject this package fact.',
            contextPolicy: 'never',
          },
          active!,
        ],
        searchSage: async () => [],
      },
    });
    await middleware.handler(
      {
        toolUse: { type: 'tool_use', id: 'read', name: 'read', input: { path: 'a.ts' } },
        result: { type: 'tool_result', tool_use_id: 'read', content: 'contents' },
        ctx,
      } as unknown as ToolCallPipelinePayload,
      async (p) => p,
    );
    const text = ctx.memoryEvidence[0]?.text;
    expect(text).toContain(note.id);
    expect(text).not.toContain('id="archived"');
    expect(text).not.toContain('id="never"');
  });
});

describe('retained evidence usefulness', () => {
  it('refreshes text matching without re-arming an already consumed use credit', () => {
    const tracker = new InjectionTracker();
    const oldText = 'Old package dependencies are missing from this workspace';
    const newText = 'New architecture checks pass across every current package';
    tracker.record('note', oldText, 5_000, 'sess');
    expect(tracker.consumeMatches(oldText, 5_001, 'sess')).toEqual(['note']);
    tracker.refresh('note', newText, 'sess', newText);
    expect(tracker.snapshotContext(newText, 'sess', 5_002).activeMemoryIds).toEqual(['note']);
    expect(tracker.consumeMatches(newText, 5_003, 'sess')).toEqual([]);
  });
});
