import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { EventBus, EventMap } from '@wrongstack/contracts/kernel/events';
import { redactCommandArgs } from './redact-command.js';

export interface ProcessTelemetryContext {
  events: EventBus;
  sessionId: string;
  traceId?: string | undefined;
  agentId?: string | undefined;
  toolCallId: string;
  toolName: string;
}

const storage = new AsyncLocalStorage<ProcessTelemetryContext>();

export function runWithProcessTelemetry<T>(context: ProcessTelemetryContext, run: () => T): T {
  return storage.run(context, run);
}

export function emitProcessStarted(
  event: Omit<EventMap['process.started'], keyof ProcessTelemetryContext>,
): void {
  // SECURITY: redact command + args centrally so every consumer (bash, exec,
  // spawnStream) is safe by default. process.* events flow to observability
  // sinks (OTLP/Prometheus exporters live in this package), and secret-bearing
  // CLI flags (--token=…, -pSECRET, curl -H "Authorization: Bearer …") must
  // never reach them. Joining command+args then redacting (rather than
  // redacting each in isolation) handles the common case where the flag name
  // and its value land in separate argv tokens.
  const { command, args } = redactCommandArgs(event.command, event.args);
  emit('process.started', { ...event, command, args });
}

export function emitProcessOutput(input: {
  pid?: number | undefined;
  stream: 'stdout' | 'stderr';
  chunk: string | Buffer;
}): void {
  const bytes = Buffer.byteLength(input.chunk);
  emit('process.output', {
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    stream: input.stream,
    bytes,
    chunkHash: createHash('sha256').update(input.chunk).digest('hex'),
    at: new Date().toISOString(),
  });
}

export function emitProcessCompleted(
  event: Omit<EventMap['process.completed'], keyof ProcessTelemetryContext>,
): void {
  emit('process.completed', event);
}

function emit<E extends 'process.started' | 'process.output' | 'process.completed'>(
  name: E,
  event: Omit<EventMap[E], keyof ProcessTelemetryContext>,
): void {
  const context = storage.getStore();
  if (!context) return;
  const { events, ...identity } = context;
  events.emit(name, { ...identity, ...event } as unknown as EventMap[E]);
}
