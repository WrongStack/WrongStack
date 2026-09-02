import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import type { State } from '../src/app-state.js';

/**
 * Regression: an active TUI stream cleared via `/clear`.
 *
 * The command-level ordering (abort + waitForIdle before context reset) is
 * covered in `packages/cli/tests/slash-misc.test.ts`. This test guards the TUI
 * half: once `/clear` dispatches `clearHistory`, every piece of live-stream
 * state produced by the aborted run must be gone, so stale streamed text, an
 * in-flight tool tail, running-tool spinners, a queued follow-up, a pending
 * confirm panel, and steering state cannot leak into the fresh session.
 *
 * The test is intentionally reducer-driven (pure, deterministic) rather than
 * mount-driven: the mock Ink terminal does not reliably run boot-submit effects
 * under vitest, which made an end-to-end variant flaky.
 */
function streamingState(): State {
  return {
    entries: [
      { kind: 'banner', id: 0, model: 'initial-model', provider: 'old-provider' } as never,
      { kind: 'user', id: 1, text: 'do work' } as never,
    ],
    buffer: '',
    cursor: 0,
    streamingText: 'partial assistant reply that was mid-stream',
    toolStream: { toolUseId: 'tool-1', name: 'bash', text: 'in-flight output', startedAt: 1 },
    status: 'running',
    interrupts: 1,
    steeringPending: true,
    steerSnapshot: {
      runningTools: ['bash'],
      subagents: [],
      subagentsTerminated: 0,
      partialAssistantText: 'partial assistant reply that was mid-stream',
    },
    hint: '',
    brain: { state: 'idle' },
    nextId: 2,
    historyGen: 3,
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map([['tool-1', { name: 'bash', startedAt: 1 }]]),
    queue: [
      {
        id: 1,
        displayText: 'queued follow-up',
        blocks: [{ type: 'text', text: 'queued follow-up' }],
      },
    ],
    nextQueueId: 2,
    confirmQueue: [
      {
        toolUseId: 'tool-1',
        toolName: 'bash',
        input: {},
        resolve: () => {},
        destructive: false,
      },
    ],
    clearConfirm: {
      leaderActive: true,
      subagentCount: 2,
      value: 'Y',
      resolve: () => {},
    },
    slashConfirm: {
      question: 'Continue?',
      defaultYes: false,
      resolve: () => {},
    },
    brainPrompt: {
      requestId: 'brain-1',
      source: 'test',
      risk: 'high',
      question: 'Choose a direction',
    },
    debugStreamStats: {
      chunkCount: 3,
      lastChunkSize: 12,
      lastDeltaMs: 40,
      totalBytes: 36,
      lastChunkAt: new Date().toISOString(),
    },
  } as unknown as State;
}

describe('/clear during an active TUI stream', () => {
  it('discards all in-flight stream/tool/queue state and refreshes the preserved banner model', () => {
    const out = reducer(streamingState(), {
      type: 'clearHistory',
      model: 'current-model',
      provider: 'live-provider',
    });

    // Transcript resets to the banner only — no user/assistant carryover — and
    // the remounted banner follows the same live model/provider that the
    // statusline uses (regression: provider used to stay stale after /model).
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      kind: 'banner',
      model: 'current-model',
      provider: 'live-provider',
    });
    expect(out.historyGen).toBe(4);

    // No live stream can repopulate the fresh session.
    expect(out.streamingText).toBe('');
    expect(out.toolStream).toBeNull();
    expect(out.runningTools.size).toBe(0);
    expect(out.status).toBe('idle');
    expect(out.interrupts).toBe(0);

    // Steering, queued work, confirm panels, and debug counters are cleared.
    expect(out.steeringPending).toBe(false);
    expect(out.steerSnapshot).toBeNull();
    expect(out.queue).toEqual([]);
    expect(out.confirmQueue).toEqual([]);
    expect(out.clearConfirm).toBeNull();
    expect(out.slashConfirm).toBeNull();
    expect(out.brainPrompt).toBeNull();
    expect(out.debugStreamStats).toBeNull();
  });
});
