/**
 * Single-shot dispatch — extracted from the tail of `execute()`.
 *
 * Follow-up to PR 6 (partial). The single-shot branch runs one
 * `agent.run()` turn from a positional/prompt argument, renders the
 * result, and returns an exit code. It is the simplest of the four
 * dispatch branches: no event loops, no server, no streaming UI —
 * just run, render, exit.
 *
 * Returns the exit code (0 success, 1 failure/max-iterations, 130
 * aborted) so the caller assigns it to its `code` variable without a
 * closure mutation.
 */
import type { Agent } from '@wrongstack/core/agent';
import type { TokenCounter } from '@wrongstack/core/types';
import { color, writeOut } from '@wrongstack/core/utils';
import { contextOverflowHint } from '../context-overflow-diagnostic.js';
import type { TerminalRenderer } from '../renderer.js';
import { fmtTok } from '../utils.js';

interface SingleShotDispatchContext {
  /** The agent to run. */
  agent: Agent;
  /** Joined positional args forming the query string. */
  query: string;
  /** Parsed top-level CLI flags (e.g. `--output-json`). */
  flags: Record<string, string | boolean>;
  /** Token counter for usage delta computation. */
  tokenCounter: TokenCounter;
  /** Terminal renderer for output. */
  renderer: TerminalRenderer;
}

/**
 * Run a single `agent.run()` turn and render the result.
 *
 * Returns the exit code: 0 success, 1 failure or max-iterations, 130
 * aborted.
 */
export async function runSingleShotDispatch(ctx: SingleShotDispatchContext): Promise<number> {
  const { agent, query, flags, tokenCounter, renderer } = ctx;

  const ctrl = new AbortController();
  const onSigint = () => ctrl.abort();
  process.on('SIGINT', onSigint);
  const startedAt = Date.now();
  const before = tokenCounter.total();
  const costBefore = tokenCounter.estimateCost().total;
  let result: import('@wrongstack/core/agent').RunResult;
  try {
    result = await agent.run(query, { signal: ctrl.signal });
  } finally {
    process.off('SIGINT', onSigint);
    // Clean up any lingering bash/exec processes.
    const { getProcessRegistry } = await import('@wrongstack/tools');
    getProcessRegistry().killAll({ preserveBackground: true });
  }
  const after = tokenCounter.total();
  const costAfter = tokenCounter.estimateCost().total;
  const usage = {
    input: after.input - before.input,
    output: after.output - before.output,
    iterations: result.iterations,
    cost: costAfter - costBefore,
    elapsedMs: Date.now() - startedAt,
  };
  if (flags['output-json']) {
    const json = JSON.stringify({
      status: result.status,
      finalText: result.finalText ?? null,
      error: result.error
        ? {
            code: result.error.code,
            subsystem: result.error.subsystem,
            severity: result.error.severity,
            recoverable: result.error.recoverable,
            message: result.error.message,
            context: result.error.context ?? null,
          }
        : null,
      usage,
    });
    writeOut(json + '\n');
    return 0;
  }

  let code = 0;
  if (result.status === 'failed') {
    code = 1;
    const err = result.error;
    if (err) {
      const tag = err.recoverable ? ' (recoverable)' : '';
      renderer.writeError(`Failed [${err.severity}]${tag}: ${err.describe()}`);
      const hint = contextOverflowHint(err);
      if (hint) renderer.writeWarning(hint);
    } else {
      renderer.writeError('Failed.');
    }
  } else if (result.status === 'aborted') {
    code = 130;
    renderer.writeWarning('Aborted.');
  } else if (result.status === 'max_iterations') {
    code = 1;
    renderer.writeWarning(`Hit max iterations (${result.iterations}).`);
  }
  if (result.finalText) renderer.write('\n' + result.finalText + '\n');
  // Surface any delegate subagent completion banners.
  const r = result as {
    delegateSummaries?: Array<{ summary: string | undefined; ok: boolean }>;
    messages?: Array<unknown> | undefined;
  };
  renderer.writeDelegateSummaries(r);
  renderer.write(
    '\n' +
      color.dim(
        `[in: ${fmtTok(usage.input)}  out: ${fmtTok(usage.output)}  iters: ${usage.iterations}  cost: ${usage.cost.toFixed(4)}  ${(usage.elapsedMs / 1000).toFixed(1)}s]`,
      ) +
      '\n',
  );
  return code;
}
