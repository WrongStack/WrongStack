---
name: observability
description: |
  Use this skill when instrumenting logs, traces, or metrics in WrongStack,
  or when setting up observability for a new feature. Triggers: user says
  "log", "trace", "metrics", "observability", "instrument", "structured logging",
  "opentelemetry", "log level", "debug", "monitoring".
version: 1.1.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [code.inspect]
---

# Observability — WrongStack

## Overview

Instruments WrongStack code with structured logs, traces, and metrics. WrongStack uses structured logging (JSON to stdout), and pairs with `audit-log` for session analysis. The goal: every significant event is traceable from input to output.

## Rules

1. Log at the right level: `DEBUG` (dev only), `INFO` (normal flow), `WARN` (recoverable), `ERROR` (needs attention).
2. Structured logs only — JSON to stdout, not plain text to files.
3. Every significant event needs a `traceId` — correlate across tools.
4. Never log secrets, tokens, or PII — redact before logging.
5. Logs must answer: what happened, what context, what was the outcome.
6. Metrics: count errors, measure latency, track active sessions.
7. Traces: every tool call should be a span with timing.

## Patterns

### Do

```typescript
// ✅ Structured log — JSON to stdout
console.log(JSON.stringify({
  level: 'info',
  traceId: context.traceId,
  event: 'tool_executed',
  tool: 'read',
  path: 'src/index.ts',
  duration_ms: 12,
  outcome: 'success',
}));

// ✅ Error with context
console.log(JSON.stringify({
  level: 'error',
  traceId: context.traceId,
  event: 'tool_failed',
  tool: 'bash',
  command: 'pnpm test',
  error: err.message,
  duration_ms: 30000,
  outcome: 'timeout',
}));

// ✅ Trace span around a tool call
import { trace, SpanStatusCode } from '@opentelemetry/api';
const span = trace.getTracer('wrongstack').startSpan('bash');
try {
  const result = await bash(cmd);
  span.setStatus({ code: SpanStatusCode.OK });
  return result;
} catch (err) {
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR });
  throw err;
} finally {
  span.end();
}
```

### Don't

```typescript
// ❌ Plain text log
console.log('User logged in'); // not structured, hard to search

// ❌ Logging secrets
console.log(JSON.stringify({ token: bearerToken })); // redact!

// ❌ Log level confusion
console.log('DEBUG: entering function'); // INFO/WARN/ERROR only in prod

// ❌ Missing traceId
console.log(JSON.stringify({ event: 'tool_executed' })); // no correlation
```

## Log levels

| Level | When to use | Example |
|-------|-------------|---------|
| `DEBUG` | Dev-only detail | "entering parseArgs with 3 args" |
| `INFO` | Normal flow | "tool executed", "session started" |
| `WARN` | Recoverable issue | "retry attempt 2/3", "cache miss" |
| `ERROR` | Needs attention | "tool timeout", "auth failure" |

## Structured log schema

Every log should include:

```json
{
  "level": "info | warn | error",
  "traceId": "uuid",
  "event": "event_name",
  "timestamp": "ISO8601",
  "duration_ms": 12,
  "outcome": "success | failure | timeout",
  "context": { /* optional extra */ }
}
```

## Metrics to track

| Metric | Type | Why |
|--------|------|-----|
| `tool.executions` | Counter | How often each tool runs |
| `tool.duration_ms` | Histogram | Latency per tool |
| `session.iterations` | Gauge | Active iterations per session |
| `error.count` | Counter | Errors by type |
| `context.tokens` | Gauge | Context size per session |

## WrongStack-specific notes

- **Session logs**: WrongStack writes session JSONL to `sessionRoot` — see `audit-log` skill for analysis.
- **Log output**: All logs go to stdout as JSON — CI captures them, not file logs.
- **Redaction**: Use `redactKeys()` helper — never log `Authorization`, `token`, `apiKey`, `secret`.
- **Tool tracing**: Each tool wrapper should emit a structured log on start and end.

## Out of scope

- **Don't log secrets, tokens, or PII.** Redact at the boundary. A single `Authorization` header in a log line is a credential leak; redact `token`, `apiKey`, `secret`, `Authorization` keys before they reach the stream.
- **Don't use plain text logs.** JSON to stdout is the contract. `console.log('User logged in')` is unsearchable and breaks log aggregators.
- **Don't emit logs without a `traceId`.** Correlation across tools is the whole point. A log without a trace is an event with no story.
- **Don't use DEBUG level in production.** DEBUG is dev-only. Production logs are `INFO`, `WARN`, `ERROR`; DEBUG in prod is noise that hides real signals.
- **Don't log and ignore.** Every log entry should answer: what happened, what context, what was the outcome. A `console.log('done')` after a side effect is process for process's sake.
- **Don't write to file logs from app code.** CI captures stdout. File logs bypass the pipeline and become unsearchable tribal knowledge.
- **Don't skip trace spans on tool calls.** Every tool wrapper should open a span on start and end it on completion, with timing. Without spans, latency questions are unanswerable.
- **Don't conflate counters and gauges.** Counters increment (`tool.executions`); gauges track current state (`session.iterations`). Mixing them produces nonsense dashboards.
- **Don't include exception objects in span attributes.** `span.recordException(err)` is the OpenTelemetry path; serialization into a JSON log is its own discipline.

## Before returning

- [ ] All logs are JSON to stdout, never plain text or file logs
- [ ] Every entry has `level`, `traceId`, `event`, `timestamp`, `outcome`
- [ ] No secrets, tokens, `Authorization`, `apiKey`, or PII in any log line
- [ ] DEBUG level only in dev; production uses `INFO` / `WARN` / `ERROR`
- [ ] Tool wrappers emit structured start + end events with `duration_ms`
- [ ] OpenTelemetry spans opened on tool entry, closed on exit with status
- [ ] Counters vs. gauges respected; histograms used for latency
- [ ] Redaction centralized at the serialization boundary, not per call site
- [ ] Log volume and pattern sanity-checked against `audit-log` skill's metrics

## Skills in scope

- `audit-log` — for analyzing the logs this skill produces
- `bug-hunter` — for finding bugs via error trace patterns
- `security-scanner` — for ensuring no secrets leak into logs
- `node-modern` — for async tracing patterns with AbortSignal
- `output-standards` — for standardized `<nextsteps>` formatting
