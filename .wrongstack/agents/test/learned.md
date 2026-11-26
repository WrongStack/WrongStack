# Learned instructions for `test`

> Project-specific learning data for the `test` agent. Each entry is a directive — read it as an instruction, not a journal entry. Entries are re-derived on every capture, so this file is always a current, structured snapshot of what this agent has learned.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-11-26T12:41:59.117Z; skill=typescript-strict -->
- **- In `apps/desktop-v2` (tsconfig has `exactOptionalPropertyTypes: true`), declare new optional component props as `prop?: T | undefined` when callers may pass explicit `undefined`, or `pane={cond ? value : undefined}` fails typecheck. - When overriding a hook-returned setter from `useFileWorkspace` (model is `ReturnType<typeof useFileWorkspace>`), annotate the override as `Dispatch<SetStateAction<boolean>>` from `react` — a plain `(v: boolean) => void` is not assignable to `Dispatch<SetStateAction<boolean>>` under strict function types. - To drive a parent grid's column width from a child component you can't edit, set an inline CSS custom property + `data-*` marker on the child and switch the parent track to `auto` via `:has(> child[data-*])` with `width: var(--x, fallback)` on the child — custom properties never inherit upward, and this keeps media/container-query stacked overrides working by listing the controlled selector in those blocks.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `apps/desktop-v2`
  - *How:* `exactOptionalPropertyTypes: true`
  - *How:* `prop?: T | undefined`
  - *How:* `undefined`
  - *How:* `pane={cond ? value : undefined}`
  - *How:* `useFileWorkspace`
  - *How:* `ReturnType<typeof useFileWorkspace>`
  - *How:* `Dispatch<SetStateAction<boolean>>`
  - *How:* `react`
  - *How:* `(v: boolean) => void`
  - *How:* `data-*`
  - *How:* `auto`
  - *How:* `:has(> child[data-*])`
  - *How:* `width: var(--x, fallback)`

<!-- learned-stamp: category=warning; capturedAt=2026-11-26T11:19:50.937Z; skill=testing; applied=1; wins=1 -->
- **Always write desktop-v2 component tests as plain `*.test.ts` using `createElement(...)` from `react` instead of JSX — `apps/desktop-v2/vitest.config.ts` includes only `tests/**/*.test.ts`, so a `.test.tsx` file is silently skipped by the package's own suite even though the root `vitest.config.ts` collects it (run `npx vitest run <file> --config vitest.config.ts` from `apps/desktop-v2` to prove inclusion). When a desktop-v2 jsdom test renders `FileWorkspace` (or anything calling `useFileWorkspace`), mock `../src/platform.js` with `vi.mock` before the dynamic component import: the real `request` rejects outside Tauri, so `FileDraftStore.load` rejects and `openFile` never creates a document — provide an in-memory `fileDraftStorage` (`get` → `{ revision, value: null }`, `save` → bumping revision) and return `{ drafts: [] }` for the `file-drafts.list` method.**
  - *Why:* Known failure mode — skipping this has caused real defects in this codebase. The cost of getting it wrong outweighs the cost of the check.
  - *How:* `*.test.ts`
  - *How:* `createElement(...)`
  - *How:* `react`
  - *How:* `apps/desktop-v2/vitest.config.ts`
  - *How:* `tests/**/*.test.ts`
  - *How:* `.test.tsx`
  - *How:* `vitest.config.ts`
  - *How:* `npx vitest run <file> --config vitest.config.ts`
  - *How:* `apps/desktop-v2`
  - *How:* `FileWorkspace`
  - *How:* `useFileWorkspace`
  - *How:* `../src/platform.js`
  - *How:* `vi.mock`
  - *How:* `request`
  - *How:* `FileDraftStore.load`
  - *How:* `openFile`
  - *How:* `fileDraftStorage`
  - *How:* `get`
  - *How:* `{ revision, value: null }`
  - *How:* `save`
  - *How:* `{ drafts: [] }`
  - *How:* `file-drafts.list`

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-10-20T14:46:47.430Z; skill=bug-hunter; skipped=3; skippedWins=3 -->
- **When auditing glob/path-matching call sites that receive tool-input paths, always check which of `ctx.cwd` / `ctx.workingDir` is passed: file tools resolve relative paths against the mutable `workingDir` (reference: `path.resolve(ctx.workingDir, value)` in `packages/core/src/security/kanban-boundary.ts`; matcher contract in `packages/core/src/skills/skill-path-rules.ts`), so passing launch `ctx.cwd` silently misses nested matches. Match against the sibling caller of the same helper — disagreement between two halves of one feature is the fastest correctness signal.**
  - *Why:* Established convention for this codebase — skipping it risks regressions, merge friction, or out-of-sync state with peers.
  - *How:* `ctx.cwd`
  - *How:* `ctx.workingDir`
  - *How:* `workingDir`
  - *How:* `path.resolve(ctx.workingDir, value)`
  - *How:* `packages/core/src/security/kanban-boundary.ts`
  - *How:* `packages/core/src/skills/skill-path-rules.ts`

---
*Last capture: 2026-11-26T12:41:59.117Z · 3 entries*
