# Context Agent Reference

## Provider Package Navigation

- Treat `docs/provider-author-guide.md` and `packages/providers/README.md` ("Wire-format adapter (declarative)") as the entry points when pre-mapping provider work — they document the `WireAdapter` / `WireFormatProvider` / `presets/*.ts` split followed by every provider file in `packages/providers/src/`.
- A preset file is not a runtime transport. `packages/providers/src/presets/openai.ts` does not serve the `openai` wire family at runtime: the registry factory switch in `packages/providers/src/index.ts` (`case 'openai'`) constructs the class-based `OpenAIProvider` from `packages/providers/src/openai.ts`. The preset is consumed at runtime only by `GitHubCopilotProvider` (`packages/providers/src/github-copilot.ts`, via `super(openaiWireFormat, ...)`). Resolve behavior through the registry switch, not the presets directory.

## Provider Config Wiring

- When auditing provider-config wiring, grep for callers of `resolveProviderCfg`, `resolveProviderCfgWithProxy`, and `buildProviderForId` across `packages/cli/src/wiring/*.ts` and `packages/cli/src/cli-main.ts`. Known historical drift sites are `provider.ts:setupProvider`, `provider-runtime.ts:resolveProviderCfg`, and `packages/runtime/src/fleet/light-subagent-factory.ts:buildProvider`; any new hand-copied config merge elsewhere in the monorepo is a regression risk.

## Core Coordination

- `instantiateRosterConfig` is defined more than once. The shared helper lives in `packages/core/src/coordination/director-input-helpers.ts`, but `packages/core/src/coordination/delegate-tool.ts` also defines a private 4-arg variant with the same name that applies `applyRosterBudget` and `FLEET_ROSTER_BUDGETS` timeout derivation. Before changing spawn-id or budget behavior, grep `function instantiateRosterConfig` across `packages/core/src/coordination/` and determine whether each caller uses the shared helper or the injected-parameter path via `buildKanbanSubagentConfig`.

## Canonical Module Homes

- `parseNextSteps` and `stripNextStepsBlock` belong to `@wrongstack/tools/next-steps`. `packages/webui/src/components/NextStepsBar.tsx` only re-exports them for back-compat — a UI-component import path does not mean the parser logic lives there or should be edited there. Check the `@wrongstack/tools` package first when the parser itself needs changing.
- `packages/tui/src/components/status-bar.tsx` is a facade: only the `StatusBar` component is defined there. Formatting helpers live in `status-bar-format.tsx`, colors/icons in `status-bar-icons.tsx`, prop types in `status-bar-types.tsx`, and chip construction in `status-bar-rails.tsx`. Its single render site is `AppStatusRegion` in `packages/tui/src/app-status-region.tsx` (mounted by `app-view.tsx`), and all importers are package-internal — route status-bar edits to the owning sibling module, never the facade.

## Verifying JSX Component Wiring

- Locate JSX render sites by grepping the bare component name (e.g. `StatusBar`) or its import statement — never a pattern with a leading `<`. Angle-bracket-prefixed patterns return false zero matches in this environment even when the tag is present, and bracketed alternations silently degrade to only their non-bracketed branch.
- Verify React component wiring in `packages/webui/src` with an exact-text grep of the component name. `codebase-incoming-calls` and `codebase-skeleton` cannot see JSX render edges: a zero incoming-call count or an import-only skeleton does not mean a component is unwired (e.g. a component reported 0 incoming calls while `ChatView/index.tsx` both imported and rendered it).
- Treat exact line numbers in wiring evidence as perishable while a peer edits the same file concurrently.

## WebUI Test Conventions

- Treat files under `packages/webui/tests/**` as vitest entry points. Confirm discovery and environment by reading the package's `vitest.config.ts` inline `projects` blocks (include globs and `globals: true`) — never by searching for code importers, since test files have none.
- A webui test using hooks like `beforeEach` without importing them from `vitest` is not a bug when its project sets `test.globals: true`; bare-hook usage only works inside globals-enabled projects, not root-config suites.

## Repo Documentation Conventions

- Treat `reports/*.md` files as standalone audit documents with no code exports or programmatic callers. Before editing one, verify its evidence claims (counts, file paths) with a fresh search rather than assuming they are still current.

## Environment and Tooling Warnings

- Brace globs (`{a,b}.ts`) in grep return false zero-match results in this environment. Filter by exact file path or run one grep per file; never conclude a file has "no handling" based on a brace-glob search.
- Scan build output by enumerating `packages/*/dist` with `glob` using an explicit `path` argument per package (e.g. `path: packages/providers/dist`, pattern `**/*.js`), then grep each exact file path. Repo-root globs (`packages/*/dist/*.js`) return 0 files, and directory-mode grep into a dist directory returns a false zero: rg honors `.gitignore`, which ignores `dist/`, while explicit-file grep and explicit-path glob still see ignored files.

## Result Submission Validation

- Keep `submit_result`'s `findings`, `files_examined`, and `suggested_next_steps` as flat arrays of plain strings — no nested arrays, objects, or JSON-like structures. The validator behind `coordination.result.submit` parses these fields strictly and rejects entries it interprets as nested.
- Write all `submit_result` string entries in plain ASCII using only commas and periods. Reports containing em-dashes and parentheses have been rejected even with every field present and a numeric confidence, while identical content was accepted after ASCII-only sanitization.