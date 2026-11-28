## Version bumps (proven)

- Before reviewing `@wrongstack/*` bumps, grep `**/package.json` and confirm dependents use `workspace:*` (currently 77 declarations) and packages set `private: true`. Then treat bumps as metadata-only; allege no resolution, lockfile-specifier, `--frozen-lockfile`, or publish-side breakage without contrary evidence.

## Diff vs disk (proven)

- Re-read each changed hunk with a narrow `read` offset before citing a line or type — mandatory in `packages/webui-server/src/server/**` and any file the Chronicle shows as concurrently agent-edited. Trust the offset-read's numbering: whole-file snapshots lag disk (371 vs 375 lines) and shift every citation.
- Report the on-disk type, not the hunk's: `sessionId: undefined` assigned where the diff shows `sessionId: string` is likely `string | undefined`.

## Grounding and verdicts

- Resolve `ALLOWED` and `INJECTION_SITES` against the filesystem: `rg` each guarded symbol (`formatProjectSuppliedBlock`) and confirm its site still invokes it; stale entries are silent no-ops. When test imports move from `packages/core/tests/**` to `packages/agent-catalog/src/**`, glob the destination `src/` before clearing coverage.
- Ground allegations at path and symbol (`escapeClosesPanels(event)` at `packages/vibeui/src/components/workspace.tsx:150`); search the owning package's `tests/` before claiming `GRAPH_HUB_DEGREE` or `traverseSqliteGraph` lacks coverage.
- Before a verdict, run `git status -- <target paths>` and `rg` the feature identifier (`selectionMode`). Absent plus `aborted_by_parent` → request changes; present but unverified → require verification, never an all-clear.

## Conventions

- `pnpm-workspace.yaml` `overrides:` is authoritative; root `package.json` `overrides` is inert. Attribute lockfile references by importer block.
- WS route handlers belong in `packages/webui-server/src/server/` (`memory-doctor-handler.ts`), client methods in `packages/webui/src/lib/ws-client-actions.ts` — never `packages/webui-protocol/src/client-integrations.ts`. Add i18n keys to all seven locales, including `src/i18n/locales/tr/activity.json`.

## Race hot spots

- Trace panel rejection/submission races through `request(...)` in `packages/vibeui/src/lib/use-panel-requests.ts`: resolves `null`, dedupes by frame type, cancels via `[state.id, connection]`.
- For `mailbox.send`, cover every `validateMailboxSendPayload` branch (`packages/webui-server/src/server/ws-mailbox-validation.ts`) and require a `mailbox.sent` reply carrying `requestId` and `success`. For `SessionSwitch` (`packages/vibeui/src/lib/session-switch.ts`), verify `settle`, `cancel`, and timeout each release target, lock, timer, and `held` together.

## TUI async pitfalls

- In `packages/tui/**`, when `typeof host.X === 'function' ? host.X() : host.X` resolves inline in the render body and feeds a `useCallback`/`useEffect` dependency, confirm the accessor memoizes; report that precondition rather than asserting a loop (a per-render instance re-fires the effect on every Ink repaint).
- Before crediting an overlay's async success message, check whether the awaited helper swallows its error into shared state the caller overwrites: `setStatusMessage(...)` after `await refresh()` discards reload failure and shows stale data as confirmed.
