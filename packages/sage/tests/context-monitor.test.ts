import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it, vi } from 'vitest';
import { createSageContextMonitorMiddleware } from '../src/middleware/context-monitor.js';
import { InjectionTracker } from '../src/middleware/injection-tracker.js';
import {
  createSageToolCallMiddleware,
  type SageRetrieverLike,
} from '../src/middleware/tool-call-memory.js';
import { SqliteSageStore as SageStore } from '../src/sqlite-store.js';

// The SQLite store exposes retrieveForPath(paths[]); the middleware consumes the
// host-facing retriever surface (retrieveForPath({ path })). Production wires the
// two through SqliteMemoryPort's retrieval capability — this mirrors that adapter.
function asRetriever(store: SageStore): SageRetrieverLike {
  return {
    retrieveForPath: (opts) => store.retrieveForPath([opts.path], opts),
    searchSage: (query, opts) => store.searchSage(query, opts),
    findRelatedSage: (memoryIds, opts) => store.findRelatedSage(memoryIds, opts),
    recordInjection: (memoryIds, trigger, sessionId) =>
      store.recordInjection(memoryIds, trigger, sessionId),
    recordUse: (memoryIds, source, sessionId) => store.recordUse(memoryIds, source, sessionId),
  };
}

describe('SAGE provider-context monitor', () => {
  it('uses default time/session values and extracts every textual request block', async () => {
    const events = new EventBus();
    const tracker = new InjectionTracker();
    const snapshot = vi.spyOn(tracker, 'snapshotContextParts').mockReturnValue({
      activeMemoryIds: [],
      enteredMemoryIds: [],
      exitedMemoryIds: [],
    });
    const middleware = createSageContextMonitorMiddleware({ tracker, events });
    const request = {
      model: 'test',
      system: [{ text: 'system text' }],
      messages: [
        { role: 'user', content: 'plain text' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'block text' },
            { type: 'tool_result', tool_use_id: 'tool', content: 'tool text' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
          ],
        },
      ],
    };

    await expect(middleware.handler(request as never, async (value) => value)).resolves.toBe(
      request,
    );
    const [parts, sessionId, timestamp] = snapshot.mock.calls[0]!;
    expect([...parts]).toEqual(['system text', 'plain text', 'block text', 'tool text']);
    expect(sessionId).toBeUndefined();
    expect(timestamp).toEqual(expect.any(Number));
  });

  it('emits the exact active/entered/exited memory ids around provider requests', async () => {
    const events = new EventBus();
    const tracker = new InjectionTracker();
    const snapshots: Array<Record<string, unknown>> = [];
    events.on('memory.context_snapshot', (payload) => snapshots.push(payload));
    tracker.record(
      'mem_contract',
      'The refresh flow rotates the token before returning.',
      Date.parse('2026-07-19T12:00:00.000Z'),
      'sess_test',
    );
    let now = new Date('2026-07-19T12:00:01.000Z');
    const middleware = createSageContextMonitorMiddleware({
      tracker,
      events,
      getSessionId: () => 'sess_test',
      now: () => now,
    });

    await middleware.handler(
      {
        model: 'test',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_1',
                content: 'The refresh flow rotates the token before returning.',
              },
            ],
          },
        ],
      },
      async (request) => request,
    );

    now = new Date('2026-07-19T12:00:02.000Z');
    await middleware.handler(
      {
        model: 'test',
        messages: [{ role: 'user', content: 'Compacted context.' }],
      },
      async (request) => request,
    );

    expect(snapshots).toEqual([
      expect.objectContaining({
        sessionId: 'sess_test',
        activeMemoryIds: ['mem_contract'],
        enteredMemoryIds: ['mem_contract'],
        exitedMemoryIds: [],
      }),
      expect.objectContaining({
        sessionId: 'sess_test',
        activeMemoryIds: [],
        enteredMemoryIds: [],
        exitedMemoryIds: ['mem_contract'],
      }),
    ]);
  });

  it('confirms a tool-result injection in the next provider-bound request', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-context-flow-'));
    let store: SageStore | undefined;
    try {
      const events = new EventBus();
      const tracker = new InjectionTracker();
      store = new SageStore({ projectRoot });
      const memory = await store.rememberSage({
        text: 'Statusline context counts come from provider request snapshots.',
        kind: 'convention',
        importance: 0.95,
        confidence: 0.98,
        anchors: [{ type: 'file', path: 'src/statusline.ts' }],
      });
      const toolMiddleware = createSageToolCallMiddleware({
        memory: asRetriever(store),
        tracker,
        events,
        repeatCooldownMs: 0,
      });
      const toolPayload = {
        toolUse: {
          type: 'tool_use' as const,
          id: 'tool_read',
          name: 'read',
          input: { path: 'src/statusline.ts' },
        },
        result: {
          type: 'tool_result' as const,
          tool_use_id: 'tool_read',
          content: 'source text',
        },
        ctx: {
          projectRoot,
          cwd: projectRoot,
          session: { id: 'leader-session' },
          signal: new AbortController().signal,
        },
      };
      await toolMiddleware.handler(toolPayload as never, async (payload) => payload);
      const memoryEvidence =
        (
          toolPayload.ctx as typeof toolPayload.ctx & {
            memoryEvidence?: Array<{ source: string; text: string }>;
          }
        ).memoryEvidence ?? [];
      expect(toolPayload.result.content).toBe('source text');
      expect(memoryEvidence[0]?.text).toContain(memory.text);

      const snapshots: Array<{ activeMemoryIds: string[] }> = [];
      events.on('memory.context_snapshot', (payload) => snapshots.push(payload));
      const contextMiddleware = createSageContextMonitorMiddleware({
        tracker,
        events,
        getSessionId: () => 'leader-session',
      });
      await contextMiddleware.handler(
        {
          model: 'test',
          system: memoryEvidence.map((entry) => ({ type: 'text' as const, text: entry.text })),
          messages: [
            {
              role: 'user',
              content: [{ ...toolPayload.result }],
            },
          ],
        },
        async (request) => request,
      );

      expect(snapshots.at(-1)?.activeMemoryIds).toEqual([memory.id]);
    } finally {
      store?.close();
      // Give Windows a tick to release SQLite WAL file handles before removal.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
