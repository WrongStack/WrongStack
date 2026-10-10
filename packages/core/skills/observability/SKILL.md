---
name: observability
description: |
  Use this skill when adding or reviewing logging, metrics, or tracing in an application, or when a production problem can't be diagnosed from the signals that exist today.
  Triggers: user says "logging", "logs", "trace", "tracing", "metrics", "observability", "instrument", "OpenTelemetry", "structured logging", "log level", "correlation id", "monitoring", "alert".
version: 2.1.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [code.inspect]
trigger: "Use this skill when adding or reviewing logging, metrics, or tracing in an application, or when a production problem can't be diagnosed from the signals that exist today."
metadata:
  routing-group: data
---

# Observability

## Selection card
- Task: Instrument logs, traces, metrics and service signals.
- Start: Identify the data owner, query/schema, consistency and recovery contract.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Instrument so that the next incident can be answered from telemetry instead of
by adding logs and redeploying. Work with what the project already has — its
logger (pino, winston, structlog, slog, log/zap), metrics client, and any
OpenTelemetry setup. Adding a second logging stack is almost always wrong.

## Rules

1. Use the project's existing logger and conventions; find how a neighbouring
   module logs before adding a line.
2. Log structured events, not sentences: a stable event name plus fields
   (`logger.info({ orderId, durationMs }, 'order.charged')`), so logs can be
   filtered and aggregated.
3. Levels mean something: `error` needs a human, `warn` is degraded but
   handled, `info` is a meaningful business or lifecycle event, `debug` is
   off in production.
4. Correlate: carry a request or trace id through async boundaries
   (OpenTelemetry context or AsyncLocalStorage) and attach it to every log line.
5. Never log secrets, tokens, credentials, or personal data. Configure redaction
   once in the logger (for example pino `redact` paths), not per call site.
6. Log an error once, where it is handled, with the error object and context —
   not at every layer it passes through.
7. Metrics use bounded label values. User ids, raw URLs, and error messages as
   labels explode cardinality; use route templates and error classes.
8. Trace the I/O: spans around outbound HTTP, database, queue, and cache calls,
   with status recorded on failure. Prefer auto-instrumentation where it exists.

## What to instrument

| Signal | For | Examples |
|---|---|---|
| Logs | What happened to one request or job | `payment.failed` with order id, provider code, attempt |
| Metrics | How the system behaves in aggregate | Request rate, error rate, latency histogram per route (RED); queue depth, pool saturation (USE) |
| Traces | Where the time went across calls | Span per inbound request and per outbound dependency |

Start from the question an on-call engineer will ask — "why did checkout fail
for this customer?", "which dependency made p99 spike?" — and make sure the
answer is recorded.

## Patterns

```ts
// Redaction configured once, at the logger.
const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
});

// One structured event, with correlation and the error object.
try {
  await chargeCard(order);
  logger.info({ orderId: order.id, durationMs: Date.now() - started }, 'order.charged');
} catch (err) {
  logger.error({ err, orderId: order.id, traceId: currentTraceId() }, 'order.charge_failed');
  throw new PaymentError('charge failed', { cause: err });
}
```

```ts
// A span around an outbound dependency.
const tracer = trace.getTracer('checkout');

export async function reserveStock(sku: string, qty: number): Promise<void> {
  await tracer.startActiveSpan('inventory.reserve', async (span) => {
    span.setAttributes({ 'inventory.sku': sku, 'inventory.qty': qty });
    try {
      await inventoryClient.reserve(sku, qty);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

## Anti-patterns

- **`console.log` in a codebase with a logger** — unstructured, unleveled, unredacted.
- **Logging and rethrowing at every layer** — one failure becomes ten error lines.
- **Logging whole request or user objects** — the fastest path to leaking personal data.
- **High-cardinality metric labels** — breaks the metrics backend and the bill.
- **Alerts on causes instead of symptoms** — page on user-facing error rate and
  latency, not on CPU.

## Before returning

- [ ] Uses the project's existing logger, metrics, and tracing setup
- [ ] Structured events with stable names; levels used deliberately
- [ ] Correlation id present across async boundaries
- [ ] No secrets or personal data; redaction configured centrally
- [ ] Errors logged once, at the handling site
- [ ] Metric labels bounded; outbound I/O traced

## Trace continuity and shutdown

Verify context propagation across queues, callbacks and detached tasks rather
than assuming an id on the inbound log reaches every span. Trace links may
represent asynchronous causality better than a false parent-child relation.
Bound exporter buffers and shutdown flush; telemetry failure must not create
unbounded work or silently break the primary task. Record sampling and missing
signals when interpreting incident counts or latency distributions.

## Skills in scope

- `security-scanner` — for confirming nothing sensitive reaches logs
- `data-governance` — for retention and personal-data classification of telemetry
- `node-modern` — for async context propagation in Node.js
