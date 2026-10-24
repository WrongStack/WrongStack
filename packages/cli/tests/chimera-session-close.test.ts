/**
 * Integration test: chimera review result is appended before session.close().
 *
 * Before the fix, the chimera handler was fire-and-forget (void async IIFE),
 * so `session.close()` would race against the subagent — the review text was
 * silently dropped because `SessionWriter.append()` returns early when closed.
 *
 * The fix:
 *   - Chimera IIFE promise is stored in `pendingChimeraWork`
 *   - `finally` block awaits it before calling `session.close()`
 *
 * This test verifies that ordering: append must be called and resolved
 * before close() is allowed to proceed.
 */

import { EventBus } from '@wrongstack/contracts/kernel';
import type { SessionEvent, SessionWriter } from '@wrongstack/contracts/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ChimeraReviewNeededPayload {
  files: Array<{ path: string; status: string }>;
  cwd: string;
  config: { provider: string; model: string };
}

describe('chimera session.close ordering', () => {
  // Tracks call order to verify close() never races ahead of chimera append
  const callLog: string[] = [];

  function makeSessionWriter(): SessionWriter {
    return {
      id: 'test-session',
      transcriptPath: undefined,
      pendingToolUses: [],
      append: vi.fn(async (_event: SessionEvent) => {
        // Simulate chimera's write taking some time
        await new Promise((r) => setTimeout(r, 50));
        callLog.push('chimera-append');
      }),
      appendBatch: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(async () => {
        callLog.push('session-close');
      }),
      recordFileChange: vi.fn(),
      writeCheckpoint: vi.fn(),
      writeFileSnapshot: vi.fn(),
      truncateToCheckpoint: vi.fn(),
      clearSession: vi.fn(),
      writeInFlightMarker: vi.fn(),
      clearInFlightMarker: vi.fn(),
      recordSideEffect: vi.fn(),
    } as never;
  }

  function makeDirector() {
    return {
      spawn: vi.fn(async () => 'subagent-id'),
      assign: vi.fn(async () => {}),
      awaitTasks: vi.fn(async (_taskIds: string[]) => [
        {
          id: 'task-1',
          status: 'success',
          result: '🦂 Chimera review: all clear — no issues found.',
        },
      ]),
      onTaskEvent: vi.fn(),
    };
  }

  /**
   * Simulates the chimera handler + finally block with the FIX applied —
   * pendingChimeraWork is awaited before close().
   *
   * The real event flow is:
   *   1. events.emit('session.ended') fires synchronously
   *   2. Chimera plugin's session.ended handler (async) schedules its work
   *   3. Chimera plugin emits 'chimera.review_needed' synchronously from within
   *      the session.ended handler — this sets pendingChimeraWork
   *   4. After emit returns, finally block awaits pendingChimeraWork
   *   5. Chimera subagent appends review text (already started in step 2)
   *   6. session.close() is called after the await resolves
   *
   * In the test we simulate steps 1-3 by having a session.ended handler
   * that synchronously emits chimera.review_needed.
   */
  async function runSessionEndFlowFixed(
    events: EventBus,
    session: SessionWriter,
    director: ReturnType<typeof makeDirector>,
  ) {
    let pendingChimeraWork: Promise<void> | undefined;

    // Chimera handler: sets pendingChimeraWork when chimera.review_needed fires
    events.onPattern('chimera.review_needed', (_event, payload) => {
      const p = payload as ChimeraReviewNeededPayload;
      if (p.files.length === 0) return;

      pendingChimeraWork = (async () => {
        const results = await director.awaitTasks(['task-1']);
        const result = results[0];
        if (result?.status === 'success') {
          const reviewText =
            typeof result.result === 'string'
              ? result.result.trim()
              : JSON.stringify(result.result);
          if (reviewText) {
            await session.append({
              type: 'llm_response',
              ts: new Date().toISOString(),
              content: [{ type: 'text', text: reviewText }],
              stopReason: 'end_turn',
              usage: { input: 0, output: 0 },
            });
          }
        }
      })();
    });

    // Simulate chimera plugin's session.ended handler:
    // It listens on session.ended and then synchronously emits chimera.review_needed.
    // This is synchronous so that pendingChimeraWork is set before emit() returns.
    events.onPattern('session.ended', () => {
      events.emitCustom('chimera.review_needed', {
        config: { enabled: true, provider: 'test', model: 'test', maxFiles: 15, maxTokens: 4096 },
        cwd: '/tmp',
        files: [{ path: 'foo.ts', status: 'modified', content: '// test' }],
      });
    });

    events.emit('session.ended', { id: session.id, usage: { input: 0, output: 0 } });
    // THE FIX: await the chimera work before closing
    await pendingChimeraWork;
    await session.close();
  }

  beforeEach(() => {
    callLog.length = 0;
  });

  it('FIXED: append is called and resolved before close()', async () => {
    const events = new EventBus();
    const session = makeSessionWriter();
    const director = makeDirector();

    await runSessionEndFlowFixed(events, session, director);

    // With the fix, chimera append MUST complete before close is called
    expect(callLog).toEqual(['chimera-append', 'session-close']);
  });

  it('append is called with chimera review text', async () => {
    const events = new EventBus();
    const session = makeSessionWriter();
    const director = makeDirector();

    await runSessionEndFlowFixed(events, session, director);

    // Verify append was called with llm_response
    expect(session.append).toHaveBeenCalled();
    const appendCall = (session.append as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const event = appendCall[0] as SessionEvent;
    expect(event.type).toBe('llm_response');
    if (event.type !== 'llm_response') {
      throw new Error('expected llm_response event');
    }
    expect(event.content).toContainEqual(
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Chimera review'),
      }),
    );
  });

  it('no chimera files → close proceeds immediately', async () => {
    const events = new EventBus();
    const session = makeSessionWriter();
    // Emit session.ended without chimera files
    events.emit('session.ended', { id: session.id, usage: { input: 0, output: 0 } });
    await session.close();

    expect(session.append).not.toHaveBeenCalled();
    expect(callLog).toEqual(['session-close']);
  });
});
