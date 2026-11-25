import { randomUUID } from 'node:crypto';
import type { ChronicleCorrelation, ChronicleScope } from './types.js';

export interface ChronicleContext {
  scope: ChronicleScope;
  correlation: ChronicleCorrelation;
}

/** Create a root correlation context for a session, run, or background worker. */
export function createChronicleContext(scope: ChronicleScope, traceId?: string): ChronicleContext {
  const safeTraceId = typeof traceId === 'string' && traceId.trim() ? traceId.trim() : randomUUID();
  return {
    scope: { ...scope },
    correlation: { traceId: safeTraceId, spanId: randomUUID() },
  };
}

/** Derive a child span without losing project/session/task attribution. */
export function childChronicleContext(
  parent: ChronicleContext,
  overrides: {
    scope?: Partial<ChronicleScope> | undefined;
    correlation?: Partial<Omit<ChronicleCorrelation, 'traceId'>> | undefined;
  } = {},
): ChronicleContext {
  return {
    scope: { ...parent.scope, ...overrides.scope },
    correlation: {
      ...parent.correlation,
      ...overrides.correlation,
      traceId: parent.correlation.traceId,
      parentSpanId: parent.correlation.spanId,
      spanId: overrides.correlation?.spanId ?? randomUUID(),
    },
  };
}
