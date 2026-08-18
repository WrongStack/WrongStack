# Learned instructions for `shadow-agent`

> Project-specific learning data for the `shadow-agent` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-17T07:53:48.076Z; applied=1; wins=1 -->
- **When running shadow-agent check passes in this environment, never claim the mailbox was inspected if `mail_inbox` or `mailbox action=check/query` return a capability denial — the session may lack `coordination.mail`; state that the mailbox scan was unavailable (UNKNOWN, not empty) in the result report, and do not retry or work around the denial with other tools.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check/query`
  - *How:* `coordination.mail`

---
*Last capture: 2026-08-17T07:53:48.076Z · 1 entries*
