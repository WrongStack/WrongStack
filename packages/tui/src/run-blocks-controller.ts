import type { ContentBlock } from '@wrongstack/core/types';
import { PROMPT_JOURNAL_RAW_MARKER } from '@wrongstack/core/prompts';
import { toErrorMessage } from '@wrongstack/core/utils';
import { routeImagesForModel } from '@wrongstack/runtime/vision';
import type { Action, State } from './app-reducer.js';
import { fmtTok } from './components/history.js';
import type { RunBlocksCapabilities } from './tui-host-capabilities.js';
import type { MutableCell, StreamSegment } from './shared-types.js';

export interface RunBlocksRefs {
  readonly sessionGeneration: MutableCell<number>;
  readonly activeRunGeneration: MutableCell<number>;
  readonly activeRunSettled: MutableCell<Promise<void>>;
  readonly activeController: MutableCell<AbortController | null>;
  readonly interrupts: MutableCell<number>;
  readonly assistantCommitted: MutableCell<boolean>;
  readonly streamingText: MutableCell<string>;
  readonly streamSegments: MutableCell<StreamSegment[]>;
  readonly pendingDelta: MutableCell<string>;
  readonly flushTimer: MutableCell<ReturnType<typeof setTimeout> | null>;
  readonly chime: MutableCell<boolean>;
  readonly state: MutableCell<State>;
}

interface RunBlocksHost {
  readonly capabilities: RunBlocksCapabilities;
  readonly refs: RunBlocksRefs;
  dispatch(action: Action): void;
}

/**
 * Create the foreground run controller. It owns one agent iteration, result
 * recovery, summaries, lifecycle cleanup, and FIFO queue draining; the App
 * shell only supplies stable capabilities and mutable lifecycle cells.
 */
