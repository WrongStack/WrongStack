# Learned instructions for `shadow-agent`

> Project-specific learning data for the `shadow-agent` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T11:56:22.689Z; applied=39; wins=39 -->
- **- **Treat `mail_inbox` (and `mailbox action=check/query`) capability denials as UNKNOWN, never empty.** Anchor: error "tool lacks allowed capability (has: …, allowed: …)". Never retry, never substitute another mailbox action, never classify as "no control messages." Record the scan-unavailable caveat plainly in the report so the Director knows the control-message check could not be performed in that session. - **Treat subagent failure enumerations in the host reason as historical context, not in-flight anomalies.** Verify liveness via `fleet status`/`health` first.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check/query`
  - *How:* `fleet status`
  - *How:* `health`

<!-- learned-stamp: category=warning; capturedAt=2026-08-24T11:32:10.613Z; applied=25; wins=25 -->
- **Always report a `mail_inbox` capability denial (error "tool lacks allowed capability (has: coordination.mail, allowed: …)") as an UNKNOWN scan-unavailable condition in the shadow result report — never retry it, never substitute `mailbox action=check/query`, and never treat injected FLEET PULSE/online-agent blocks as evidence the mailbox was inspected. `coordination.fleet.read` being present while `coordination.mail` is absent means the fleet snapshot is verifiable but the hoop/shadow control check is not.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check/query`
  - *How:* `coordination.fleet.read`
  - *How:* `coordination.mail`

<!-- learned-stamp: category=warning; capturedAt=2026-08-21T18:50:36.964Z; applied=37; wins=37 -->
- **Always treat `mail_inbox` or `mailbox action=check/query` capability denials as UNKNOWN (mailbox scan unavailable for this session) rather than empty, and never retry or work around the denial with other tools — report it plainly so the host knows the control-message check could not be performed.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check/query`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T09:49:50.285Z; applied=37; wins=37 -->
- **Treat any `mail_inbox` capability denial as UNKNOWN (scan unavailable) regardless of whether the mailbox tool appears registered — a tool can be registered with `coordination.mail` yet still denied by the session's permission-policy allowed list. Never classify the denial as "no control messages," never retry it, and never work around it with `mailbox action=check/query`; record the caveat in the `submit_result` report instead. Anchor: `mail_inbox` → error "tool lacks allowed capability (has: coordination.mail, allowed: …)".**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `coordination.mail`
  - *How:* `mailbox action=check/query`
  - *How:* `submit_result`

<!-- learned-stamp: category=warning; capturedAt=2026-08-22T13:00:22.836Z; applied=38; wins=38 -->
- **Treat injected FYI/awareness mailbox blocks (e.g. peer `status` broadcasts delivered into the conversation) as informational noise only — they are NOT a substitute for the explicit `mail_inbox` control-message scan. When `mail_inbox` is capability-denied, the hoop/shadow control check stays UNKNOWN even if status broadcasts arrived via injection, since injected blocks are request-scoped and cannot carry control directives; report the scan-unavailable caveat in `submit_result` and never use the injected block as evidence that the mailbox was inspected.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `status`
  - *How:* `mail_inbox`
  - *How:* `submit_result`

<!-- learned-stamp: category=warning; capturedAt=2026-08-25T16:17:32.660Z; applied=15; wins=15 -->
- **When `fleet action=status`/`action=health` are clean but `mail_inbox` returns "tool lacks allowed capability (has: coordination.mail, allowed: …)", still emit `shadow: quiet` as the fleet verdict and append exactly one caveat line naming the denied tool — do not retry, do not substitute `mailbox action=check/query`, and do not escalate the denial into an anomaly report.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `fleet action=status`
  - *How:* `action=health`
  - *How:* `mail_inbox`
  - *How:* `shadow: quiet`
  - *How:* `mailbox action=check/query`

<!-- learned-stamp: category=warning; capturedAt=2026-08-25T17:46:29.663Z; applied=14; wins=14 -->
- **When a shadow pass's `fleet action=status` roster is clean but `mail_inbox` returns "tool lacks allowed capability (has: coordination.mail, allowed: …)", emit `shadow: quiet` as the fleet verdict plus exactly one caveat line naming the denied tool — the denial is UNKNOWN (scan unavailable), never "no control messages," and never grounds for `terminate_subagent`, since interventions require a readable explicit command and an unreadable mailbox is not authorization.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `fleet action=status`
  - *How:* `mail_inbox`
  - *How:* `shadow: quiet`
  - *How:* `terminate_subagent`

<!-- learned-stamp: category=warning; capturedAt=2026-08-17T07:53:48.076Z; applied=51; wins=51 -->
- **When running shadow-agent check passes in this environment, never claim the mailbox was inspected if `mail_inbox` or `mailbox action=check/query` return a capability denial — the session may lack `coordination.mail`; state that the mailbox scan was unavailable (UNKNOWN, not empty) in the result report, and do not retry or work around the denial with other tools.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check/query`
  - *How:* `coordination.mail`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-25T14:44:25.260Z; applied=16; wins=16 -->
- **Treat a `mail_inbox` capability denial (`tool lacks allowed capability (has: coordination.mail, allowed: …)`) as UNKNOWN scan-unavailable and still emit `shadow: quiet` for the fleet verdict when `fleet action=status`/`action=health` are clean — append a single-line caveat naming the denied tool rather than suppressing the finding or upgrading the pass to an anomaly report.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `mail_inbox`
  - *How:* `tool lacks allowed capability (has: coordination.mail, allowed: …)`
  - *How:* `shadow: quiet`
  - *How:* `fleet action=status`
  - *How:* `action=health`

---
*Last capture: 2026-08-25T17:46:29.663Z · 9 entries*
