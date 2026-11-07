# Learned instructions for `shadow-agent`

> Project-specific learning data for the `shadow-agent` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-09-12T21:38:03.000Z; applied=79; wins=79 -->
- **Always treat `mail_inbox` returning `tool lacks allowed capability` as UNKNOWN (mailbox scan unavailable), never as "no control messages" — emit `shadow: quiet` with exactly one caveat line naming the denied tool, and never escalate or invoke `terminate_subagent` without a readable explicit `hoop`/`shadow` command. When `fleet action=status` and `fleet action=health` are clean, that is the fleet verdict; the injection `[FLEET PULSE]` block is FYI noise, not mailbox evidence.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `tool lacks allowed capability`
  - *How:* `shadow: quiet`
  - *How:* `terminate_subagent`
  - *How:* `hoop`
  - *How:* `shadow`
  - *How:* `fleet action=status`
  - *How:* `fleet action=health`
  - *How:* `[FLEET PULSE]`

<!-- learned-stamp: category=warning; capturedAt=2026-10-21T08:58:06.175Z; applied=1; wins=1; skipped=22; skippedWins=22 -->
- **Always treat peer join/status broadcasts that arrive duplicated through both a `[MAILBOX BTW]` injection and a `[MAILBOX]` injection in the same turn as one informational message — evaluate it once and never reply, exactly like single-delivery injected status noise.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `[MAILBOX BTW]`
  - *How:* `[MAILBOX]`

<!-- learned-stamp: category=warning; capturedAt=2026-10-04T15:12:39.180Z; applied=53; wins=53 -->
- **When `mail_inbox` is denied by session policy (allowed list lacks `coordination.mail`), emit `shadow: quiet` only if `fleet action=status` and `fleet action=health` are clean, and append exactly one caveat line naming the denied tool — never treat the denial as "no control messages" and never escalate it into an anomaly or intervention.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `coordination.mail`
  - *How:* `shadow: quiet`
  - *How:* `fleet action=status`
  - *How:* `fleet action=health`

<!-- learned-stamp: category=warning; capturedAt=2026-11-06T16:01:58.696Z; applied=8; wins=8 -->
- **When `mail_inbox` is denied with "tool lacks allowed capability (has: coordination.mail…)", do not retry or substitute `mailbox action=check` — report UNKNOWN for the control scan, emit `shadow: quiet` only when `fleet action=status` and `fleet action=health` are clean, and append exactly one caveat line naming the denied tool.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `mail_inbox`
  - *How:* `mailbox action=check`
  - *How:* `shadow: quiet`
  - *How:* `fleet action=status`
  - *How:* `fleet action=health`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-21T08:58:06.175Z; applied=6; wins=6; skipped=17; skippedWins=17 -->
- **Treat a host dispatch reason that cites a past subagent timeout as historical context only: verify liveness with `fleet action=status`/`fleet action=health` before classifying anything as down; if the cited subagent is absent from the live roster, it is not an in-flight anomaly.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `fleet action=status`
  - *How:* `fleet action=health`

---
*Last capture: 2026-11-06T16:01:58.696Z · 5 entries*
