/**
 * WrongForge worker — a `SubagentRunner` that hands a task to the machine's
 * WrongForge (`npm run serve`, its own agent loop) over its task API and
 * returns the final reply.
 *
 *   POST /v1/tasks                     { prompt, task_id, session_id, workdir, gateway, … }
 *   GET  /v1/tasks/:id/events?after=N  long-poll; progress is published live
 *   POST /v1/tasks/:id/cancel          when the delegating side aborts
 *   GET  /v1/tasks/:id                 final record: result | error
 *
 * Reached as `delegate({ provider: "wrongforge", model })` or
 * `delegate({ name: "wrongforge", provider: "acp" })`: it rides the
 * external-agent path (lane bypass, quota hold, live fleet progress) even
 * though it speaks HTTP, not ACP. How WrongForge reaches its model is its own
 * business; WrongStack only sees the task API.
 */
import { randomBytes } from 'node:crypto';
import type { ACPProgressEvent } from '@wrongstack/acp';
import type {
  SubagentError,
  SubagentErrorKind,
  SubagentRunContext,
  SubagentRunner,
  SubagentRunOutcome,
  TaskSpec,
} from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  cancelTask,
  chooseModel,
  followTask,
  resolveWrongForgeEndpoint,
  safeWfId,
  terminalTaskRecord,
  toProgress,
  WfAborted,
  WfHttpError,
  type WfTaskRecord,
  WRONGFORGE_AGENT_ID,
  WRONGFORGE_READ_SIDE_TOOLS,
  type WrongForgeEndpoint,
  type WrongForgeGatewaySpec,
  wfTokens,
  wrongForgeCall,
} from './wrongforge-client.js';
import {
  parseWrongForgeInfo,
  readCachedWrongForgeInfo,
  refreshWrongForgeInfoCache,
  type WrongForgeInfo,
  writeWrongForgeInfoCache,
} from './wrongforge-info.js';
import { reportWrongForgeQuota } from './wrongforge-quota.js';
import { wrongForgeRuntime } from './wrongforge-runtime.js';

export { wrongForgeConfigured } from './wrongforge-client.js';
export {
  chooseModel,
  resolveWrongForgeEndpoint,
  WRONGFORGE_AGENT_ID,
  WRONGFORGE_READ_SIDE_TOOLS,
  type WrongForgeEndpoint,
  type WrongForgeGatewaySpec,
};

export interface WrongForgeRunnerOptions {
  projectRoot: string;
  endpoint?: (() => WrongForgeEndpoint | undefined) | undefined;
  /** Started lazily on the first task; a failure runs the task without it. */
  gateway?: (() => Promise<WrongForgeGatewaySpec | undefined>) | undefined;
  publishLive?:
    | ((ctx: SubagentRunContext, task: TaskSpec, event: ACPProgressEvent) => void)
    | undefined;
  fetchImpl?: typeof fetch | undefined;
  retryDelayMs?: number | undefined;
}

/**
 * What the `delegate` description says about WrongForge at boot: whether it is
 * set up, and the models it last reported (cached; refreshed in the background
 * here and on every task, so the next boot names the current list).
 */
export function wrongForgeDelegateEntry(
  env: NodeJS.ProcessEnv = process.env,
): { agent: string; models?: { models: string[]; default?: string | undefined } } | undefined {
  const ep = resolveWrongForgeEndpoint(env);
  if (!ep) return undefined;
  refreshWrongForgeInfoCache(ep);
  const cached = readCachedWrongForgeInfo();
  return {
    agent: WRONGFORGE_AGENT_ID,
    ...(cached ? { models: { models: cached.models, default: cached.defaultModel } } : {}),
  };
}

/**
 * The models the machine's WrongForge serves, for a model picker: asked live
 * (short timeout, cache refreshed), else the last list it reported, else
 * none (no WrongForge here, or it never answered).
 */
export async function wrongForgeModels(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ models: string[]; default?: string | undefined } | undefined> {
  const ep = resolveWrongForgeEndpoint(env);
  if (!ep) return undefined;
  let info: WrongForgeInfo | undefined;
  try {
    info = parseWrongForgeInfo(
      await wrongForgeCall(ep)('GET', '/v1/info', undefined, AbortSignal.timeout(2_000)),
    );
    writeWrongForgeInfoCache(info);
  } catch {
    info = readCachedWrongForgeInfo();
  }
  return info && info.models.length > 0
    ? { models: info.models, default: info.defaultModel }
    : undefined;
}

