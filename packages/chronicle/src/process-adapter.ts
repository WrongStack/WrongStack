import { createHash } from 'node:crypto';
import type { EventBus, EventMap } from '@wrongstack/contracts/kernel/events';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
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

const MAX_PROCESS_FIELD_BYTES = 512;
const MAX_PROCESS_ARGS = 64;

function boundUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  const suffix = '…';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = Math.max(0, maxBytes - suffixBytes);
  let cut = budget;
  while (cut > 0) {
    const candidate = bytes.subarray(0, cut).toString('utf8');
    if (!candidate.includes('\uFFFD') && Buffer.byteLength(candidate, 'utf8') <= budget) {
      return `${candidate}${suffix}`;
    }
    cut--;
  }
  return suffix;
}

export function wireProcessesToChronicle(options: ChronicleProcessAdapterOptions): () => void {
  const unsubs = [
    options.events.on('process.started', (event) => {
      const cappedArgs = event.args
        .slice(0, MAX_PROCESS_ARGS)
        .map((arg) => boundUtf8(options.scrubber.scrub(arg), MAX_PROCESS_FIELD_BYTES));
      const argsTruncated = Math.max(0, event.args.length - MAX_PROCESS_ARGS);
      persist(options, event, {
        eventType: 'process.started',
        outcome: 'started',
        occurredAt: event.startedAt,
        attributes: {
          command: boundUtf8(options.scrubber.scrub(event.command), MAX_PROCESS_FIELD_BYTES),
          args: cappedArgs,
          ...(argsTruncated > 0 ? { argsTruncated } : {}),
          cwd: boundUtf8(options.scrubber.scrub(event.cwd), MAX_PROCESS_FIELD_BYTES),
          parentPid: event.parentPid,
          background: event.background,
        },
      });
    }),
    options.events.on('process.completed', (event) =>
      persist(options, event, {
        eventType: 'process.completed',
        outcome: event.exitCode === 0 ? 'success' : event.timedOut ? 'cancelled' : 'failure',
        occurredAt: event.endedAt,
        durationNs:
          Number.isFinite(event.durationMs) && event.durationMs > 0
            ? Math.round(event.durationMs * 1_000_000).toString()
            : '0',
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
