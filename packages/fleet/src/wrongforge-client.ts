/**
 * The machine's WrongForge (`npm run serve`), as WrongStack talks to it: where
 * it is, its task API, and its task events as the progress shapes the fleet
 * and the leader seam already understand. Shared by the worker runner
 * (wrongforge-runner.ts) and the leader provider (wrongforge-leader/).
 *
 * One WrongForge serves the whole machine; every WrongStack session and
 * project sends its tasks to it, each with its own workdir and gateway.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ACPProgressEvent } from '@wrongstack/acp';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WrongForgeInfo } from './wrongforge-info.js';

export const WRONGFORGE_AGENT_ID = 'wrongforge';
const DEFAULT_URL = 'http://127.0.0.1:8787';
const MIN_KEY_LENGTH = 16;
const POLL_WAIT_MS = 25_000;
const POLL_LIMIT = 1000;
/** Consecutive failed polls before the task is given up as unreachable. */
const MAX_POLL_FAILURES = 6;

/**
 * WrongForge's own tools a task keeps when WrongStack's gateway carries the
 * rest: reading, its todo list and progress reports. Writes and commands then
 * go through `wstack_*`, i.e. through WrongStack's rules.
 */
export const WRONGFORGE_READ_SIDE_TOOLS = [
  'read',
  'ls',
  'glob',
  'grep',
  'web_fetch',
  'todo_read',
  'todo_write',
  'report_progress',
];

export interface WrongForgeEndpoint {
  url: string;
  apiKey: string;
}

/** The `gateway` field of a WrongForge task: WrongStack tools it may call back. */
export interface WrongForgeGatewaySpec {
  url: string;
  token: string;
  list_path: string;
  call_path: string;
  name_prefix?: string | undefined;
  deny?: string[] | undefined;
  optional?: boolean | undefined;
}

export interface WfTaskRecord {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  session_id?: string;
  result?: {
    text: string;
    finish_reason?: string;
    steps: number;
    tool_calls: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    };
    context_tokens?: number;
    context_window?: number;
  };
  error?: { code: string; message: string };
  cancel_reason?: string;
}

export interface WfEvent {
  seq: number;
  /** ISO time WrongForge emitted the event. */
  ts?: string | undefined;
  type: string;
  data: Record<string, unknown>;
}

export class WfHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The delegating side gave up on the task (its signal fired). */
export class WfAborted extends Error {
  constructor() {
    super('cancelled by the delegating agent');
  }
}

/**
 * Where a local WrongForge serves and the key it accepts: `WRONGFORGE_URL`
 * (default 127.0.0.1:8787) and `WRONGFORGE_API_KEY`, else the key WrongForge
 * saved on first start (`$WRONGFORGE_HOME|~/.wrongforge/api-key`).
 */
export function resolveWrongForgeEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): WrongForgeEndpoint | undefined {
  const url = (env['WRONGFORGE_URL']?.trim() || DEFAULT_URL).replace(/\/+$/, '');
  let apiKey = env['WRONGFORGE_API_KEY']?.trim() || env['AGENT_API_KEY']?.trim();
  if (!apiKey) {
    const home = env['WRONGFORGE_HOME']?.trim() || path.join(homedir(), '.wrongforge');
    try {
      apiKey = readFileSync(path.join(home, 'api-key'), 'utf8')
        .replace(/^\uFEFF/, '')
        .trim();
    } catch {
      return undefined;
    }
  }
  return apiKey && apiKey.length >= MIN_KEY_LENGTH ? { url, apiKey } : undefined;
}

/** True when this machine has a WrongForge set up (a key to reach it with). */
export function wrongForgeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveWrongForgeEndpoint(env) !== undefined;
}

export const safeWfId = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);

