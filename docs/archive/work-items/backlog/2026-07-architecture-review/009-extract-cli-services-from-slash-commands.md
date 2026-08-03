# Move shared logic out of `packages/cli/src/slash-commands/` into service modules

**Labels**  
`refactor` `architecture` `cli` `tech-debt`

## Summary

Shared runtime behavior must remain independent of slash-command adapters.

## Why this matters

This leaks command-layer structure into general runtime code and makes CLI internals harder to evolve cleanly.

## Scope

Create a shared service layer for reusable logic currently living under `slash-commands/`.

## Acceptance criteria

- [x] Introduce `packages/cli/src/services/` or equivalent shared layer
- [x] Reduce the temporary slash-command importer allowlist
- [x] No new non-command slash-command imports are introduced
- [x] At least 3 existing shared logic callsites are migrated

## Completion evidence (2026-07-22)

The temporary 13-file exception was removed rather than reduced. Shared owners
now cover autonomy vocabulary, statusline configuration, suggestions, project
manifests, commit-message generation, dispatch classification, MCP management,
and SDD state/artifact/task services. Slash modules retain thin compatibility
exports where public tests or consumers still use their historical paths.

The 71 command adapters now depend on a leaf `command-context.ts` contract
instead of importing their own command catalog; this removed the entire
slash-command type SCC. Architecture verification reports zero runtime cycles,
zero non-command slash imports, and one fewer type cycle, and now fails any new
reverse import automatically. CLI typecheck and the full 250-file / 3,204-test
CLI suite pass (two opt-in files and 12 tests remain skipped).

## Suggested implementation notes

- Extract logic, not command UX.
- Keep slash-command modules thin adapters over shared services.

## Effort

Estimated: **2–4 days**
