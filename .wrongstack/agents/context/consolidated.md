# Context Agent Reference

## Provider Package Navigation

- Treat `docs/provider-author-guide.md` and `packages/providers/README.md` ("Wire-format adapter (declarative)") as the entry points when pre-mapping provider work — they document the `WireAdapter` / `WireFormatProvider` / `presets/*.ts` split followed by every provider file in `packages/providers/src/`.
- A preset file is not a runtime transport. `packages/providers/src/presets/openai.ts` does not serve the `openai` wire family at runtime: the registry factory switch in `packages/providers/src/index.ts` (`case 'openai'`) constructs the class-based `OpenAIProvider` from `packages/providers/src/openai.ts`. The preset is consumed at runtime only by `GitHubCopilotProvider` (`packages/providers/src/github-copilot.ts`, via `super(openaiWireFormat, ...)`). Resolve behavior through the registry switch, not the presets directory.

## Core Coordination

- `instantiateRosterConfig` is defined more than once. The shared helper lives in `packages/core/src/coordination/director-input-helpers.ts`, but `packages/core/src/coordination/delegate-tool.ts` also defines a private 4-arg variant with the same name that applies `applyRosterBudget` and `FLEET_ROSTER_BUDGETS` timeout derivation. Before changing spawn-id or budget behavior, grep `function instantiateRosterConfig` across `packages/core/src/coordination/` and determine whether each caller uses the shared helper or the injected-parameter path via `buildKanbanSubagentConfig`.

## Canonical Module Homes

- `parseNextSteps` and `stripNextStepsBlock` belong to `@wrongstack/tools/next-steps`. `packages/webui/src/components/NextStepsBar.tsx` only re-exports them for back-compat — a UI-component import path does not mean the parser logic lives there or should be edited there. Check the `@wrongstack/tools` package first when the parser itself needs changing.

## Environment and Tooling Warnings

- Brace globs (`{a,b}.ts`) in grep return false zero-match results in this environment. Filter by exact file path or run one grep per file; never conclude a file has "no handling" based on a brace-glob search.