---
name: audit-log
description: |
  Use this skill when analyzing WrongStack session journals to explain what happened in a session — tool usage and failures, token spend and cache efficiency, compactions, delegations, loops, and errors.
  Triggers: user says "audit", "session analysis", "analyze the session", "log analysis", "why did this session cost so much", "token usage", "what went wrong in that run", "usage patterns".
version: 2.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [execution.shell, code.inspect]
trigger: "Use this skill when analyzing WrongStack session journals to explain what happened in a session \u2014 tool usage and failures, token spend and cache efficiency, compactions, delegations, loops, and errors."
metadata:
  routing-group: workflow
---

# Audit Log — WrongStack session journals

## Selection card
- Task: Inspect session journal evidence and provenance.
- Start: Identify the requested artifact, repository owner and acceptance criteria.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Every WrongStack session is journaled as JSONL: one event per line, in order.
The journal is the ground truth for what the agent did, what it cost, and where
it went wrong. Analyze it from the file, report numbers that trace back to
specific events, and never summarize a session you did not parse.

## Rules

1. Parse the journal; don't infer from memory, the UI, or the session title.
2. Scope every figure: one session, or an aggregate labelled per session.
3. Cite evidence — event type, timestamp, tool name, tool call id — for every
   finding.
4. Stream the file line by line; journals can be hundreds of megabytes. Skip
   and count malformed lines instead of aborting.
5. Treat content as sensitive. `user_input`, tool inputs, and tool results can
   hold secrets and personal data; quote only what a finding needs, redacted.
6. The analysis is read-only. Never edit, truncate, or rewrite a journal.

## Where journals live

- Project sessions: `~/.wrongstack/projects/<project>/sessions/` (one JSONL per
  session).
- Subagent transcripts are separate files; an `agent_session_linked` event in
  the parent journal carries the child's `agentSessionId` and `transcriptPath`.

## Event reference

| `type` | Key fields | Use it for |
|---|---|---|
| `session_start` / `session_resumed` | `id`, `model`, `provider` | Session identity and starting model |
| `user_input` | `content` | Turn boundaries; what was asked |
| `llm_request` | `model`, `messageCount`, `estimatedInputTokens`, `toolCount` | Context growth per request |
| `llm_response` | `stopReason`, `usage`, `model`, `provider` | Tokens actually billed; stop reasons |
| tool_use | `id`, `name`, `input` | Tool call counts and repeated calls |
| `tool_result` | `id`, `isError`, `content` | Failures — join to tool_use on `id` |
| `compaction` | `before`, `after`, `level`, `reductions` | Context pressure |
| `error` | `message`, `phase` | Runtime failures |
| `mode_changed` | `from`, `to` | Behaviour shifts mid-session |
| `delegate_started` / `delegate_completed` | `target`, `ok`, `status`, `durationMs`, `toolCalls`, `costUsd` | Delegated work and its outcome |
| `agent_spawned` / `agent_stopped` / `agent_error` | `agentId`, `role`, `reason` | Subagent lifecycle |
| `session_end` | `usage`, `pendingToolUses` | Final usage; tool calls left unanswered |

`usage` holds `input`, `output`, `cacheRead`, and `cacheWrite` (plus
`cacheWrite5m` / `cacheWrite1h` when the provider reports them). Journals
written by older versions may lack newer fields; tolerate their absence.

## What to compute

| Question | Computation |
|---|---|
| Which tools failed? | `tool_result.isError` joined to `tool_use.name` by `id`; rate per tool |
| Did it loop? | The same tool_use name and identical `input` repeated; long runs of calls with no `user_input` |
| Where did tokens go? | Sum `llm_response.usage` per turn; growth in `llm_request.estimatedInputTokens` |
| Is caching working? | `cacheRead / (input + cacheRead + cacheWrite)` per request; a sudden drop means the prompt prefix changed |
| Was context under pressure? | `compaction` count, levels, and `before → after` |
| Did delegation pay off? | `delegate_completed` ok/status, `durationMs`, `costUsd` per target |
| Did it end cleanly? | `session_end.pendingToolUses`, final `stopReason`, trailing `error` events |

## Script

Save outside the repository (a temp dir) and run with
`node tool-stats.mjs <journal.jsonl>`:

```js
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const toolById = new Map();
const tools = {};
const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const counts = { compaction: 0, error: 0, malformed: 0 };

for await (const line of createInterface({ input: createReadStream(process.argv[2]) })) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    counts.malformed++;
    continue;
  }
  if (event.type === 'tool_use') {
    toolById.set(event.id, event.name);
    tools[event.name] ??= { calls: 0, errors: 0 };
    tools[event.name].calls++;
  } else if (event.type === 'tool_result' && event.isError) {
    const name = toolById.get(event.id);
    if (name) tools[name].errors++;
  } else if (event.type === 'llm_response' && event.usage) {
    for (const key of Object.keys(tokens)) tokens[key] += event.usage[key] ?? 0;
  } else if (event.type in counts) {
    counts[event.type]++;
  }
}

console.log(JSON.stringify({ tools, tokens, counts }, null, 2));
```

## Report

```text
## Session audit — <session id> (<model>, <start> → <end>)

### Summary
Turns 14 · tool calls 212 (9.4% failed) · tokens in 1.9M / out 48k · cache hit 81% · compactions 2

### Findings
1. The bash tool failed 17/60 calls; 12 are the same `pnpm test` timing out
   (tool_use ids …, 10:42–10:58). Cause: watch mode never exits.
2. Cache hit fell from 88% to 12% at 11:03 after mode_changed plan → default;
   the prefix changed, and the next 6 requests paid full input price.

### Coverage
Parsed 18,402 lines, 3 malformed and skipped. Subagent transcripts not included.
```

## Anti-patterns

- **Reporting totals with no evidence** — every number traces to events.
- **Mixing sessions** without per-session labels.
- **Reading a huge journal whole** into context instead of streaming it.
- **Pasting raw tool output** with secrets into the report.
- **Guessing a cause** the events don't support — say "unexplained" instead.

## Before returning

- [ ] Journal parsed from disk; malformed lines counted, not fatal
- [ ] Every finding cites event types, times, and ids
- [ ] Tool failures joined by id; token and cache figures from `usage`
- [ ] Coverage stated (lines parsed, subagent transcripts included or not)
- [ ] Nothing sensitive quoted unredacted; journal untouched

## Accounting and attribution

Inspect the writer/provider adapter for usage semantics before computing cache
ratios. Some providers include cached tokens in input, others report additional
buckets; never add overlapping counters or count session_end totals again.
Join tool ids within the correct session/agent namespace and record missing
requests/results. Separate tool errors, cancelled work and infrastructure failures.
Reported model, fallback model and billed provider can differ. Price estimates
need dated model pricing; omit dollar totals when pricing/usage is unavailable.

## Skills in scope

- `observability` — for turning recurring findings into better runtime signals
- `bug-hunter` — for locating the code behind a recurring tool failure
- `output-standards` — for the `<nextsteps>` shape in the report
