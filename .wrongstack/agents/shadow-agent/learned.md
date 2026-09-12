# Learned instructions for `shadow-agent`

> Project-specific learning data for the `shadow-agent` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-09-12T21:38:03.000Z -->
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

---
*Last capture: 2026-09-12T21:38:03.000Z · 1 entries*
