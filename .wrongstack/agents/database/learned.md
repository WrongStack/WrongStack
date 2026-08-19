# Learned instructions for `database`

> Project-specific learning data for the `database` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-19T16:53:05.144Z; skill=api-design -->
- **Always treat `packages/providers/src/presets/anthropic.ts` as the shared declarative core of the Anthropic wire family in `packages/providers`, not a standalone provider: the classes `AnthropicProvider` (`src/anthropic.ts`) and `AnthropicOAuthProvider` (`src/anthropic-oauth.ts`) both `super(anthropicWireFormat, ...)`, and auth-scheme quirks (proxy `Authorization: Bearer` vs `x-api-key`, via `isAnthropicHost`) live in the `AnthropicProvider.buildHeaders` override — never in the preset.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/providers/src/presets/anthropic.ts`
  - *How:* `packages/providers`
  - *How:* `AnthropicProvider`
  - *How:* `src/anthropic.ts`
  - *How:* `AnthropicOAuthProvider`
  - *How:* `src/anthropic-oauth.ts`
  - *How:* `super(anthropicWireFormat, ...)`
  - *How:* `Authorization: Bearer`
  - *How:* `x-api-key`
  - *How:* `isAnthropicHost`
  - *How:* `AnthropicProvider.buildHeaders`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-19T16:43:08.027Z; applied=6; wins=6 -->
- **Treat `packages/providers/src/openai-shared.ts` as the single reasoning-effort baseline gate (`shouldEmitReasoningEffort`: valid OpenAI values only, suppressed when `req.tools` is non-empty), with subclasses deliberately relaxing it — `openai-compatible.ts` (#14 mapping) and `opencode-go.ts` (catalog restore). Before changing effort behavior, always grep `reasoning_effort` across `packages/providers/src/` — `presets/openai.ts` carries a private duplicated guard that diverges (no tools suppression) and `presets/mistral.ts` defaults to literal `'none'`.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `packages/providers/src/openai-shared.ts`
  - *How:* `shouldEmitReasoningEffort`
  - *How:* `req.tools`
  - *How:* `openai-compatible.ts`
  - *How:* `opencode-go.ts`
  - *How:* `reasoning_effort`
  - *How:* `packages/providers/src/`
  - *How:* `presets/openai.ts`
  - *How:* `presets/mistral.ts`
  - *How:* `'none'`

---
*Last capture: 2026-08-19T16:53:05.144Z · 2 entries*
