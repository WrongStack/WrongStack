# Learned instructions for `context`

> Project-specific learning data for the `context` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-08-19T16:48:57.416Z; skill=output-standards; applied=14; wins=14 -->
- **Always treat `docs/provider-author-guide.md` and `packages/providers/README.md` ("Wire-format adapter (declarative)") as the entry points when pre-mapping provider work — they explain the `WireAdapter`/`WireFormatProvider`/`presets/*.ts` split that every provider file in `packages/providers/src/` follows. Never assume grep brace-globs (`{a,b}.ts`) work in this environment — they return false zero-match results; filter by exact file path or run one grep per file to avoid mislabeling a file as "no handling".**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check. Project signals: avoid mislabeling a file as "no handling".
  - *How:* `docs/provider-author-guide.md`
  - *How:* `packages/providers/README.md`
  - *How:* `WireAdapter`
  - *How:* `WireFormatProvider`
  - *How:* `presets/*.ts`
  - *How:* `packages/providers/src/`
  - *How:* `{a,b}.ts`

<!-- learned-stamp: category=warning; capturedAt=2026-08-19T17:01:23.576Z; skill=output-standards; applied=3; wins=3 -->
- **Never assume `packages/providers/src/presets/openai.ts` is the runtime transport for the `openai` wire family — the registry factory switch in `packages/providers/src/index.ts` (`case 'openai'`) builds the class-based `OpenAIProvider` from `packages/providers/src/openai.ts`. The preset is consumed at runtime only by `GitHubCopilotProvider` (`packages/providers/src/github-copilot.ts`, `super(openaiWireFormat, ...)`).**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `packages/providers/src/presets/openai.ts`
  - *How:* `openai`
  - *How:* `packages/providers/src/index.ts`
  - *How:* `case 'openai'`
  - *How:* `OpenAIProvider`
  - *How:* `packages/providers/src/openai.ts`
  - *How:* `GitHubCopilotProvider`
  - *How:* `packages/providers/src/github-copilot.ts`
  - *How:* `super(openaiWireFormat, ...)`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-08-20T06:48:15.609Z; skill=audit-log; applied=1; wins=1 -->
- **Always resolve `parseNextSteps`/`stripNextStepsBlock` to their canonical home `@wrongstack/tools/next-steps` before editing — `packages/webui/src/components/NextStepsBar.tsx` only re-exports them for back-compat, so a UI-component import path does not mean the parser logic lives (or should be edited) there. Check the tools package first when the parser itself needs changing.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `parseNextSteps`
  - *How:* `stripNextStepsBlock`
  - *How:* `@wrongstack/tools/next-steps`
  - *How:* `packages/webui/src/components/NextStepsBar.tsx`
  - *How:* `@wrongstack/tools`

---
*Last capture: 2026-08-20T06:48:15.609Z · 3 entries*
