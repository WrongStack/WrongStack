/**
 * Eternal / eternal-parallel autonomy for the WebUI hosts: the standalone
 * engine (the desktop's engine and `wstack webui`) and the CLI-hosted WebUI
 * (`wstack --webui`).
 *
 * The CLI drives the eternal engine from its REPL and TUI main loops; the
 * WebUI hosts had nothing that did, so choosing those modes only stored a
 * preference.
 * This driver owns one engine per conversation that switched to an eternal
 * mode and runs the engine's own `run()` loop for it.
 *
 * Every directive the engine sends goes through the conversation path a user
 * message takes (`runRuntimeTurn`): the run lock, the session transition gate,
 * the `run.result` envelope and the transcript all apply, and a user message
 * typed meanwhile waits its turn instead of racing the engine on one Context.
 * The engine gets the conversation's agent with only `run` rerouted.
 *
 * One conversation per host runs an eternal mode at a time: the goal file is
 * per project, and two loops would race on its journal.
 *
 * The loop ends when the engine stops itself (goal completed, cleared or
 * gone), when the conversation leaves the eternal modes, when the user stops
 * an eternal turn (Stop ends the loop, as `/autonomy stop` does in the CLI),
 * or when the conversation is no longer open. The tab's autonomy then moves
 * back (`auto` after a finished goal, `off` after a stop) and the change is
 * broadcast, so no tab is left showing an eternal mode nothing runs.
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Compactor } from '@wrongstack/contracts/types';
import { ParallelEternalEngine } from '@wrongstack/coordination';
import type { Agent, AgentInput, RunResult } from '@wrongstack/core/agent';
import { EternalAutonomyEngine } from '@wrongstack/core/execution';
import { toErrorMessage } from '@wrongstack/core/utils';
import { goalFilePath, type JournalEntry, loadGoal } from '@wrongstack/goal';
import { HOST_CAPABILITY_ETERNAL_AUTONOMY } from '@wrongstack/webui-protocol';
import type { RuntimeTurnOptions } from './conversation-turn-input.js';

export type EternalMode = 'eternal' | 'eternal-parallel';

export function isEternalMode(mode: unknown): mode is EternalMode {
  return mode === 'eternal' || mode === 'eternal-parallel';
}

/** `createConversationOperations().runRuntimeTurn`. */
export type RuntimeTurnRunner = (
  sessionId: string,
  prompt: string,
  options?: RuntimeTurnOptions,
) => Promise<{ started: boolean; result?: RunResult | undefined }>;

/** The slice of an eternal engine the driver uses. */
export interface DrivenEternalEngine {
  run(): Promise<void>;
  stop(): void;
}

export interface EternalEngineInput {
  mode: EternalMode;
  sessionId: string;
  projectRoot: string;
  /** The conversation's agent with `run` routed through the conversation path. */
  agent: Agent;
  onIteration: (entry: JournalEntry) => void;
}

type ParallelOptions = ConstructorParameters<typeof ParallelEternalEngine>[0];
type EternalOptions = ConstructorParameters<typeof EternalAutonomyEngine>[0];

export interface WebuiEternalDriverOptions {
  getProjectRoot: () => string;
  /** The conversation's agent (`getAgent`, which creates one for a known session). */
  getAgent: (sessionId: string) => Agent;
  /** The host still serves this conversation. */
  isSessionOpen: (sessionId: string) => boolean;
  /** Session-filtered broadcast. */
  broadcast: (message: { type: string; payload: unknown }) => void;
  /** Persist the default autonomy mode (the prefs writer); best-effort. */
  persistAutonomy?: ((mode: string) => Promise<void> | void) | undefined;
  events?: EventBus | undefined;
  logger?: EternalOptions['logger'];
  compactor?: Compactor | undefined;
  brain?: EternalOptions['brain'];
  /** Worker factory for eternal-parallel. */
  subagentFactory?: ParallelOptions['subagentFactory'];
  maxContextTokens?: (() => number | undefined) | undefined;
  /** Test seam: build the engine. Defaults to the real engines. */
  createEngine?: ((input: EternalEngineInput) => DrivenEternalEngine) | undefined;
  /** Wait between attempts while the conversation is busy with another turn. */
  busyRetryMs?: number | undefined;
}

