import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import type { EventBus } from '../kernel/events.js';

export interface NetworkTelemetryContext {
  events: EventBus;
  sessionId: string;
  traceId?: string;
  agentId?: string;
  toolCallId?: string;
  attemptId?: string;
  initiator: 'provider' | 'tool';
  operationName: string;
}
interface RequestState extends Omit<NetworkTelemetryContext, 'events'> {
  events: EventBus;
  requestId: string;
  method: string;
  scheme: string;
  serverAddress: string;
  serverPort?: number;
  pathHash: string;
  requestBytes?: number;
  startedAt: string;
  startedNs: bigint;
}
const storage = new AsyncLocalStorage<NetworkTelemetryContext>();
const requests = new WeakMap<object, RequestState>();
let users = 0;
let unsubscribe: (() => void) | undefined;

export function runWithNetworkTelemetry<T>(context: NetworkTelemetryContext, run: () => T): T {
  return storage.run(context, run);
}

/** Installs one process-wide undici/fetch diagnostics observer, reference counted across runtimes. */
export function startNetworkTelemetryMonitor(): () => void {
  users++;
  if (!unsubscribe) unsubscribe = subscribe();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    users--;
    if (users <= 0) {
      unsubscribe?.();
      unsubscribe = undefined;
      users = 0;
    }
  };
}

function subscribe(): () => void {
  const create = channel('undici:request:create');
  const headers = channel('undici:request:headers');
  const error = channel('undici:request:error');
  const onCreate = (message: unknown) => {
    const context = storage.getStore();
    const request = objectField(message, 'request');
    if (!context || !request) return;
    const target = safeTarget(request);
    const startedAt = new Date().toISOString();
    const requestBytes = numberField(request, 'contentLength');
    const state: RequestState = {
      ...context,
      requestId: randomUUID(),
      ...target,
      ...(requestBytes !== undefined ? { requestBytes } : {}),
      startedAt,
      startedNs: process.hrtime.bigint(),
    };
    requests.set(request, state);
    context.events.emit('network.request.started', {
      ...identity(state),
      requestId: state.requestId,
      method: state.method,
      scheme: state.scheme,
      serverAddress: state.serverAddress,
      ...(state.serverPort !== undefined ? { serverPort: state.serverPort } : {}),
      pathHash: state.pathHash,
      queryKeys: queryKeys(request),
      ...(state.requestBytes !== undefined ? { requestBytes: state.requestBytes } : {}),
      startedAt,
    });
  };
  const onHeaders = (message: unknown) => {
    const request = objectField(message, 'request');
    if (!request) return;
    const state = requests.get(request);
    if (!state) return;
    requests.delete(request);
    const response = objectField(message, 'response');
    const responseBytes = contentLength(response);
    state.events.emit('network.request.completed', {
      ...identity(state),
      requestId: state.requestId,
      method: state.method,
      scheme: state.scheme,
      serverAddress: state.serverAddress,
      ...(state.serverPort !== undefined ? { serverPort: state.serverPort } : {}),
      pathHash: state.pathHash,
      statusCode: numberField(response, 'statusCode') ?? 0,
      durationMs: elapsed(state.startedNs),
      ...(state.requestBytes !== undefined ? { requestBytes: state.requestBytes } : {}),
      ...(responseBytes !== undefined ? { responseBytes } : {}),
      completedAt: new Date().toISOString(),
    });
  };
  const onError = (message: unknown) => {
    const request = objectField(message, 'request');
    if (!request) return;
    const state = requests.get(request);
    if (!state) return;
    requests.delete(request);
    const err = objectField(message, 'error');
    const errorCode = stringField(err, 'code');
    state.events.emit('network.request.failed', {
      ...identity(state),
      requestId: state.requestId,
      method: state.method,
      scheme: state.scheme,
      serverAddress: state.serverAddress,
      ...(state.serverPort !== undefined ? { serverPort: state.serverPort } : {}),
      pathHash: state.pathHash,
      durationMs: elapsed(state.startedNs),
      errorName: stringField(err, 'name') ?? 'Error',
      ...(errorCode ? { errorCode } : {}),
      failedAt: new Date().toISOString(),
    });
  };
  create.subscribe(onCreate);
  headers.subscribe(onHeaders);
  error.subscribe(onError);
  return () => {
    create.unsubscribe(onCreate);
    headers.unsubscribe(onHeaders);
    error.unsubscribe(onError);
  };
}

function identity(state: RequestState) {
  return {
    sessionId: state.sessionId,
    ...(state.traceId ? { traceId: state.traceId } : {}),
    ...(state.agentId ? { agentId: state.agentId } : {}),
    ...(state.toolCallId ? { toolCallId: state.toolCallId } : {}),
    ...(state.attemptId ? { attemptId: state.attemptId } : {}),
    initiator: state.initiator,
    operationName: state.operationName,
  };
}
function safeTarget(request: Record<string, unknown>) {
  const origin = String(request.origin ?? '');
  const path = String(request.path ?? '');
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    url = new URL('http://invalid.local/');
  }
  return {
    method: String(request.method ?? 'GET').toUpperCase(),
    scheme: url.protocol.replace(':', ''),
    serverAddress: url.hostname,
    ...(url.port ? { serverPort: Number(url.port) } : {}),
    pathHash: hash(url.pathname),
  };
}
function queryKeys(request: Record<string, unknown>): string[] {
  try {
    return [
      ...new URL(String(request.path ?? ''), String(request.origin ?? '')).searchParams.keys(),
    ]
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 50);
  } catch {
    return [];
  }
}
function contentLength(response: Record<string, unknown> | undefined): number | undefined {
  const raw = response?.headers;
  if (!Array.isArray(raw)) return undefined;
  for (let index = 0; index < raw.length - 1; index += 2)
    if (String(raw[index]).toLowerCase() === 'content-length') {
      const value = Number(String(raw[index + 1]));
      return Number.isFinite(value) ? value : undefined;
    }
  return undefined;
}
function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  return value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)[key] &&
    typeof (value as Record<string, unknown>)[key] === 'object'
    ? (value as Record<string, Record<string, unknown>>)[key]
    : undefined;
}
function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof value?.[key] === 'string' ? (value[key] as string) : undefined;
}
function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  return typeof value?.[key] === 'number' ? (value[key] as number) : undefined;
}
function elapsed(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