export type WfCall = <T>(
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;

/** One JSON call to WrongForge; failures as WfHttpError (status 0 = unreachable). */
export function wrongForgeCall(ep: WrongForgeEndpoint, doFetch: typeof fetch = fetch): WfCall {
  return async <T>(
    method: 'GET' | 'POST',
    route: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(`${ep.url}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${ep.apiKey}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw new WfAborted();
      throw new WfHttpError(
        0,
        'unreachable',
        `WrongForge is not reachable at ${ep.url} (${toErrorMessage(err)}); is \`npm run serve\` running?`,
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new WfHttpError(
        res.status,
        e?.code ?? `http_${res.status}`,
        e?.message ?? text.slice(0, 300),
      );
    }
    return parsed as T;
  };
}

/**
 * A task's events in order, until it ends. Long-polls; a dropped connection or
 * a WrongForge restart is retried (the task survives it). `onPoll` sees every
 * answered poll's status: a task waiting in the shared queue emits nothing.
 * Throws WfAborted when `signal` fires.
 */
export async function* followTask(
  call: WfCall,
  taskId: string,
  signal: AbortSignal,
  opts: { retryDelayMs?: number | undefined; onPoll?: ((status: string) => void) | undefined } = {},
): AsyncGenerator<WfEvent> {
  let after = 0;
  let failures = 0;
  for (;;) {
    if (signal.aborted) throw new WfAborted();
    let page: { status?: string; events: WfEvent[]; terminal: boolean; next_after: number };
    try {
      page = await call(
        'GET',
        `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${after}&limit=${POLL_LIMIT}&wait_ms=${POLL_WAIT_MS}`,
        undefined,
        signal,
      );
      failures = 0;
    } catch (err) {
      if (signal.aborted || err instanceof WfAborted) throw new WfAborted();
      if (++failures >= MAX_POLL_FAILURES) throw err;
      await sleep(opts.retryDelayMs ?? 2_000, signal);
      continue;
    }
    for (const ev of page.events) yield ev;
    if (page.status) opts.onPoll?.(page.status);
    after = page.next_after;
    if (page.terminal && page.events.length < POLL_LIMIT) return;
  }
}

/**
 * The terminal task record, with the same dropped-connection tolerance as
 * `followTask`: the task is already finished, so one transient failure of
 * this fetch must not turn completed work into a failed delegation (the
 * caller would re-run it). Throws WfAborted when `signal` fires.
 */
export async function terminalTaskRecord(
  call: WfCall,
  taskId: string,
  signal: AbortSignal,
  opts: { retryDelayMs?: number | undefined } = {},
): Promise<WfTaskRecord> {
  let failures = 0;
  for (;;) {
    try {
      return (
        await call<{ task: WfTaskRecord }>(
          'GET',
          `/v1/tasks/${encodeURIComponent(taskId)}`,
          undefined,
          signal,
        )
      ).task;
    } catch (err) {
      if (signal.aborted || err instanceof WfAborted) throw new WfAborted();
      if (++failures >= MAX_POLL_FAILURES) throw err;
      await sleep(opts.retryDelayMs ?? 2_000, signal);
    }
  }
}

/** Ask WrongForge to stop a task; best effort. */
export async function cancelTask(call: WfCall, taskId: string, reason: string): Promise<void> {
  await call(
    'POST',
    `/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
    { reason },
    AbortSignal.timeout(2_000),
  ).catch(() => undefined);
}

/**
 * The model to ask WrongForge for. Its own `/v1/info` list is the authority:
 * a model it does not serve fails fast, naming the ones it does, instead of
 * failing inside WrongForge. Without the list (older server, info failed) only
 * an id that looks like a Claude model is forwarded. An external-agent spawn
 * may carry the agent's own name as its model; that is not a choice.
 */
export function chooseModel(
  requested: string | undefined,
  agentName: string | undefined,
  info: WrongForgeInfo | undefined,
): { id?: string; error?: string } {
  const id = requested?.trim();
  if (!id || id === WRONGFORGE_AGENT_ID || id === agentName) return {};
  if (info && info.models.length > 0) {
    if (info.models.includes(id)) return { id };
    return {
      error: `WrongForge does not serve model "${id}"; it serves ${info.models.join(', ')}${info.defaultModel ? ` (default ${info.defaultModel})` : ''}`,
    };
  }
  return /^claude-[a-z0-9.-]+$/i.test(id) ? { id } : {};
}

/** A WrongForge task event as the progress events the fleet and leader seams consume. */
export function toProgress(ev: WfEvent): ACPProgressEvent[] {
  const d = ev.data;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const rec = (v: unknown): Record<string, unknown> | undefined =>
    v === undefined
      ? undefined
      : v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : { value: v };
  switch (ev.type) {
    case 'task.started':
      return [
        {
          type: 'thought',
          text: `[started] WrongForge · ${str(d['model']) || 'default model'} · ${str(d['workdir'])}\n`,
        },
      ];
    case 'task.queued':
      // null = starts right away; otherwise capacity | session | workdir.
      return str(d['waiting_for'])
        ? [
            {
              type: 'thought',
              text: `[queued] WrongForge is busy (waiting for ${str(d['waiting_for'])})\n`,
            },
          ]
        : [];
    case 'agent.text':
      return str(d['text']) ? [{ type: 'message', text: str(d['text']) }] : [];
    case 'agent.report':
      return str(d['message'])
        ? [{ type: 'thought', text: `[progress] ${str(d['message'])}\n` }]
        : [];
    case 'tool.started':
      return [
        {
          type: 'tool_call',
          toolCall: {
            toolCallId: str(d['tool_call_id']),
            title: str(d['name']),
            status: 'in_progress',
            rawInput: rec(d['input']),
          },
        },
      ];
    case 'tool.finished':
    case 'tool.failed': {
      const failed = ev.type === 'tool.failed' || d['ok'] === false;
      return [
        {
          type: 'tool_call_update',
          toolCall: {
            toolCallId: str(d['tool_call_id']),
            title: str(d['name']),
            status: failed ? 'failed' : 'completed',
            rawOutput: ev.type === 'tool.failed' ? { error: d['error'] } : rec(d['output']),
          },
        },
      ];
    }
    case 'agent.todos': {
      const todos = Array.isArray(d['todos']) ? (d['todos'] as Array<Record<string, unknown>>) : [];
      return [
        {
          type: 'plan',
          entries: todos.map((t) => ({
            content: str(t['content']),
            priority: 'medium' as const,
            status:
              t['status'] === 'completed' || t['status'] === 'in_progress'
                ? (t['status'] as 'completed' | 'in_progress')
                : ('pending' as const),
          })),
        },
      ];
    }
    default:
      return [];
  }
}

/** WrongForge's token split: `input_tokens` is the uncached part (measured live). */
export function wfTokens(usage: NonNullable<WfTaskRecord['result']>['usage']): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_tokens ?? 0,
    cacheWrite: usage?.cache_write_tokens ?? 0,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
