import { describe, expect, it, vi } from 'vitest';
import { PROMPT_JOURNAL_RAW_MARKER } from '@wrongstack/core/prompts';
import { createRunBlocksController, type RunBlocksRefs } from '../src/run-blocks-controller.js';

/**
 * The bug this pins: `runBlocks` had NO busy guard even though both
 * wait-loop callers (mid-run steer, /steer runText) documented one — a
 * second call while a run was in flight clobbered `activeController`
 * (making the first run un-abortable) and interleaved two streams into one
 * session JSONL. The guard keys on `activeController` (set/cleared
 * synchronously inside runBlocks), NOT on the React-committed status cell,
 * so the tail queue-drain — which fires one frame before the status cell
 * flips back to 'idle' — keeps working.
 */

type QueueItem = { displayText: string; blocks: unknown[]; journalRaw?: string | undefined };

function makeRefs(queue: QueueItem[] = []): RunBlocksRefs {
  return {
    sessionGeneration: { current: 1 },
    activeRunGeneration: { current: 0 },
    activeRunSettled: { current: Promise.resolve() },
    activeController: { current: null },
    interrupts: { current: 0 },
    assistantCommitted: { current: false },
    streamingText: { current: '' },
    streamSegments: { current: [] },
    pendingDelta: { current: '' },
    flushTimer: { current: null },
    chime: { current: false },
    state: { current: { queue } as never },
  } as never;
}

function makeHost(refs: RunBlocksRefs) {
  const run = vi.fn().mockResolvedValue({ status: 'done', iterations: 1 });
  const dispatch = vi.fn((action: { type: string }) => {
    // Mirror the real reducer's queue behavior so the tail drain terminates.
    if (action.type === 'dequeueFirst') {
      const state = refs.state.current as { queue: QueueItem[] };
      refs.state.current = { ...state, queue: state.queue.slice(1) } as never;
    }
  });
  const host = {
    capabilities: {
      agent: {
        run,
        ctx: {
          provider: { id: 'p', capabilities: { vision: false } },
          model: 'm',
          meta: {} as Record<string, unknown>,
        },
      },
      visionAdapters: [],
    },
    refs,
    dispatch,
  };
  return { host: host as never, run, dispatch };
}

const textBlocks = (text: string) => [{ type: 'text', text }] as never;

describe('runBlocks busy guard', () => {
  it('queues instead of clobbering an in-flight run', async () => {
    const refs = makeRefs();
    const { host, run, dispatch } = makeHost(refs);
    const inFlight = new AbortController();
    refs.activeController.current = inFlight;

    const runBlocks = createRunBlocksController(host);
    await runBlocks(textBlocks('second request'));

    expect(run, 'a second concurrent agent.run() was started').not.toHaveBeenCalled();
    expect(refs.activeController.current, 'the first run lost its controller').toBe(inFlight);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'enqueue',
      item: { displayText: 'second request', blocks: textBlocks('second request') },
    });
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'status', status: 'running' });
  });

  it('runs normally when idle and clears the controller afterwards', async () => {
    const refs = makeRefs();
    const { host, run, dispatch } = makeHost(refs);

    const runBlocks = createRunBlocksController(host);
    await runBlocks(textBlocks('hello'));

    expect(run).toHaveBeenCalledTimes(1);
    expect(refs.activeController.current).toBeNull();
    expect(dispatch).toHaveBeenCalledWith({ type: 'status', status: 'running' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'status', status: 'idle' });
  });

  it('still drains the FIFO queue after the run (guard must not block the tail call)', async () => {
    const refs = makeRefs([{ displayText: 'queued', blocks: textBlocks('queued') }]);
    const { host, run, dispatch } = makeHost(refs);

    const runBlocks = createRunBlocksController(host);
    await runBlocks(textBlocks('first'));

    expect(run).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith({ type: 'dequeueFirst' });
  });

  it('stamps the drained item journalRaw into ctx.meta right before that item runs', async () => {
    const refs = makeRefs([
      {
        displayText: 'refined queued',
        blocks: textBlocks('refined queued'),
        journalRaw: 'raw original',
      },
    ]);
    const { host, run } = makeHost(refs);
    const agent = (host as { capabilities: { agent: { ctx: { meta: Record<string, unknown> } } } })
      .capabilities.agent;

    const runBlocks = createRunBlocksController(host);
    await runBlocks(textBlocks('first'));

    // The drain stamped the head's journalRaw before running it, so the
    // recorder's userInput middleware consumes it for exactly that turn. The
    // mock agent.run does not run the recorder, so the marker is still set.
    expect(run).toHaveBeenCalledTimes(2);
    expect(agent.ctx.meta[PROMPT_JOURNAL_RAW_MARKER]).toBe('raw original');
  });

  it('carries a pending journal marker onto the re-enqueued item instead of orphaning it', async () => {
    const refs = makeRefs();
    const { host, dispatch } = makeHost(refs);
    const agent = (host as { capabilities: { agent: { ctx: { meta: Record<string, unknown> } } } })
      .capabilities.agent;
    agent.ctx.meta[PROMPT_JOURNAL_RAW_MARKER] = 'raw original';
    const inFlight = new AbortController();
    refs.activeController.current = inFlight;

    const runBlocks = createRunBlocksController(host);
    await runBlocks(textBlocks('second request'));

    // Entry-capture moved the marker onto the item; the slot is cleared so an
    // unrelated later turn cannot consume it.
    expect(dispatch).toHaveBeenCalledWith({
      type: 'enqueue',
      item: {
        displayText: 'second request',
        blocks: textBlocks('second request'),
        journalRaw: 'raw original',
      },
    });
    expect(agent.ctx.meta[PROMPT_JOURNAL_RAW_MARKER]).toBeUndefined();
  });
});
