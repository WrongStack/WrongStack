# Learned instructions for `audit-log`

> Project-specific learning data for the `audit-log` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-08-12T20:46:42.979Z; skill=bug-hunter -->
- **Always test React-owned slash command registration against the registry’s actual collision and teardown semantics: pre-register the canonical command, simulate effect cleanup/rerender, and verify both bare UI forms and typed fallback forms. Anchor these lifecycle tests in `packages/tui/src/hooks/use-core-tui-commands.ts` and `packages/tui/src/hooks/use-tui-slash-commands.ts`; factory-only tests cannot detect stale closures, ignored same-owner registrations, or lost canonical handlers.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `packages/tui/src/hooks/use-core-tui-commands.ts`
  - *How:* `packages/tui/src/hooks/use-tui-slash-commands.ts`

---
*Last capture: 2026-08-12T20:46:42.979Z · 1 entries*
