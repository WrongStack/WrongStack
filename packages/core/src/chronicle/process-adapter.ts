import { createHash } from 'node:crypto';
import type { EventBus, EventMap } from '../kernel/events.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput } from './types.js';

export interface ChronicleProcessAdapterOptions {
  events: EventBus;
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  scrubber: SecretScrubber;
  onPersistError?: ((error: unknown, event: ChronicleEventInput) => void) | undefined;
}

export function wireProcessesToChronicle(options: ChronicleProcessAdapterOptions): () => void {
  const unsubs = [
    options.events.on('process.started', (event) =>
      persist(options, event, {
        eventType: 'process.started',
        outcome: 'started',
        occurredAt: event.startedAt,
        attributes: {
          command: options.scrubber.scrub(event.command),
          args: event.args.map((arg) => options.scrubber.scrub(arg)),
          cwd: event.cwd,
          parentPid: event.parentPid,
          background: event.background,
        },
      }),
    ),
    options.events.on('process.completed', (event) =>
      persist(options, event, {
        eventType: 'process.completed',
        outcome: event.exitCode === 0 ? 'success' : event.timedOut ? 'cancelled' : 'failure',
        occurredAt: event.endedAt,
        durationNs: Math.round(event.durationMs * 1_000_000).toString(),
        attributes: {
          exitCode: event.exitCode,
          signal: event.signal,
          stdoutBytes: event.stdoutBytes,
          stderrBytes: event.stderrBytes,
          timedOut: event.timedOut,
        },
      }),
    ),
  ];
  return () =>
    unsubs.forEach((unsubscribe) => {
      unsubscribe();
    });
}

type ProcessEvent = EventMap['process.started'] | EventMap['process.completed'];

function persist(
  options: ChronicleProcessAdapterOptions,
  event: ProcessEvent,
  fields: Pick<ChronicleEventInput, 'eventType' | 'outcome' | 'occurredAt'> &
    Partial<Pick<ChronicleEventInput, 'durationNs' | 'attributes'>>,
): void {
  const context = typeof options.context === 'function' ? options.context() : options.context;
  const processKey = `${event.sessionId}\0${event.pid ?? 'unknown'}\0${event.toolCallId}`;
  const input: ChronicleEventInput = {
    ...fields,
    scope: {
      ...context.scope,
      sessionId: event.sessionId,
      ...(event.agentId ? { agentId: event.agentId } : {}),
    },
    correlation: {
      ...context.correlation,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      toolCallId: event.toolCallId,
    },
    runtime: {
      ...(event.pid !== undefined ? { processId: event.pid } : {}),
      ...('parentPid' in event ? { parentProcessId: event.parentPid } : {}),
    },
    resource: {
      kind: 'process',
      id: `process_${createHash('sha256').update(processKey).digest('hex').slice(0, 24)}`,
    },
  };
  void options.journal.append(input).catch((error) => options.onPersistError?.(error, input));
}