export function createRunBlocksController(
  host: RunBlocksHost,
): (blocks: ContentBlock[]) => Promise<void> {
  const runBlocks = async (blocks: ContentBlock[]): Promise<void> => {
    const { capabilities, refs, dispatch } = host;
    const { agent } = capabilities;
    // Capture the pending prompt-journal raw marker for THIS invocation at
    // entry and clear the shared slot immediately. The marker must not sit in
    // ctx.meta across the async gap below (vision routing happens BEFORE
    // agent.run), where a concurrent runBlocks invocation entering the busy
    // guard could read and steal it. It is restored right before agent.run so
    // the recorder's userInput middleware consumes it for exactly this turn.
    const capturedRaw =
      typeof agent.ctx.meta[PROMPT_JOURNAL_RAW_MARKER] === 'string'
        ? (agent.ctx.meta[PROMPT_JOURNAL_RAW_MARKER] as string)
        : undefined;
    if (capturedRaw !== undefined) {
      delete agent.ctx.meta[PROMPT_JOURNAL_RAW_MARKER];
    }
    // Busy guard. Both wait-loop callers (steer, /steer runText) document
    // that runBlocks "early-returns on the busy guard" — but no guard
    // existed: the function unconditionally overwrote `activeController`
    // and dispatched 'running', so the only serialization was each
    // caller's own (possibly stale) status check. Two concurrent runs
    // interleave into one JSONL and the first becomes un-abortable
    // (Esc/Ctrl+C only sees the second controller).
    //
    // The gate is `activeController`, not `refs.state.current.status`: the
    // status cell updates on React commit, so at the tail-drain call site
    // below it may still read 'running' a frame after `finally` cleared the
    // controller — a status gate would break queue draining. The controller
    // cell is set/cleared synchronously in this function, making it the
    // only race-free busy signal. Queue instead of dropping so a lost race
    // (eternal poll vs. user submit in the same tick) never discards input.
    if (refs.activeController.current) {
      const displayText =
        blocks
          .filter((block) => block.type === 'text')
          .map((block) => (block as { text: string }).text)
          .join(' ')
          .trim() || '(queued input)';
      // Carry THIS invocation's own captured raw (if any) onto the item —
      // never a slot read, which could belong to an in-flight run that has
      // not yet reached agent.run.
      dispatch({
        type: 'enqueue',
        item: {
          displayText,
          blocks,
          ...(capturedRaw !== undefined ? { journalRaw: capturedRaw } : {}),
        },
      });
      return;
    }
    const runGeneration = refs.sessionGeneration.current;
    refs.activeRunGeneration.current = runGeneration;
    let settleRun = () => {};
    refs.activeRunSettled.current = new Promise<void>((resolve) => {
      settleRun = resolve;
    });
    const controller = new AbortController();
    refs.activeController.current = controller;
    refs.interrupts.current = 0;
    dispatch({ type: 'resetInterrupts' });
    dispatch({ type: 'status', status: 'running' });

    try {
      const startedAt = Date.now();
      const before = capabilities.tokenCounter?.total();
      const costBefore = capabilities.tokenCounter?.estimateCost().total ?? 0;
      const routed = blocks.some((block) => block.type === 'image')
        ? await routeImagesForModel(blocks, {
            supportsVision: capabilities.supportsVision
              ? await capabilities.supportsVision()
              : agent.ctx.provider.capabilities.vision,
            adapters: capabilities.visionAdapters,
            ctx: agent.ctx,
            signal: controller.signal,
            providerId: agent.ctx.provider.id,
            model: agent.ctx.model,
          })
        : { blocks, route: 'none' as const, convertedImages: 0 };
      if (routed.route === 'adapter') {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `Image input analyzed via ${routed.adapterName ?? 'vision adapter'} (${routed.convertedImages} image${routed.convertedImages === 1 ? '' : 's'}).`,
          },
        });
      }

      refs.assistantCommitted.current = false;
      // Restore this invocation's captured raw marker right before the run so
      // the recorder's userInput middleware consumes it for exactly this turn
      // (vision routing above awaited with the slot cleared, so no concurrent
      // invocation could steal it).
      if (capturedRaw !== undefined) {
        agent.ctx.meta[PROMPT_JOURNAL_RAW_MARKER] = capturedRaw;
      }
      const result = await agent.run(routed.blocks, { signal: controller.signal });
      if (runGeneration !== refs.sessionGeneration.current) return;

      refs.streamingText.current = '';
      refs.streamSegments.current = [];
      refs.pendingDelta.current = '';
      if (refs.flushTimer.current) {
        clearTimeout(refs.flushTimer.current);
        refs.flushTimer.current = null;
      }
      dispatch({ type: 'streamReset' });
      // Provider-response events normally commit stream segments per iteration.
      // These refs retain display-sized tails only, so never promote them to
      // canonical history when a flush is missed; recover from the complete
      // run result instead.
      if (
        result.status === 'done' &&
        result.finalText?.trim() &&
        !refs.assistantCommitted.current
      ) {
        // The run has already finished, so this recovered text is by
        // construction the final message of the turn.
        dispatch({
          type: 'addEntry',
          entry: { kind: 'assistant', text: result.finalText, final: true },
        });
      }

      if (result.status === 'aborted') {
        const reason = result.abortReason ? `Aborted (${result.abortReason}).` : 'Aborted.';
        dispatch({ type: 'addEntry', entry: { kind: 'warn', text: reason } });
      } else if (result.status === 'failed') {
        const error = result.error;
        const text = error
          ? `Failed [${error.severity}${error.recoverable ? ', recoverable' : ''}]: ${error.describe()}`
          : 'Failed.';
        dispatch({ type: 'addEntry', entry: { kind: 'error', text } });
      } else if (result.status === 'max_iterations') {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: `Hit max iterations (${result.iterations}).` },
        });
      }

      if (result.status === 'done' && result.finalText && capabilities.onSDDOutput) {
        try {
          for (const message of await capabilities.onSDDOutput(result.finalText)) {
            dispatch({ type: 'addEntry', entry: { kind: 'info', text: message } });
          }
        } catch {
          // SDD detection is observational and must never fail the turn.
        }
      }

      if (
        result.status === 'done' &&
        result.finalText &&
        capabilities.onSuggestionsParsed &&
        !capabilities.shouldSuppressNextSteps?.()
      ) {
        try {
          capabilities.onSuggestionsParsed(result.finalText);
        } catch {
          // Suggestion parsing is best-effort.
        }
      }

      if (capabilities.tokenCounter && before) {
        const after = capabilities.tokenCounter.total();
        const costAfter = capabilities.tokenCounter.estimateCost().total;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'turn-summary',
            text: `[in: ${fmtTok(after.input - before.input)}  out: ${fmtTok(after.output - before.output)}  iters: ${result.iterations}  cost: ${(costAfter - costBefore).toFixed(4)}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s]`,
          },
        });
      }

      if (result.status === 'done' && capabilities.predictNext && !capabilities.shouldSuppressNextSteps?.()) {
        try {
          const userRequest = blocks
            .filter((block) => block.type === 'text')
            .map((block) => (block as { text: string }).text)
            .join(' ')
            .trim();
          const predictions = await capabilities.predictNext({
            userRequest,
            assistantSummary: result.finalText ?? '',
          });
          if (predictions.length > 0) {
            const text = [
              '↳ likely next:',
              ...predictions.map((prediction, index) => `  ${index + 1}. ${prediction}`),
            ].join('\n');
            dispatch({ type: 'addEntry', entry: { kind: 'turn-summary', text } });
          }
        } catch {
          // Prediction is best-effort.
        }
      }
      capabilities.onRunFinished?.(result.status);
    } catch (error) {
      if (runGeneration === refs.sessionGeneration.current) {
        dispatch({ type: 'addEntry', entry: { kind: 'error', text: toErrorMessage(error) } });
        capabilities.onRunFinished?.('failed');
      }
    } finally {
      refs.activeController.current = null;
      dispatch({ type: 'status', status: 'idle' });
      if (runGeneration === refs.sessionGeneration.current && refs.chime.current) {
        try {
          process.stdout.write('\x07');
        } catch {
          // stdout may already be closed during teardown.
        }
      }
      settleRun();
    }

    if (runGeneration !== refs.sessionGeneration.current) return;
    const head = refs.state.current.queue[0];
    if (head) {
      dispatch({ type: 'dequeueFirst' });
      dispatch({ type: 'addEntry', entry: { kind: 'user', text: head.displayText } });
      // Prompt-journal provenance for a queued refined prompt: stamp the raw
      // text into the single-slot marker only now, immediately before THIS
      // item runs, so the recorder's userInput middleware consumes it for
      // exactly this turn. Enqueue-time stamping (submit-controller) was
      // removed because queued items share one marker slot — the last
      // enqueue's raw would leak into every earlier item's entry, and a
      // queue-clear would orphan the marker for an unrelated later turn.
      if (head.journalRaw) {
        agent.ctx.meta[PROMPT_JOURNAL_RAW_MARKER] = head.journalRaw;
      }
      await runBlocks(head.blocks);
    }
  };

  return runBlocks;
}
