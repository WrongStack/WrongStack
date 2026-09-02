/**
 * Lightweight OTel adapter. Doesn't pull in `@opentelemetry/api` directly —
 * the user passes their already-initialized OTel Tracer through, and this
 * wrapper translates our minimal Span surface onto theirs.
 *
 * Usage:
 *   import { trace } from '@opentelemetry/api';
 *   const tracer = trace.getTracer('wrongstack', '1.0');
 *   const wrappedTracer = new OTelTracer(tracer);
 *   // pass `wrappedTracer` as Agent.tracer / ToolExecutor.tracer.
 *
 * The shape of the upstream Tracer is intentionally typed loosely so we
 * don't need a build-time dependency. Anything OTel-compatible works,
 * including OpenInference, Tempo, etc.
 */
import type { Span as WStackSpan, Tracer as WStackTracer } from '../types/observability.js';

interface OTelLikeSpan {
  setAttribute(key: string, value: string | number | boolean): unknown;
  recordException(err: {
    message: string;
    stack?: string | undefined;
    name?: string | undefined;
  }): unknown;
  setStatus?(status: { code: number; message?: string | undefined }): unknown;
  end(): unknown;
}

interface OTelLikeTracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): OTelLikeSpan;
}

// OTel SpanStatusCode.ERROR = 2 (per the spec). Hard-coded here so we don't
// depend on the @opentelemetry/api enum.
const OTEL_STATUS_ERROR = 2;

export class OTelTracer implements WStackTracer {
  constructor(private readonly upstream: OTelLikeTracer) {}

  startSpan(name: string, attrs?: Record<string, string | number | boolean>): WStackSpan {
    const otelSpan = this.upstream.startSpan(name, attrs ? { attributes: attrs } : undefined);
    return new OTelSpan(otelSpan);
  }
}

class OTelSpan implements WStackSpan {
  constructor(private readonly span: OTelLikeSpan) {}

  setAttribute(key: string, value: string | number | boolean): void {
    this.span.setAttribute(key, value);
  }

  recordError(err: Error): void {
    this.span.recordException(err);
    this.span.setStatus?.({ code: OTEL_STATUS_ERROR, message: err.message });
  }

  end(): void {
    this.span.end();
  }
}
