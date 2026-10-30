## Proven checks

- [applied 5×, 5 ok] For `@wrongstack/*` version bumps, grep `**/package.json` first: dependents pin `workspace:*` and packages set `private: true`, so a bump is metadata-only — it cannot break resolution, lockfile specifiers, or `--frozen-lockfile` installs. Don't invent lockfile or publish-side findings.
- [applied 3×, 3 ok] Re-read the changed file on disk before citing a type mismatch; diff hunks lag the working tree (one showed `sessionId: undefined` against a `sessionId: string` field already widened to `string | undefined`). Cite the on-disk state, not the snapshot.

## Grounding

- Resolve `ALLOWED` sets and `INJECTION_SITES` against the filesystem: `rg` each guarded symbol (e.g. `formatProjectSuppliedBlock`) to confirm the site still invokes it — stale entries are silent no-ops. When test imports move (`packages/core/tests/**` → `packages/agent-catalog/src/**`), glob the destination `src/` before an all-clear.
- Ground each allegation at its cited path and symbol (e.g. `escapeClosesPanels(event)` at `packages/vibeui/src/components/workspace.tsx:150`); search the owning package's `tests/` before alleging missing coverage of `GRAPH_HUB_DEGREE` or `traverseSqliteGraph`.
- Before the verdict, run `git status -- <target paths>` and `rg` the feature identifier (e.g. `selectionMode`): absent while `aborted_by_parent` is in play → request changes; present but unverified → require verification, never an all-clear.

## Conventions

- `pnpm-workspace.yaml` `overrides:` is authoritative; root `package.json` `overrides` is inert — attribute lockfile references by importer block.
- Put new WS route handlers under `packages/webui-server/src/server/` (e.g. `memory-doctor-handler.ts`) and client methods in `packages/webui/src/lib/ws-client-actions.ts`; never `packages/webui-protocol/src/client-integrations.ts`.
- Add i18n keys to all seven locales, including `src/i18n/locales/tr/activity.json`.
- Before removing `architecture/test-only-exports.json` entries, search for static imports; dynamic access does not count.

## Race hot spots

- Trace panel rejection/submission races through `request(...)` in `packages/vibeui/src/lib/use-panel-requests.ts` — it resolves `null`, dedupes by frame type, and cancels via `[state.id, connection]`.
- For `mailbox.send`, cover every branch of `validateMailboxSendPayload` (`packages/webui-server/src/server/ws-mailbox-validation.ts`) and require a `mailbox.sent` reply carrying `requestId` and `success`.
- For `SessionSwitch` (`packages/vibeui/src/lib/session-switch.ts`), verify `settle`, `cancel`, and timeout each release target, lock, timer, and `held` together.
