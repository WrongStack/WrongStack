# Learned instructions for `security-scanner`

> Project-specific learning data for the `security-scanner` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-09-10T18:57:12.137Z; skill=security-scanner -->
- **- When reviewing TUI render surfaces, always check every sink for `sanitizeTerminalText` from `packages/tui/src/terminal-width.ts` — the central sanitizer is thorough (OSC/DCS/CSI/C1 strip) but flat-fallback paths and slash-command message strings (e.g. `confirm-prompt.tsx` flat diff fallback, `shell-command-warning.tsx`, `kill-slash.ts`/`ps-slash.ts` command echo) have historically bypassed it; grep the sink, not the sanitizer, for coverage. - Never log diagnostics from React error boundaries via `console.error` in WrongStack's TUI — `silenceTerminal()` in `packages/tui/src/terminal-silence.…**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `sanitizeTerminalText`
  - *How:* `packages/tui/src/terminal-width.ts`
  - *How:* `confirm-prompt.tsx`
  - *How:* `shell-command-warning.tsx`
  - *How:* `kill-slash.ts`
  - *How:* `ps-slash.ts`
  - *How:* `console.error`
  - *How:* `silenceTerminal()`

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-09-05T11:10:41.547Z; skill=security-scanner; skipped=1; skippedWins=1 -->
- **Always distinguish WrongStack's two SSRF check tiers when reviewing MCP posture: `packages/mcp/src/transport-security.ts` (`validateTransportUrl`) is syntactic and hostname-based for admin-configured URLs, while `assertNotPrivate` in the fetch tool path is resolution-bound — recommend reusing the resolution-bound pattern at MCP transport connect time rather than writing a third check.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `packages/mcp/src/transport-security.ts`
  - *How:* `validateTransportUrl`
  - *How:* `assertNotPrivate`

---
*Last capture: 2026-09-10T18:57:12.137Z · 2 entries*
