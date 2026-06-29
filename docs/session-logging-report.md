# Session Logging Events — Audit Report

> **English** | WrongStack Core | June 2026

---

## Executive Summary

WrongStack maintains a comprehensive, tiered event logging system that serves as both a durable audit trail and a real-time observability layer. The system is designed around three principles:

1. **Reliability over completeness** — Core reconstruct events are always persisted regardless of audit level
2. **Forensic integrity** — Tool calls are protected by SHA-256 hash chains
3. **Zero agent impact** — All logging is best-effort; failures never disrupt the agent loop

---

## Event Inventory

| Category | Events | Tier |
|----------|--------|------|
| **Session Lifecycle** | `session_start`, `session_resumed`, `session_end` | Core |
| **User/LLM Interaction** | `user_input`, `llm_request`, `llm_response` | Core + Standard |
| **Tool Execution** | `tool_use`, `tool_result`, `tool_call_start`, `tool_call_end`, `tool_progress` | Core + Standard + Full |
| **Context Management** | `compaction`, `message_truncated` | Standard |
| **Error Handling** | `error`, `provider_retry`, `provider_error` | Standard |
| **Checkpointing** | `checkpoint`, `file_snapshot`, `rewound`, `in_flight_start`, `in_flight_end` | Core |
| **Task Management** | `task_created`, `task_updated`, `task_completed`, `task_failed` | Standard |
| **Multi-Agent** | `agent_spawned`, `agent_stopped`, `agent_error` | Standard |
| **Planning** | `spec_parsed`, `spec_analyzed` | Standard |
| **Skills** | `skill_activated`, `skill_deactivated` | Standard |
| **Mode** | `mode_changed` | Standard |

**Total distinct event types: 31**

---

## Audit Levels

| Level | Event Count | Use Case |
|-------|-------------|----------|
| `minimal` | 11 | Minimal disk I/O, resume-capable |
| `standard` | 27 | Default — balanced forensics |
| `full` | 31 | Debugging tool streaming |

---

## Storage Architecture

### Primary Log (JSONL)
```
~/.wrongstack/projects/<projectHash>/sessions/<date>/sess_<ULID>.jsonl
```

Format: One JSON object per line, ISO timestamps throughout.

### Tool Audit Sidecar (Hash Chain)
```
~/.wrongstack/projects/<projectHash>/sessions/<date>/sess_<ULID>.audit.jsonl
```

Tamper-evident via SHA-256 chain. Each entry links to the previous via `prevHash`. Verification walks the chain and recomputes hashes.

### Real-Time Layer (EventBus)
In-memory pub/sub. All events emitted here in addition to JSONL. Supports:
- Exact event names
- Glob patterns (`tool.*`, `provider.*`)
- Regex matching

---

## Key Findings

### Strengths

1. **Comprehensive coverage** — 31 distinct event types covering the full agent lifecycle
2. **Tiered retention** — Configurable audit levels prevent log bloat while maintaining critical data
3. **Hash chain integrity** — Tool audit log provides forensic tamper evidence
4. **Secret scrubbing** — User input and LLM responses pass through SecretScrubber before logging
5. **Resumable after crash** — `in_flight_start/end` markers enable recovery UI to show "what was happening when"
6. **Sampling for high-volume events** — `tool_progress` sampled at 1-in-8 to prevent log explosion
7. **Best-effort design** — Logging failures never crash the agent loop

### Event Quality Metrics

| Metric | Value |
|--------|-------|
| Total event types | 31 |
| Core (always logged) | 11 |
| Standard audit | 16 |
| Full-only | 1 |
| Hash-chained tool entries | Yes |
| Secret scrubbing | user_input, llm_response |
| Crash recovery markers | in_flight_start/end |

---

## EventBus Event Map (Real-Time)

The EventBus exposes a parallel set of in-memory events for live consumers (TUI, WebUI). Key events:

| Event | Trigger |
|-------|---------|
| `iteration.started/completed` | Per-iteration lifecycle |
| `tool.started/executed/progress` | Tool lifecycle + streaming |
| `provider.response/retry/error` | LLM provider events |
| `compaction.fired/failed` | Context pressure events |
| `ctx.pct` | Context fill percentage (live bar) |
| `budget.threshold_reached` | Soft budget limits |
| `subagent.*` | Multi-agent lifecycle |
| `storage.read/write/error` | Storage I/O observability |

---

## Recommendations

1. **Default audit level is appropriate** — `standard` balances forensics and disk usage
2. **Enable `full` for debugging** — When tool streaming behavior is unclear
3. **Monitor compaction frequency** — High compaction counts indicate context pressure
4. **Verify audit chains periodically** — Run `ToolAuditLog.verify()` on long sessions

---

## File Locations

| Artifact | Path Pattern |
|----------|-------------|
| Session JSONL | `~/.wrongstack/projects/<hash>/sessions/<date>/sess_<ULID>.jsonl` |
| Tool Audit | `~/.wrongstack/projects/<hash>/sessions/<date>/sess_<ULID>.audit.jsonl` |
| Config | `~/.wrongstack/config.json` |

---

## Related Documentation

- [`session-logging-events.md`](./session-logging-events.md) — Full event reference
- [`session.ts`](../../packages/core/src/types/session.ts) — TypeScript types
- [`events.ts`](../../packages/core/src/kernel/events.ts) — EventBus definition
- [`session-event-bridge.ts`](../../packages/core/src/storage/session-event-bridge.ts) — Audit level enforcement
- [`tool-audit-log.ts`](../../packages/core/src/storage/tool-audit-log.ts) — Hash chain implementation
