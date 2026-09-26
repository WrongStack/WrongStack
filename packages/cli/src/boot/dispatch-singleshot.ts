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
import type { Agent, RunResult } from '@wrongstack/core/agent';
import type { EventBus } from '@wrongstack/core/kernel';
import type { JSONSchema, TokenCounter } from '@wrongstack/core/types';
import { color, writeOut } from '@wrongstack/core/utils';
import { contextOverflowHint } from '../context-overflow-diagnostic.js';
import type { TerminalRenderer } from '../renderer.js';
import { fmtTok } from '../utils.js';
import {
  parseMaxBudgetUsd,
  type SingleShotBudget,
  watchSingleShotBudget,
} from './single-shot-budget.js';
import { parseOutputFormat, startStreamJson, streamJsonInit } from './stream-json.js';
import {
  checkStructuredAnswer,
  repairPrompt,
  type StructuredCheck,
  withSchemaInstruction,
} from './structured-output.js';

interface SingleShotDispatchContext {
  /** The agent to run. */
  agent: Agent;
  /** Joined positional args forming the query string. */
  query: string;
  /** Parsed top-level CLI flags (e.g. `--output-json`, `--output-format`). */
  flags: Record<string, string | boolean>;
  /** Token counter for usage delta computation. */
  tokenCounter: TokenCounter;
  /** Terminal renderer for output. */
  renderer: TerminalRenderer;
  /** Host event bus; required for `--max-budget-usd` to see spend as it lands. */
  events?: Pick<EventBus, 'on'> | undefined;
  /**
   * The host's interrupt seam. HQ's "abort leader" and every other remote stop
   * call `abortLeader()`; a one-shot turn has no TUI to rebind it, so this run
   * binds it to its own controller for the duration of the turn.
   */
  interruptController?: { abortLeader: () => boolean } | undefined;
}

/** Exit code for a run status: 0 success, 130 aborted, 1 anything that stopped short. */
function exitCodeForStatus(status: RunResult['status']): number {
  if (status === 'failed' || status === 'max_iterations') return 1;
  if (status === 'aborted') return 130;
  return 0;
}

/**
 * Run a single `agent.run()` turn and render the result.
 *
 * Returns the exit code: 0 success, 1 failure or max-iterations, 130
 * aborted.
 */
export async function runSingleShotDispatch(ctx: SingleShotDispatchContext): Promise<number> {
  const { agent, query, flags, tokenCounter, renderer } = ctx;

  let limitUsd: number | undefined;
  let format: 'text' | 'json' | 'stream-json';
  try {
    limitUsd = parseMaxBudgetUsd(flags['max-budget-usd']);
    format = parseOutputFormat(flags['output-format']) ?? (flags['output-json'] ? 'json' : 'text');
  } catch (err) {
    renderer.writeError(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const ctrl = new AbortController();
  const onSigint = () => ctrl.abort();
  process.on('SIGINT', onSigint);
  const interrupt = ctx.interruptController;
  const previousAbortLeader = interrupt?.abortLeader;
  if (interrupt !== undefined) {
    interrupt.abortLeader = () => {
      if (ctrl.signal.aborted) return false;
      ctrl.abort();
      return true;
    };
  }
  let budget: SingleShotBudget | undefined;
  if (limitUsd !== undefined && ctx.events) {
    budget = watchSingleShotBudget({
      limitUsd,
      tokenCounter,
      events: ctx.events,
      onExceeded: () => ctrl.abort(),
    });
  }
  let stopStream: (() => void) | undefined;
  if (format === 'stream-json') {
    const tools = agent.tools?.listForProvider?.() ?? agent.tools?.list?.() ?? [];
    writeOut(
      streamJsonInit({
        sessionId: agent.ctx?.session?.id ?? null,
        provider: agent.ctx?.provider?.id ?? null,
        model: agent.ctx?.model ?? null,
        cwd: agent.ctx?.cwd ?? process.cwd(),
        tools: tools.map((tool) => tool.name),
      }),
    );
    if (ctx.events) {
      stopStream = startStreamJson({
        events: ctx.events,
        write: (line) => writeOut(line),
        includePartialMessages: flags['include-partial-messages'] === true,
      });
    }
  }
  const startedAt = Date.now();
  const before = tokenCounter.total();
  const costBefore = tokenCounter.estimateCost().total;
  // `--json-schema`, normalized to inline JSON at boot.
  const schema =
    typeof flags['json-schema'] === 'string'
      ? (JSON.parse(flags['json-schema']) as JSONSchema)
      : undefined;
  let result: RunResult;
  let structured: StructuredCheck | undefined;
  try {
    result = await agent.run(schema ? withSchemaInstruction(query, schema) : query, {
      signal: ctrl.signal,
    });
    if (schema && result.status === 'done') {
      structured = checkStructuredAnswer(result.finalText, schema);
      if (!structured.ok && !ctrl.signal.aborted) {
        const first = result;
        result = await agent.run(repairPrompt(structured.errors), { signal: ctrl.signal });
        result = { ...result, iterations: first.iterations + result.iterations };
        if (result.status === 'done') structured = checkStructuredAnswer(result.finalText, schema);
      }
    }
  } finally {
    stopStream?.();
    budget?.dispose();
    process.off('SIGINT', onSigint);
    if (interrupt !== undefined && previousAbortLeader !== undefined) {
      interrupt.abortLeader = previousAbortLeader;
    }
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
  // A run that finished but never produced schema-valid JSON is a failure for
  // the script that asked for it.
  const schemaFailed = structured !== undefined && !structured.ok;
  const exitCode = budget?.exceeded || schemaFailed ? 1 : exitCodeForStatus(result.status);
  if (format !== 'text') {
    const json = JSON.stringify({
      // In a stream the result is one event among many; name it.
      ...(format === 'stream-json' ? { type: 'result' } : {}),
      status: result.status,
      // Lets a script continue the conversation: `wstack --resume <sessionId>`.
      // Read defensively — the session is swapped in by /resume and absent in
      // some embedders.
      sessionId: agent.ctx?.session?.id ?? null,
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
      ...(limitUsd !== undefined
        ? { budget: { limitUsd, exceeded: budget?.exceeded ?? false } }
        : {}),
      ...(schema
        ? {
            structuredOutput: structured?.ok ? structured.value : null,
            schemaErrors: structured && !structured.ok ? structured.errors : null,
          }
        : {}),
    });
    writeOut(json + '\n');
    // The payload carries the status, but scripts gate on the exit code
    // (`wstack --output-json ... && deploy`). Returning 0 here let a failed or
    // aborted run pass every such gate. A budget stop surfaces as an abort;
    // report it as the failure it is, not as a user Ctrl+C (130).
    return exitCode;
  }

  const code = exitCode;
  if (budget?.exceeded) {
    renderer.writeError(
      `Stopped: spend $${budget.spent().toFixed(4)} exceeded --max-budget-usd $${limitUsd}.`,
    );
  } else if (result.status === 'failed') {
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
    renderer.writeWarning('Aborted.');
  } else if (result.status === 'max_iterations') {
    renderer.writeWarning(`Hit max iterations (${result.iterations}).`);
  } else if (structured && !structured.ok) {
    renderer.writeError(`Answer did not match --json-schema: ${structured.errors.join('; ')}`);
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
