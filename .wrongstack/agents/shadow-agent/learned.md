# Learned instructions for `shadow-agent`

> Project-specific learning data for the `shadow-agent` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T11:56:22.689Z; applied=22; wins=22 -->
- **- **Treat `mail_inbox` (and `mailbox action=check/query`) capability denials as UNKNOWN, never empty.** Anchor: error "tool lacks allowed capability (has: …, allowed: …)". Never retry, never substitute another mailbox action, never classify as "no control messages." Record the scan-unavailable caveat plainly in the report so the Director knows the control-message check could not be performed in that session. - **Treat subagent failure enumerations in the host reason as historical context, not in-flight anomalies.** Verify liveness via `fleet status`/`health` first.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check/query`
  - *How:* `fleet status`
  - *How:* `health`

<!-- learned-stamp: category=warning; capturedAt=2026-08-24T11:32:10.613Z; applied=8; wins=8 -->
- **Always report a `mail_inbox` capability denial (error "tool lacks allowed capability (has: coordination.mail, allowed: …)") as an UNKNOWN scan-unavailable condition in the shadow result report — never retry it, never substitute `mailbox action=check/query`, and never treat injected FLEET PULSE/online-agent blocks as evidence the mailbox was inspected. `coordination.fleet.read` being present while `coordination.mail` is absent means the fleet snapshot is verifiable but the hoop/shadow control check is not.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check/query`
  - *How:* `coordination.fleet.read`
  - *How:* `coordination.mail`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T18:50:36.964Z; applied=20; wins=20 -->
- **Always treat `mail_inbox` or `mailbox action=check/query` capability denials as UNKNOWN (mailbox scan unavailable for this session) rather than empty, and never retry or work around the denial with other tools — report it plainly so the host knows the control-message check could not be performed.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check/query`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T09:49:50.285Z; applied=20; wins=20 -->
- **Treat any `mail_inbox` capability denial as UNKNOWN (scan unavailable) regardless of whether the mailbox tool appears registered — a tool can be registered with `coordination.mail` yet still denied by the session's permission-policy allowed list. Never classify the denial as "no control messages," never retry it, and never work around it with `mailbox action=check/query`; record the caveat in the `submit_result` report instead. Anchor: `mail_inbox` → error "tool lacks allowed capability (has: coordination.mail, allowed: …)".**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `coordination.mail`
  - *How:* `mailbox action=check/query`
  - *How:* `submit_result`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T13:00:22.836Z; applied=21; wins=21 -->
- **Treat injected FYI/awareness mailbox blocks (e.g. peer `status` broadcasts delivered into the conversation) as informational noise only — they are NOT a substitute for the explicit `mail_inbox` control-message scan. When `mail_inbox` is capability-denied, the hoop/shadow control check stays UNKNOWN even if status broadcasts arrived via injection, since injected blocks are request-scoped and cannot carry control directives; report the scan-unavailable caveat in `submit_result` and never use the injected block as evidence that the mailbox was inspected.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `status`
  - *How:* `mail_inbox`
  - *How:* `submit_result`

<!-- learned-stamp: category=warning; capturedAt=2026-08-17T07:53:48.076Z; applied=34; wins=34 -->
- **When running shadow-agent check passes in this environment, never claim the mailbox was inspected if `mail_inbox` or `mailbox action=check/query` return a capability denial — the session may lack `coordination.mail`; state that the mailbox scan was unavailable (UNKNOWN, not empty) in the result report, and do not retry or work around the denial with other tools.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check/query`
  - *How:* `coordination.mail`

---
*Last capture: 2026-08-24T11:32:10.613Z · 6 entries*
