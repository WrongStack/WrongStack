# Observability (Compact)

<!-- source-version: 2.1.2 -->

## Selection card
- Task: Instrument logs, traces, metrics and service signals. / TR: Log, trace, metrik ve servis sinyallerini ekle.
- Start: Name the question the signals must answer and inventory the logging, metrics and tracing stack already in place.
- Finish: The new signal appears in a real run and answers the question (a log query, metric or trace shown), without secrets or unbounded labels.

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

## Detailed workflow

Load the full observability skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Uses the project's existing logger, metrics, and tracing setup
- [ ] Structured events with stable names; levels used deliberately
- [ ] Correlation id present across async boundaries
- [ ] No secrets or personal data; redaction configured centrally
- [ ] Errors logged once, at the handling site
- [ ] Metric labels bounded; outbound I/O traced
