## Version bumps (proven)

- Before reviewing `@wrongstack/*` version bumps, grep `**/package.json` and confirm dependents use `workspace:*` (currently 77 declarations) and packages set `private: true`. Then treat bumps as metadata-only; do not allege resolution, lockfile-specifier, `--frozen-lockfile`, or publish-side breakage without contrary evidence.

## Diff vs disk (proven)

- Re-read each changed file on disk before citing a type mismatch from a supplied diff; hunks can lag the working tree. If a hunk assigns `sessionId: undefined` where it shows `sessionId: string`, report the actual on-disk type — possibly `string | undefined`.

## Grounding and verdicts

- Resolve `ALLOWED` and `INJECTION_SITES` against the filesystem: `rg` each guarded symbol (e.g. `formatProjectSuppliedBlock`) and confirm its site still invokes it; stale entries are silent no-ops. If test imports move from `packages/core/tests/**` to `packages/agent-catalog/src/**`, glob the destination `src/` before clearing coverage.
- Ground each allegation at its path and symbol (e.g. `escapeClosesPanels(event)` at `packages/vibeui/src/components/workspace.tsx:150`); search the owning package’s `tests/` before claiming `GRAPH_HUB_DEGREE` or `traverseSqliteGraph` lacks coverage.
- Before a verdict, run `git status -- <target paths>` and `rg` the feature identifier (e.g. `selectionMode`). Absent plus `aborted_by_parent` means request changes; present but unverified means require verification, not an all-clear.

## Conventions

- Treat `pnpm-workspace.yaml` `overrides:` as authoritative; root `package.json` `overrides` is inert. Attribute lockfile references by importer block.
- Put WS route handlers in `packages/webui-server/src/server/` (e.g. `memory-doctor-handler.ts`) and client methods in `packages/webui/src/lib/ws-client-actions.ts`, never `packages/webui-protocol/src/client-integrations.ts`. Add i18n keys to all seven locales, including `src/i18n/locales/tr/activity.json`.

## Race hot spots

- Trace panel rejection/submission races through `request(...)` in `packages/vibeui/src/lib/use-panel-requests.ts`: it resolves `null`, dedupes by frame type, and cancels via `[state.id, connection]`.
- For `mailbox.send`, cover every `validateMailboxSendPayload` branch (`packages/webui-server/src/server/ws-mailbox-validation.ts`) and require a `mailbox.sent` reply with `requestId` and `success`. For `SessionSwitch` (`packages/vibeui/src/lib/session-switch.ts`), verify `settle`, `cancel`, and timeout each release target, lock, timer, and `held` together.
