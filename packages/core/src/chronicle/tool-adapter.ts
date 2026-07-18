import { createHash } from 'node:crypto';
import type { EventBus, EventMap } from '../kernel/events.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { ChronicleContext } from './context.js';
import type { ChronicleJournal } from './journal.js';
import type { ChronicleEventInput, ChronicleResourceRef } from './types.js';

export interface ChronicleToolAdapterOptions {
  events: EventBus;
  journal: ChronicleJournal;
  context: ChronicleContext | (() => ChronicleContext);
  scrubber: SecretScrubber;
  onPersistError?: ((error: unknown, event: ChronicleEventInput) => void) | undefined;
}

/** Persist the complete tool lifecycle plus resource edges discovered in results. */
export function wireToolsToChronicle(options: ChronicleToolAdapterOptions): () => void {
  const unsubs = [
    options.events.on('tool.started', (event) => {
      const input = scrubValue(options.scrubber, event.input);
      persist(options, event, {
        eventType: 'tool.started',
        outcome: 'started',
        attributes: {
          toolName: event.name,
          input,
          inputHash: hashText(input),
        },
      });
    }),
    options.events.on('permission.boundary_denied', (event) => {
      persist(options, event, {
        eventType: 'permission.boundary_denied',
        outcome: 'denied',
        attributes: {
          toolName: event.name,
          inputHash: event.inputHash,
          effectiveDecision: event.effectiveDecision,
          boundarySource: event.boundarySource,
          reason: event.reason ? options.scrubber.scrub(event.reason) : undefined,
          riskTier: event.riskTier,
        },
      });
    }),
    options.events.on('permission.evaluated', (event) => {
      persist(options, event, {
        eventType: 'permission.evaluated',
        outcome: event.effectiveDecision === 'deny' ? 'denied' : 'success',
        attributes: {
          toolName: event.name,
          inputHash: event.inputHash,
          policyDecision: event.policyDecision,
          effectiveDecision: event.effectiveDecision,
          decisionSource: event.decisionSource,
          reason: event.reason ? options.scrubber.scrub(event.reason) : undefined,
          riskTier: event.riskTier,
          yoloEnabled: event.yoloEnabled,
          boundaryDecision: event.boundaryDecision,
          boundaryReason: event.boundaryReason
            ? options.scrubber.scrub(event.boundaryReason)
            : undefined,
          capabilityDowngraded: event.capabilityDowngraded,
        },
      });
    }),
    options.events.on('permission.confirmation_resolved', (event) => {
      persist(options, event, {
        eventType: 'permission.confirmation_resolved',
        outcome:
          event.resolution === 'approved'
            ? 'success'
            : event.resolution === 'cancelled'
              ? 'cancelled'
              : 'denied',
        attributes: {
          toolName: event.name,
          choice: event.choice,
          resolution: event.resolution,
          resolver: event.resolver,
          decisionSource: event.decisionSource,
          riskTier: event.riskTier,
          boundaryReason: event.boundaryReason
            ? options.scrubber.scrub(event.boundaryReason)
            : undefined,
        },
      });
    }),
    options.events.on('tool.executed', (event) => {
      const output = options.scrubber.scrub(event.output ?? '');
      persist(options, event, {
        eventType: 'tool.executed',
        outcome: event.ok ? 'success' : 'failure',
        durationNs: millisecondsToNanoseconds(event.durationMs),
        attributes: {
          toolName: event.name,
          ok: event.ok,
          outputPreview: output,
          outputHash: hashText(output),
          outputBytes: event.outputBytes,
          outputTokens: event.outputTokens,
          outputLines: event.outputLines,
          metadata: event.metadata,
        },
      });
      persistEvidenceEdges(options, event);
    }),
    options.events.on('tool.failed', (event) => persist(options, event, {
      eventType: 'tool.failed',
      outcome: 'failure',
      durationNs: millisecondsToNanoseconds(event.durationMs),
      attributes: {
        toolName: event.name,
        category: event.category,
        retryable: event.retryable,
        detail: event.detail,
        errorCode: event.errorCode,
        errorSubsystem: event.errorSubsystem,
        errorSeverity: event.errorSeverity,
      },
    })),
    options.events.on('tool.progress', (event) => {
      if (event.event.type !== 'file_changed') return;
      const resource = progressResource(event);
      persist(options, event, {
        eventType: 'file.mutation.observed',
        outcome: 'started',
        ...(resource ? { resource } : {}),
        attributes: {
          toolName: event.name,
          progressType: event.event.type,
          text: options.scrubber.scrub(event.event.text ?? ''),
          data: scrubValue(options.scrubber, event.event.data),
          operation: event.event.operation,
        },
      });
    }),
  ];
  return () => unsubs.forEach((unsubscribe) => { unsubscribe(); });
}

