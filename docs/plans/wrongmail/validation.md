# Validation

Status: proposed acceptance plan. Every test, matrix row, and benchmark below is NOT RUN.

## 1. Evidence rules

- Tests exercise the real HTTP/stdio path against a real `wrongmaild` process and real SQLite files in temporary data directories. Service internals may have unit tests, but acceptance claims come from process-level tests.
- No suspect code is mocked in an acceptance test. Clocks may be injected through a documented test-only server flag that is compiled out of release builds.
- Each claim in release notes links to the test or report that proves it, with tool versions and platform.
- Flaky tests block release until root-caused; retries are not evidence.

## 2. Contract and compatibility

| ID | Check | Pass condition |
|---|---|---|
| V-C01 | `wm1` fixtures (types × addresses × audience) through REST | All expected accepts/rejects match |
| V-C02 | Actor view derivation for direct, alias, broadcast, session, channel | Matches frozen WrongStack fixtures |
| V-C03 | TTL/retention fixtures with injected clock | `network` profile keeps unread addressed mail, incomplete `ask`/`assign`/`review`, and whole threads; `wrongstack-local` profile matches current WrongStack defaults exactly |
| V-C08 | Agent A asks B; A's tool exits; next day A starts a new session of the same installation | A has the same agent ID and sees B's reply exactly once as unread |
| V-C09 | Alias mail already acknowledged in an earlier session | Not re-injected by session-start or prompt-submit hooks in a new session |
| V-C10 | Same installation runs two concurrent sessions with one agent name | First keeps the stable ID, second gets a suffixed ID; alias reaches both |
| V-C04 | Unknown fields and unknown extensions | Preserved or ignored, never rejected |
| V-C05 | MCP tool inventory vs spec | Exact operation names, schemas generated from proto |
| V-C06 | WrongStack mailbox contract tests against the adapter | Same results as the local IPC backend for `wm1` operations |
| V-C07 | Export/import round-trip | IDs, timestamps, receipts, threads identical |

## 3. Security and isolation

| ID | Check | Pass condition |
|---|---|---|
| V-S01 | Every route without a token | 401, except `/healthz` (no data) |
| V-S02 | Principal granted project A queries/sends/watches project B by ID, slug, header, URL | 403/404; no counts, events, or timing-distinguishable existence |
| V-S03 | `from`, `sender`, `actor`, receipt actor supplied in body | Ignored; server-bound values stored |
| V-S04 | Agent name outside grant pattern | `agent_name_not_granted` |
| V-S05 | Session token used for a different project or agent | Rejected |
| V-S06 | Revoke principal while it holds an SSE stream and long-poll | Both terminate within 1 s; subsequent requests 401 |
| V-S07 | Expired enrollment code; reused enrollment code | Rejected; audited |
| V-S08 | `control` type from any credential, including operator | `reserved_type` |
| V-S09 | `assign`/`steer` without `coordinate`; broadcast without `broadcast` | `forbidden_capability` |
| V-S10 | Fence injection fixtures through MCP text, hook digests, adapter delivery | No body can close or open a fence; preamble present |
| V-S11 | Secret fixtures via CLI and raw REST | Rejected (or redacted per policy); never stored, logged, or echoed |
| V-S12 | Grep of logs, audit, DB, backups after full test run for test tokens and secret fixtures | Zero hits |
| V-S13 | Generated tool configs, hook files, skill, snippets | Contain no token material |
| V-S14 | Forwarded headers from untrusted peer | Ignored for client IP and rate limiting |
| V-S15 | `/mcp` request with foreign `Origin` | Rejected |
| V-S16 | Non-loopback bind without TLS | Refused without explicit insecure flag |
| V-S17 | Rate limits and loop guard | 429 with `Retry-After`; duplicate-body loop blocked |
| V-S18 | Fuzzing: address parser, git-remote normalizer, fence, secret scanner, JSON bodies | No panics; bounded memory |

## 4. Client smoke matrix

Run on recorded tool versions; each cell is pass/fail/not-applicable with a log.

| Tool | MCP stdio | MCP HTTP | Session-start injection | Prompt-time injection | Stop continuation | Skill/rules loop | Fail-open with server down |
|---|---|---|---|---|---|---|---|
| Claude Code | | | | | | | |
| Codex CLI | | | | | | | |
| Gemini CLI | | | | | | | |
| Cursor | | | | | | | |
| VS Code / Copilot | | | | | | | |
| OpenCode | | | | | | | |
| Shell-only via wrapper | n/a | n/a | | n/a | n/a | | |
| WrongStack (adapter) | n/a | n/a | | | | | |

Scenario per tool, two machines:

1. Agent A (tool X, machine 1) sends `ask` to alias of agent B (tool Y, machine 2).
2. B sees it through its integration path, replies in-thread.
3. A receives the reply, completes the `ask` with outcome.
4. Both sides see correct sender attribution and receipts; operator audit shows both sessions.
5. Server stopped: both tools continue working; hooks emit a single notice; CLI sends go to outbox; restart flushes without duplicates.

## 5. Fault and durability

| ID | Check | Pass condition |
|---|---|---|
| V-F01 | Kill server between commit and reply; client retries with same idempotency key | One message; original returned |
| V-F02 | Kill `-9` under write load; restart | `integrity_check` ok; no lost committed messages; cursors valid |
| V-F03 | Disk full | Read-only maintenance mode; reads work; recovery after space freed |
| V-F04 | Corrupt one project DB | Only that project read-only; others serve |
| V-F05 | Slow consumer on SSE | Resync event, catch-up via query, no missed visible messages |
| V-F06 | Proxy that buffers SSE | Client falls back to long-poll |
| V-F07 | Migration from previous schema with pre-migrate backup and rollback | Both directions succeed |
| V-F08 | Backup during load; restore drill | Checksums verify; restored server passes V-C01 |
| V-F09 | Client clock skewed ±1 hour | Ordering and TTL unaffected; doctor warns |
| V-F10 | Hook helper with server slow (> budget) | Returns within budget, exit 0, cursor not advanced |

## 6. Performance

Targets from [Deployment](deployment-and-operations.md#9-capacity-planning-targets-not-measured); reported with machine, OS, binary version, dataset size.

| ID | Measure | Target |
|---|---|---|
| V-P01 | Send latency p95, server-side, 50 sends/s across 50 projects | < 50 ms |
| V-P02 | Commit-to-watch-notification p95 | < 500 ms |
| V-P03 | Inbox query p95 with 100k messages in project | < 30 ms |
| V-P04 | 200 concurrent sessions with SSE, idle CPU and memory | < 2% CPU, < 128 MiB RSS |
| V-P05 | Hook helper end-to-end (`prompt-submit`, no new mail) | < 300 ms on LAN, < 800 ms over internet |
| V-P06 | Cold start to serving | < 1 s |

## 7. Release proof

A release is certified when:

1. V-C, V-S, and V-F suites pass on the release binaries for Linux, Windows, and macOS.
2. The client smoke matrix lists only tools with passing rows as supported, with versions.
3. V-P measurements are attached; any missed target is disclosed with the measured value.
4. A restore drill and an upgrade-from-previous-release drill pass.
5. The security review findings are closed or explicitly accepted with rationale.
6. Release artifacts have checksums and signatures; the container image runs as non-root with a read-only root filesystem.
