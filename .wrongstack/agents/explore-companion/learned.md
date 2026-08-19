# Learned instructions for `explore-companion`

> Project-specific learning data for the `explore-companion` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-19T16:48:08.958Z; applied=24; wins=24 -->
- **Always deliver explore-companion probe findings through `submit_result` in this project — the `mailbox` tool send action is denied for this role (capability `coordination.mail` not in the allowed list), so composing a mailbox message to the leader wastes a round trip. Anchor: `submit_result`, `mailbox`, role `explore-companion`.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `submit_result`
  - *How:* `mailbox`
  - *How:* `coordination.mail`
  - *How:* `explore-companion`

<!-- learned-stamp: category=convention; capturedAt=2026-08-19T16:51:12.476Z; skill=node-modern; applied=22; wins=22 -->
- **Always keep `submit_result` payloads (summary, findings, suggested_next_steps) pure ASCII — em-dashes and arrow symbols (—, ⇒) correlate with "Invalid report" schema rejections in this runtime, while the same content rewritten in ASCII passes. Anchor: `submit_result`, ASCII, findings.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `submit_result`

## Project facts

<!-- learned-stamp: category=fact; capturedAt=2026-08-19T17:01:36.952Z; skill=node-modern; applied=22; wins=22 -->
- **Keep `submit_result` payloads compact — in this runtime, an oversized report (13 `files_examined` entries plus 8 long findings) is rejected with the misleading error "summary/findings/findings... are required" even though every field is present and ASCII; the same content trimmed to ~7 shorter findings and 3 files passes on the next call. Anchor: `submit_result`, `files_examined`, `findings`, payload size.**
  - *Why:* Current state of the project — assumed by other conventions, build steps, or peers, so acting on a stale assumption wastes a cycle.
  - *How:* `submit_result`
  - *How:* `files_examined`
  - *How:* `findings`

---
*Last capture: 2026-08-19T17:01:36.952Z · 3 entries*
