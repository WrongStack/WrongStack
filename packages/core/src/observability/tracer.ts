import type { Span, Tracer } from '@wrongstack/contracts/types/observability';

/**
 * Default tracer is a noop — zero overhead when observability is not wired up.
 * Replace at runtime with an OpenTelemetry-backed Tracer to enable real spans.
 */
export class NoopTracer implements Tracer {
  startSpan(): Span {
    return NOOP_SPAN;
  }
}

const NOOP_SPAN: Span = {
  setAttribute() {},
  recordError() {},
  end() {},
};