type ToolCorrelationEvent = {
  sessionId?: string | undefined;
  traceId?: string | undefined;
  agentId?: string | undefined;
  id?: string | undefined;
  name: string;
};

function persist(
  options: ChronicleToolAdapterOptions,
  event: ToolCorrelationEvent,
  fields: Pick<ChronicleEventInput, 'eventType' | 'outcome'> &
    Partial<Pick<ChronicleEventInput, 'durationNs' | 'resource' | 'attributes'>>,
): void {
  const context = typeof options.context === 'function' ? options.context() : options.context;
  const input: ChronicleEventInput = {
    ...fields,
    scope: {
      ...context.scope,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
    },
    correlation: {
      ...context.correlation,
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.id ? { toolCallId: event.id } : {}),
    },
  };
  void options.journal.append(input).catch((error) => options.onPersistError?.(error, input));
}

function persistEvidenceEdges(
  options: ChronicleToolAdapterOptions,
  event: EventMap['tool.executed'],
): void {
  const metadata = event.metadata;
  if (!metadata) return;
  for (const file of metadata.files) {
    persist(options, event, {
      eventType: 'tool.resource.observed',
      outcome: event.ok ? 'success' : 'failure',
      resource: { kind: 'file', id: resourceId('file', file), path: file },
      attributes: { relation: 'observed', toolName: event.name, evidenceStatus: metadata.status },
    });
  }
  for (const symbol of metadata.symbols) {
    persist(options, event, {
      eventType: 'tool.resource.observed',
      outcome: event.ok ? 'success' : 'failure',
      resource: { kind: 'symbol', id: resourceId('symbol', symbol) },
      attributes: { relation: 'observed', toolName: event.name, symbol },
    });
  }
  for (const command of metadata.commands) {
    persist(options, event, {
      eventType: 'tool.resource.observed',
      outcome: event.ok ? 'success' : 'failure',
      resource: { kind: 'process', id: resourceId('command', command) },
      attributes: { relation: 'invoked', toolName: event.name, command: options.scrubber.scrub(command) },
    });
  }
}

function progressResource(event: EventMap['tool.progress']): ChronicleResourceRef | undefined {
  if (event.event.type !== 'file_changed' || !event.event.path) return undefined;
  return {
    kind: 'file',
    id: resourceId('file', event.event.path),
    path: event.event.path,
    ...(event.event.line !== undefined ? { lineStart: event.event.line } : {}),
    ...(event.event.endLine !== undefined ? { lineEnd: event.event.endLine } : {}),
  };
}

function scrubValue(scrubber: SecretScrubber, value: unknown): string {
  if (value === undefined) return '';
  try {
    return scrubber.scrub(JSON.stringify(value));
  } catch {
    return scrubber.scrub(String(value));
  }
}

function resourceId(kind: string, value: string): string {
  return `${kind}_${hashText(value).slice(0, 24)}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function millisecondsToNanoseconds(durationMs: number): string {
  return Math.round(durationMs * 1_000_000).toString();
}