export interface WebuiEternalDriver {
  /** The capability this host advertises in `session.start`. */
  readonly capability: typeof HOST_CAPABILITY_ETERNAL_AUTONOMY;
  /** Bind the conversation path's runtime-turn runner. Returns an unbind. */
  bindTurnRunner(run: RuntimeTurnRunner): () => void;
  /**
   * Why `sessionId` cannot switch to `mode` now, or undefined when it can.
   * Non-eternal modes are always allowed.
   */
  check(sessionId: string, mode: string): Promise<string | undefined>;
  /** Apply a conversation's new autonomy mode: start, keep or stop its loop. */
  setMode(sessionId: string, mode: string): void;
  /** The conversation running an eternal mode, if any. */
  activeSessionId(): string | undefined;
  /** The host switched projects: a loop on the old project's goal stops. */
  projectChanged(): void;
  dispose(): void;
}

interface Running {
  sessionId: string;
  mode: EternalMode;
  engine: DrivenEternalEngine;
  /** Set when the driver itself stopped the engine; the loop end then settles nothing. */
  cancelled: boolean;
  /** Set when the user stopped an eternal turn. */
  userStopped: boolean;
  /** Set when the conversation was no longer open. */
  closed: boolean;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

function promptText(input: AgentInput): string {
  if (typeof input === 'string') return input;
  return input
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * The conversation's agent with `run` replaced. Everything else (context,
 * events, tools) is the real agent's, read with the agent as `this`.
 */
function withRoutedRun(agent: Agent, run: Agent['run']): Agent {
  return new Proxy(agent, {
    get(target, prop) {
      if (prop === 'run') return run;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

export function createWebuiEternalDriver(opts: WebuiEternalDriverOptions): WebuiEternalDriver {
  let turnRunner: RuntimeTurnRunner | undefined;
  let running: Running | undefined;
  let disposed = false;
  const busyRetryMs = opts.busyRetryMs ?? 1000;

  const warn = (message: string): void => {
    try {
      opts.logger?.warn?.(message);
    } catch {
      // Logging never breaks the loop.
    }
  };

  /** Move the tab's autonomy to `mode` and tell every page showing it. */
  const settleMode = (sessionId: string, mode: 'auto' | 'off'): void => {
    try {
      opts.getAgent(sessionId).ctx.meta['autonomy'] = mode;
    } catch {
      // A conversation that is gone has no meta to move.
    }
    void Promise.resolve()
      .then(() => opts.persistAutonomy?.(mode))
      .catch((err) => warn(`eternal: autonomy mode was not saved: ${toErrorMessage(err)}`));
    opts.broadcast({ type: 'prefs.updated', payload: { autonomy: mode, sessionId } });
  };

  const reportError = (sessionId: string, message: string): void => {
    opts.broadcast({ type: 'error', payload: { sessionId, phase: 'eternal', message } });
  };

  const buildEngine = (input: EternalEngineInput): DrivenEternalEngine => {
    if (opts.createEngine) return opts.createEngine(input);
    const maxContextTokens = opts.maxContextTokens?.();
    const common = {
      agent: input.agent,
      projectRoot: input.projectRoot,
      compactor: opts.compactor,
      maxContextTokens: maxContextTokens && maxContextTokens > 0 ? maxContextTokens : undefined,
      onIteration: input.onIteration,
      events: opts.events,
      logger: opts.logger,
    };
    if (input.mode === 'eternal-parallel') {
      return new ParallelEternalEngine({ ...common, subagentFactory: opts.subagentFactory });
    }
    // A short gap between iterations: a paused mission ends each pass at once,
    // and without it the loop would re-read the goal file without pause.
    return new EternalAutonomyEngine({ ...common, brain: opts.brain, cycleGapMs: 1000 });
  };

  const start = (sessionId: string, mode: EternalMode): void => {
    const agent = opts.getAgent(sessionId);
    const state = {} as Running;
    const routedRun: Agent['run'] = async (input, runOptions) => {
      const signal = runOptions?.signal;
      const prompt = promptText(input);
      for (;;) {
        if (signal?.aborted || state.cancelled) {
          return { status: 'aborted', iterations: 0, abortReason: 'eternal autonomy stopped' };
        }
        if (!opts.isSessionOpen(sessionId)) {
          state.closed = true;
          state.engine.stop();
          return { status: 'aborted', iterations: 0, abortReason: 'conversation closed' };
        }
        if (!turnRunner)
          throw new Error('This engine has no conversation path to run eternal turns on.');
        const outcome = await turnRunner(sessionId, prompt, {
          ...(signal ? { signal } : {}),
          ...(runOptions?.autonomousContinue ? { autonomousContinue: true } : {}),
          ...(runOptions?.maxIterations !== undefined
            ? { maxIterations: runOptions.maxIterations }
            : {}),
          resultOrigin: 'eternal',
        });
        if (outcome.started) {
          if (!outcome.result) {
            throw new Error('The eternal iteration failed; the conversation shows the error.');
          }
          // Aborted while neither the engine nor the driver asked: the user
          // pressed Stop on this turn. That ends the loop.
          if (outcome.result.status === 'aborted' && !signal?.aborted && !state.cancelled) {
            state.userStopped = true;
            state.engine.stop();
          }
          return outcome.result;
        }
        // Another turn holds the conversation (the user typed, a woken leader
        // runs) or it is not open in this runtime yet: wait for it.
        await sleep(busyRetryMs, signal);
      }
    };
    Object.assign(state, {
      sessionId,
      mode,
      cancelled: false,
      userStopped: false,
      closed: false,
      engine: buildEngine({
        mode,
        sessionId,
        projectRoot: opts.getProjectRoot(),
        agent: withRoutedRun(agent, routedRun),
        onIteration: (entry) =>
          opts.broadcast({ type: 'eternal.iteration', payload: { entry, sessionId } }),
      }),
    } satisfies Running);
    running = state;
    void state.engine
      .run()
      .catch((err) => {
        warn(`eternal: engine loop failed: ${toErrorMessage(err)}`);
        reportError(sessionId, `Eternal autonomy stopped: ${toErrorMessage(err)}`);
      })
      .finally(() => {
        if (running === state) running = undefined;
        if (state.cancelled || disposed) return;
        // The engine ended on its own (goal done, cleared or gone), the user
        // stopped it, or the conversation went away.
        if (state.closed) return;
        settleMode(sessionId, state.userStopped ? 'off' : 'auto');
      });
  };

  const stopRunning = (): void => {
    const current = running;
    if (!current) return;
    current.cancelled = true;
    running = undefined;
    try {
      current.engine.stop();
    } catch (err) {
      warn(`eternal: engine stop failed: ${toErrorMessage(err)}`);
    }
  };

  return {
    capability: HOST_CAPABILITY_ETERNAL_AUTONOMY,
    bindTurnRunner(run) {
      turnRunner = run;
      return () => {
        if (turnRunner === run) turnRunner = undefined;
      };
    },
    async check(sessionId, mode) {
      if (!isEternalMode(mode)) return undefined;
      if (disposed) return 'This engine is shutting down.';
      if (running && running.sessionId !== sessionId) {
        return 'Another conversation in this project is already running eternal autonomy. Stop it there first.';
      }
      if (!turnRunner) return 'This engine has no conversation path to run eternal turns on.';
      const goal = await loadGoal(goalFilePath(opts.getProjectRoot())).catch(() => null);
      if (!goal) return 'Eternal autonomy needs a goal. Set one first (/goal set <mission>).';
      if (goal.goalState === 'completed') {
        return 'The project goal is already completed. Clear it and set a new one first.';
      }
      return undefined;
    },
    setMode(sessionId, mode) {
      if (disposed) return;
      if (!isEternalMode(mode)) {
        if (running?.sessionId === sessionId) stopRunning();
        return;
      }
      if (running?.sessionId === sessionId) {
        if (running.mode === mode) return;
        stopRunning();
      } else if (running) {
        // `check` refuses this on `autonomy.switch`; a `prefs.update` that
        // bypassed it must not start a second loop on the same goal.
        reportError(
          sessionId,
          'Another conversation in this project is already running eternal autonomy.',
        );
        settleMode(sessionId, 'off');
        return;
      }
      try {
        start(sessionId, mode);
      } catch (err) {
        running = undefined;
        reportError(sessionId, `Eternal autonomy did not start: ${toErrorMessage(err)}`);
        settleMode(sessionId, 'off');
      }
    },
    activeSessionId: () => running?.sessionId,
    projectChanged() {
      const sessionId = running?.sessionId;
      if (sessionId === undefined) return;
      stopRunning();
      settleMode(sessionId, 'off');
    },
    dispose() {
      disposed = true;
      stopRunning();
      turnRunner = undefined;
    },
  };
}
