# Learned instructions for `security-scanner`

> Project-specific learning data for the `security-scanner` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-09-05T11:10:41.547Z; skill=security-scanner -->
- **Always distinguish WrongStack's two SSRF check tiers when reviewing MCP posture: `packages/mcp/src/transport-security.ts` (`validateTransportUrl`) is syntactic and hostname-based for admin-configured URLs, while `assertNotPrivate` in the fetch tool path is resolution-bound — recommend reusing the resolution-bound pattern at MCP transport connect time rather than writing a third check.**
  - *Why:* This project's chosen approach — alternatives were considered and either conflict with existing architecture or were rejected for known reasons.
  - *How:* `packages/mcp/src/transport-security.ts`
  - *How:* `validateTransportUrl`
  - *How:* `assertNotPrivate`

---
*Last capture: 2026-09-05T11:10:41.547Z · 1 entries*
