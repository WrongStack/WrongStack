---
name: audit-log
description: |
  Use this skill when analyzing WrongStack session logs, event streams, or
  system traces to surface patterns, anomalies, or operational insights.
  Triggers: user says "audit", "session analysis", "log analysis", "usage patterns".
version: 1.2.0
---

# Audit Log Agent — WrongStack

Analyzes session logs, event streams, and system traces to surface patterns, anomalies, and actionable insights.

## Overview

Parses WrongStack session JSONL files to extract tool usage patterns, error distributions, cost trends, and context anomalies. Produces a structured report with prioritized findings.

## Rules

1. Always parse from the source JSONL — never summarize what you didn't read.
2. Analyze one session at a time, or aggregate with clear labeling per session.
3. Cite specific data in reports: iteration numbers, tool names, error messages.
4. Flag repeated failures (same tool, 5+ times) as a real issue, not noise.
5. Report cost trends in context of iteration count — a spike means context growth.

## Patterns

### Do

```json
// ✅ Good — parse tool call counts from session JSONL
{
  "iterations": 23,
  "toolCalls": [
    { "tool": "read", "count": 142, "failures": 3 },
    { "tool": "bash", "count": 89, "failures": 12 }
  ],
  "costPerIteration": [0.04, 0.04, 0.11, 0.18]
}
```

```typescript
// ✅ Extract error distribution
const errorsByType = events
  .filter(e => e.type === 'error')
  .reduce((acc, e) => {
    acc[e.error.type] = (acc[e.error.type] || 0) + 1;
    return acc;
  }, {});
```

### Don't

```typescript
// ❌ Bad — report without citing data
"bash had some failures" // no count, no iteration, no error type

// ❌ Bad — mix sessions without labeling
// Analyzed 3 sessions together with no per-session breakdown
```

## Workflow

```
1. Collect:  Read session logs from path or sessionRoot
2. Parse:    Extract events: tool calls, iterations, errors, usage
3. Analyze:  Group by category, detect anomalies
4. Report:  Structured markdown summary
```

## What to look for

### Tool usage patterns
- **Over-used tools**: 100+ calls to the same tool = possibly a loop
- **Consistent failures**: same tool failing 5x+ = bug or misconfiguration
- **Unusual sequences**: 50 writes in a row with no reads = wrong approach
- **Tool entropy**: too many different tools in one iteration = unfocused task

### Error patterns
- **Same error repeating**: `ToolExecutionError` 47x across iterations = systemic issue
- **Error clustering**: all errors in `bash` tool = command timeout pattern
- **Error rate by type**: which error type is most common?
- **Error distribution**: are errors clustered in specific packages or tools?

### Cost patterns
- **Token growth**: tokens/iteration trending up = context bloat
- **Provider cost**: which model is most expensive per call?
- **Cost spikes**: sudden 3x increase = large file reads or excessive tool calls
- **Iteration cost variance**: avg $0.04/iter → $0.11/iter = context growing

### Context management
- **High tool count per iteration**: >50 tool calls = possible loop or unfocused task
- **Compaction events**: context compaction triggered 3x in one session = too much context
- **Session restart**: same session restarting multiple times = crash loop
- **Long iterations**: single iteration >5min = stuck or waiting on something

## Session file structure

WrongStack session logs are JSONL files. Each line is a JSON event. Key event types:

```
{"type": "iteration_start", "iteration": 1, "timestamp": "..."}
{"type": "tool_call", "tool": "read", "input": {"path": "src/index.ts"}, "duration_ms": 12}
{"type": "tool_result", "tool": "read", "output_lines": 45}
{"type": "error", "error": {"type": "ToolExecutionError", "message": "...", "tool": "bash"}}
{"type": "compaction", "reason": "context_near_limit", "tokens_removed": 1200}
{"type": "cost", "input_tokens": 3400, "output_tokens": 890, "cost_usd": 0.11}
{"type": "iteration_end", "iteration": 1, "stop_reason": "end_turn"}
```

When reading a session file:
1. `grep` for event types you need (e.g., `grep '"type": "error"' session.jsonl`)
2. `read` the full file for detailed analysis
3. Track iteration boundaries via `iteration_start` / `iteration_end` events
4. Sum `cost_usd` per iteration for cost trend analysis

## Input

```json
{
  "task": "analyze | report | trends",
  "sessionPath": "<path to session JSONL>",
  "focus": "errors | tools | usage | all"
}
```

## Output format

```
## Audit Report — <date>

### Summary
- Total iterations: N
- Total tool calls: N
- Error rate: X%
- Cost: $X.XX

### Top Errors (by count)
1. `ToolExecutionError` — 47x — concentrated in `bash` tool, command timeout
2. `PermissionDenied` — 12x — `exec` tool, no trust file entry

### Tool Usage
| Tool | Calls | Failures | Avg Duration |
|------|-------|----------|--------------|
| read | 142   | 3        | 45ms |
| bash | 89    | 12       | 2300ms |

### Anomalies
- High bash failure rate (13.5%) — likely command timeout
- 3 iterations with >50 tool calls — possible loop, review iteration 14

### Cost Trend
- Iteration 1-10: avg $0.04/iteration
- Iteration 11-20: avg $0.11/iteration (context growth)

<nextsteps>
1. Run the session tests and the type checker
</nextsteps>

Investigate iterations 14–20 in the session log for the bash command timeout pattern. Review iteration 14's tool call count for loop behavior.
```

## Anti-patterns

- **Don't summarize what you didn't parse** — be precise, cite the data
- **Don't mix sessions** — analyze one at a time or aggregate clearly
- **Don't skip error context** — the raw error message is the source of truth
- **Don't ignore cost trends** — growing costs indicate context bloat
- **Don't ignore repeated failures** — same tool failing 5x = real issue

## Skills in scope

- `bug-hunter` — for turning audit findings into concrete bugs to fix
- `refactor-planner` — for addressing systemic issues found in logs
- `security-scanner` — for security-adjacent findings (leaked keys, injection patterns in logs)
- `output-standards` — for standardized `<nextsteps>` formatting