function systemAppend(gateway: boolean, routed: boolean): string {
  return [
    'You are running as a worker for WrongStack, which delegated this task to you.',
    'Your final reply is returned to the delegating agent verbatim: end with a concise',
    'report of what you changed, what you verified, and anything left open.',
    ...(gateway
      ? [
          'Tools prefixed `wstack_` run inside WrongStack for this project (code index,',
          'board, checks, …); prefer them when they fit.',
        ]
      : []),
    ...(routed
      ? [
          'Your own write/edit/shell tools are off for this task: change files with',
          '`wstack_edit` / `wstack_write` / `wstack_patch` and run commands with',
          '`wstack_bash` (or `wstack_test` / `wstack_lint` / `wstack_typecheck`), so the',
          "work stays inside WrongStack's rules. Keep reading with your own read/grep/glob.",
        ]
      : []),
  ].join(' ');
}

export function makeWrongForgeRunner(options: WrongForgeRunnerOptions): SubagentRunner {
  const endpointOf = options.endpoint ?? (() => resolveWrongForgeEndpoint());

  return async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
    const ep = endpointOf();
    if (!ep) {
      throw subagentError(
        'provider_auth',
        'no WrongForge API key found: start WrongForge once with `npm run serve` (it saves ' +
          '~/.wrongforge/api-key) or set WRONGFORGE_API_KEY',
      );
    }
    const call = wrongForgeCall(ep, options.fetchImpl);
    void reportWrongForgeQuota({ endpoint: ep, fetchImpl: options.fetchImpl });

    let gateway: WrongForgeGatewaySpec | undefined;
    try {
      gateway = await options.gateway?.();
    } catch {
      gateway = undefined;
    }
    let info: WrongForgeInfo | undefined;
    try {
      info = parseWrongForgeInfo(await call('GET', '/v1/info', undefined, ctx.signal));
      writeWrongForgeInfoCache(info);
    } catch {
      info = undefined;
    }
    // With a gateway and a server that understands it, WrongForge's own write
    // and shell tools are switched off: the work runs through WrongStack's.
    // The gateway is then required, not optional — without it the worker
    // could not write at all.
    const routed = gateway !== undefined && (info?.features.includes('builtin_tools') ?? false);
    if (gateway && routed) gateway = { ...gateway, optional: false };

    const model = chooseModel(ctx.config.model, ctx.config.name, info);
    if (model.error) throw subagentError('unknown', model.error);
    const timeoutMs = task.timeoutMs ?? ctx.config.timeoutMs;
    const submit = {
      prompt: task.description,
      task_id: `ws-${safeWfId(task.id)}-${randomBytes(4).toString('hex')}`,
      // One conversation per worker: a follow-up task to it remembers the last.
      session_id: `ws-${safeWfId(ctx.subagentId)}`,
      workdir: ctx.config.cwd ?? options.projectRoot,
      ...(model.id ? { model: model.id } : {}),
      ...wrongForgeRuntime(
        {
          ...ctx.config.modelRuntime?.reasoning,
          ...(ctx.config.modelRuntime?.reasoning?.mode === 'off' ? { enabled: false } : {}),
          effort: ctx.config.modelRuntime?.reasoning?.effort ?? ctx.config.leaderEffort,
        },
        ctx.config.modelRuntime?.cache,
        info,
      ),
      ...(ctx.config.maxIterations !== undefined
        ? { max_steps: Math.max(1, Math.min(500, Math.trunc(ctx.config.maxIterations))) }
        : {}),
      ...(timeoutMs !== undefined
        ? { timeout_ms: Math.max(1000, Math.min(14_400_000, Math.trunc(timeoutMs))) }
        : {}),
      system_append: systemAppend(gateway !== undefined, routed),
      context: {
        wrongstack: { sessionId: ctx.sessionId, subagentId: ctx.subagentId, taskId: task.id },
      },
      ...(gateway ? { gateway } : {}),
      ...(routed ? { builtin_tools: WRONGFORGE_READ_SIDE_TOOLS } : {}),
    };

    let record: WfTaskRecord;
    try {
      record = (await call<{ task: WfTaskRecord }>('POST', '/v1/tasks', submit, ctx.signal)).task;
    } catch (err) {
      throw toSubagentError(err, ctx.signal);
    }

    const cancel = () => cancelTask(call, record.id, 'cancelled by WrongStack');
    ctx.signal.addEventListener('abort', cancel, { once: true });
    if (ctx.signal.aborted) cancel();
    const publish = (event: ACPProgressEvent) => {
      try {
        options.publishLive?.(ctx, task, event);
      } catch {
        // Live UI must never fail the task.
      }
    };
    const active = () => {
      try {
        ctx.budget.markActivity();
      } catch {
        // never fails today; guard anyway
      }
    };

    // `result.text` glues every step's text together with no separator; the
    // events keep the steps apart (a tool call ends one), so build it here.
    const stepTexts: string[] = [''];
    try {
      for await (const ev of followTask(call, record.id, ctx.signal, {
        retryDelayMs: options.retryDelayMs,
        // One WrongForge serves the whole machine: a task may wait in its queue
        // behind other projects' work, emitting nothing (heartbeats start only
        // once it runs). Waiting in line is not a stall.
        onPoll: (status) => {
          if (status === 'queued') active();
        },
      })) {
        active();
        if (ev.type === 'task.heartbeat' || ev.type === 'step.finished') {
          void reportWrongForgeQuota({ endpoint: ep, fetchImpl: options.fetchImpl });
        }
        for (const progress of toProgress(ev)) publish(progress);
        if (ev.type === 'agent.text' && typeof ev.data['text'] === 'string') {
          stepTexts[stepTexts.length - 1] += ev.data['text'];
        } else if (ev.type === 'tool.started' && stepTexts[stepTexts.length - 1]?.trim()) {
          stepTexts.push('');
        }
      }
      record = await terminalTaskRecord(call, record.id, ctx.signal, {
        retryDelayMs: options.retryDelayMs,
      });
    } catch (err) {
      throw toSubagentError(err, ctx.signal);
    } finally {
      ctx.signal.removeEventListener('abort', cancel);
      void reportWrongForgeQuota({ endpoint: ep, fetchImpl: options.fetchImpl });
    }

    const usage = record.result?.usage;
    if (usage) {
      const tokens = wfTokens(usage);
      try {
        ctx.budget.recordUsage(tokens, 0);
      } catch {
        // Accounting must never fail a finished task.
      }
      publish({ type: 'turn_usage', tokens, costUsd: 0 });
    }

    const failure = taskFailure(record, ctx.signal);
    if (failure) throw failure;
    const result = record.result;
    if (!result || (!result.text.trim() && result.tool_calls === 0)) {
      throw subagentError('empty_response', 'WrongForge finished with no text and no tool calls');
    }
    const text =
      stepTexts
        .map((t) => t.trim())
        .filter(Boolean)
        .join('\n\n') || result.text;
    return { result: text, iterations: result.steps, toolCalls: result.tool_calls };
  };
}

