## Disambiguating doc names that collide with packages

- Before treating a bare term as evidence, check whether it doubles as a workspace package. `docs/techstack.md` and `packages/techstack` coexist, so an unanchored grep for `techstack` drowns in `pnpm-lock.yaml` noise and `.wrongstack/atlas/*` manifests. Grep the filename suffix instead: `techstack\.md`. Apply the same suffix-anchoring whenever a doc basename matches a package name.

## Before claiming a docs path is generated

- Anchor any writer/regenerator claim in the slash-command source (`packages/cli/src/slash-commands/techstack.ts`), not in the doc's own prose.
- The `/techstack` command writes to the project root. A file under `docs/` is therefore curated by hand, not regenerated in place — never describe it as command output without showing the write path that lands there.
- If no command writes to the path you found, say the file is curated rather than asserting it is stale or auto-managed.
