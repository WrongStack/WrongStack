## Provider claims

- Anchor every provider-architecture claim to `docs/provider-author-guide.md` and `packages/providers/README.md` — together they define the `WireAdapter` / `WireFormatProvider` / `presets/*.ts` split that all of `packages/providers/src/` follows; never infer structure from imports alone. [14×, 14 ok]
- For the `openai` wire family, state both roles explicitly: the registry switch in `packages/providers/src/index.ts` (`case 'openai'`) builds the class-based `OpenAIProvider` from `packages/providers/src/openai.ts`, while `packages/providers/src/presets/openai.ts` is consumed at runtime only by `GitHubCopilotProvider` (`packages/providers/src/github-copilot.ts`, via `super(openaiWireFormat, ...)`). Never present the preset as the runtime transport. [3×, 3 ok]

## Searching and verification

- Run one grep per exact file path and record each path checked in the output, so every negative claim is auditable; never brace-glob (`{a,b}.ts` silently returns zero matches here). [17×, 17 ok]
- Scan build output by enumerating `packages/*/dist` via `glob` with an explicit `path` argument (e.g. `path: packages/providers/dist`, pattern `**/*.js`), then grep each exact file path returned. Never directory-mode grep with `path` set to a dist directory, and never repo-root globs (`packages/*/dist/*.js` returns 0 files): rg honors `.gitignore`'s `dist/` entry, so directory mode returns a false zero while explicit-path globs and explicit-file greps see ignored files. [3×, 3 ok]

## TUI status-bar routing

- Treat `packages/tui/src/components/status-bar.tsx` as a facade exposing only `StatusBar`; route formatting edits to `status-bar-format.tsx`, colors/icons to `status-bar-icons.tsx`, prop types to `status-bar-types.tsx`, and chip construction to `status-bar-rails.tsx`. Its single render site is `AppStatusRegion` in `packages/tui/src/app-status-region.tsx` (mounted by `app-view.tsx`); all importers are package-internal, so never edit the facade for sibling behavior. [6×, 6 ok]

## Report payloads

- Keep `submit_result` `summary`/`findings`/`suggested_next_steps` as flat arrays of plain-ASCII strings using only commas and periods. The `coordination.result.submit` validator rejected reports containing em-dashes or parentheses, and rejected an entry it parsed as a nested structure (nested arrays, objects, JSON-like punctuation, "to"/"lines" phrasing); identical content passed after ASCII-only sanitization. [4×, 3 ok]
- Treat `reports/*.md` as standalone audit documents with no exports or programmatic callers; before citing one, re-verify its counts and file paths with a fresh search rather than trusting them as current. [2×, 2 ok]
