import type { EventBus, EventMap } from '../kernel/events.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleEventSink } from './sink.js';
import type { ChronicleEventInput } from './types.js';

export interface ChronicleProviderAdapterOptions {
  events: EventBus;
  journal: ChronicleEventSink;
  context: ChronicleContext | (() => ChronicleContext);
  onPersistError?: ((error: unknown, event: ChronicleEventInput) => void) | undefined;
}

/** Persist provider attempt facts without coupling the provider runner to storage. */
export function wireProviderAttemptsToChronicle(
  options: ChronicleProviderAdapterOptions,
): () => void {
  // The tool roster rarely changes between attempts, yet its full name list
  // (100+ entries, several KB) used to be re-embedded in every
  // provider.attempt.started manifest. Persist the names once per tools
  // manifestHash; later attempts keep the hash as a back-reference.
  const seenToolManifests = new Set<string>();
  const unsubs = [
    options.events.on('provider.attempt.started', (event) =>
      persist(
        options,
        event,
        {
          eventType: 'provider.attempt.started',
          outcome: 'started',
          occurredAt: event.startedAt,
        },
        seenToolManifests,
      ),
    ),
    options.events.on('provider.attempt.completed', (event) =>
      persist(options, event, {
        eventType: 'provider.attempt.completed',
        outcome: 'success',
        occurredAt: event.endedAt,
        durationNs: millisecondsToNanoseconds(event.durationMs),
      }),
    ),
    options.events.on('provider.attempt.failed', (event) =>
      persist(options, event, {
        eventType: 'provider.attempt.failed',
        outcome: 'failure',
        occurredAt: event.endedAt,
        durationNs: millisecondsToNanoseconds(event.durationMs),
      }),
    ),
  ];
  return () =>
    unsubs.forEach((unsubscribe) => {
      unsubscribe();
    });
}

type ProviderAttemptEvent =
  | EventMap['provider.attempt.started']
  | EventMap['provider.attempt.completed']
  | EventMap['provider.attempt.failed'];

function persist(
  options: ChronicleProviderAdapterOptions,
  event: ProviderAttemptEvent,
  base: Pick<ChronicleEventInput, 'eventType' | 'outcome' | 'occurredAt' | 'durationNs'>,
  seenToolManifests?: Set<string>,
): void {
  const context = typeof options.context === 'function' ? options.context() : options.context;
  const input: ChronicleEventInput = {
    ...base,
    scope: {
      ...context.scope,
      sessionId: event.sessionId,
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(event.boardId ? { kanbanBoardId: event.boardId } : {}),
    },
    correlation: {
      ...context.correlation,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      logicalRequestId: event.logicalRequestId,
      ...(event.promptManifestId ? { promptManifestId: event.promptManifestId } : {}),
      attemptId: event.attemptId,
    },
    runtime: { providerId: event.providerId, modelId: event.model },
    attributes: providerAttributes(event, seenToolManifests),
  };
  void options.journal.append(input).catch((error) => options.onPersistError?.(error, input));
}

function providerAttributes(
  event: ProviderAttemptEvent,
  seenToolManifests?: Set<string>,
): Record<string, unknown> {
  const {
    sessionId: _sessionId,
    traceId: _traceId,
    agentId: _agentId,
    providerId: _providerId,
    model: _model,
    logicalRequestId: _logicalRequestId,
    promptManifestId: _promptManifestId,
    attemptId: _attemptId,
    ...rest
  } = event;
  const attributes = rest as Record<string, unknown>;
  if (seenToolManifests && isManifest(attributes['promptManifest'])) {
    // Never mutate the bus payload — other subscribers observe the same object.
    attributes['promptManifest'] = compactManifest(attributes['promptManifest'], seenToolManifests);
  }
  return attributes;
}

/** Per-message summaries beyond this count carry no marginal evidence — the
 *  manifestId already commits to the full prompt content. */
const MANIFEST_MESSAGE_TAIL = 8;
const SEEN_TOOL_MANIFEST_CAP = 256;

function isManifest(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function compactManifest(
  manifest: Record<string, unknown>,
  seenToolManifests: Set<string>,
): Record<string, unknown> {
  const compacted = { ...manifest };
  const tools = compacted['tools'];
  if (isManifest(tools) && typeof tools['manifestHash'] === 'string') {
    const manifestHash = tools['manifestHash'];
    if (seenToolManifests.has(manifestHash)) {
      const { names: _names, ...toolsWithoutNames } = tools;
      compacted['tools'] = { ...toolsWithoutNames, namesRef: manifestHash };
    } else {
      if (seenToolManifests.size >= SEEN_TOOL_MANIFEST_CAP) seenToolManifests.clear();
      seenToolManifests.add(manifestHash);
    }
  }
  const messages = compacted['messages'];
  if (Array.isArray(messages) && messages.length > MANIFEST_MESSAGE_TAIL) {
    compacted['messages'] = messages.slice(-MANIFEST_MESSAGE_TAIL);
    compacted['messagesTruncated'] = messages.length - MANIFEST_MESSAGE_TAIL;
  }
  return compacted;
}

function millisecondsToNanoseconds(durationMs: number): string {
  return Math.round(durationMs * 1_000_000).toString();
}