function taskFailure(record: WfTaskRecord, signal: AbortSignal): SubagentError | null {
  switch (record.status) {
    case 'completed':
      return null;
    case 'cancelled':
      return subagentError(
        signal.aborted ? 'aborted_by_parent' : 'unknown',
        `WrongForge task was cancelled${record.cancel_reason ? `: ${record.cancel_reason}` : ''}`,
      );
    case 'timed_out':
      return subagentError('budget_timeout', 'WrongForge task hit its timeout');
    case 'failed': {
      const code = record.error?.code ?? 'internal_error';
      const message = `WrongForge task failed (${code}): ${record.error?.message ?? 'no detail'}`;
      const kind: SubagentErrorKind =
        code === 'max_steps'
          ? 'budget_iterations'
          : code === 'max_tokens'
            ? 'budget_tokens'
            : code === 'context_overflow'
              ? 'context_overflow'
              : code === 'server_restarted' || code === 'tool_gateway_unavailable'
                ? 'bridge_failed'
                : 'unknown';
      return subagentError(kind, message, code === 'server_restarted');
    }
    default:
      return subagentError(
        'unknown',
        `WrongForge task ended in an unexpected state: ${record.status}`,
      );
  }
}

function toSubagentError(err: unknown, signal: AbortSignal): SubagentError {
  if (isSubagentError(err)) return err;
  if (signal.aborted || err instanceof WfAborted)
    return subagentError('aborted_by_parent', 'cancelled by the delegating agent');
  if (err instanceof WfHttpError) {
    if (err.status === 401 || err.status === 403)
      return subagentError('provider_auth', `WrongForge rejected the API key: ${err.message}`);
    if (err.code === 'not_signed_in') return subagentError('provider_auth', err.message);
    if (err.status === 0 || err.status >= 500)
      return subagentError('bridge_failed', err.message, true);
    return subagentError('unknown', `WrongForge refused the task (${err.code}): ${err.message}`);
  }
  return subagentError('bridge_failed', `WrongForge: ${toErrorMessage(err)}`);
}

function subagentError(kind: SubagentErrorKind, detail: string, retryable = false): SubagentError {
  return { kind, message: `${WRONGFORGE_AGENT_ID}: ${detail}`, retryable };
}

function isSubagentError(err: unknown): err is SubagentError {
  return (
    !!err &&
    typeof err === 'object' &&
    !(err instanceof Error) &&
    typeof (err as SubagentError).kind === 'string' &&
    typeof (err as SubagentError).message === 'string'
  );
}
