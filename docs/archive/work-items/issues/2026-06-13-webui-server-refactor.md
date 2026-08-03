# Split `packages/cli/src/webui-server.ts` (3,407 lines) into focused modules

**Filed:** 2026-06-13
**Status:** Open
**Priority:** Medium (long-running, blocked on the integration test for `--webui` mode)
**Effort estimate:** 5–7 days, sequenced into 8 PRs
**Risk:** High — the file owns the standalone WebUI HTTP/WS server boot path and zero end-to-end test covers its CLI entry shape today

## Problem

`packages/cli/src/webui-server.ts` is 3,407 lines (the second-largest
of four files in the repo over 2,000 — `tui/app.tsx: 5,671`,
`webui/server/index.ts: 3,104`, and `cli/cli-main.ts: 2,424` are the
others). The June 5 refactor plan (item 1.2) called for splitting
the equivalent legacy file (`cli/index.ts`) but no PRs have landed
yet. The single default-exported function in this file (`start()` at
line ~800) now contains:

- a custom `Logger` shim that wraps structured logs into a
  non-`@wrongstack/core` shape (lines 80–111)
- a parallel set of token / cost helpers (`estimateContextBreakdown`,
  `getCostRates`, `computeCost`, `maskedKey`, ~200 lines) that have
  already been partially extracted to `@wrongstack/webui/server` per
  the file's own header comment at line 40–45, with explicit
  acknowledgement that "Phase 2 of the refactor plan continues this
  pattern for the rest of the file"
- ~25 inline WebSocket message handlers (`handleProviderAdd`,
  `handleProviderKeyAdd`, `handleSessionList`, …) covering
  provider CRUD, session enumeration, mailbox ops, and worktree ops
- the `dist` discovery + static-serve wiring that reuses
  `@wrongstack/webui/server` primitives but re-implements enough
  pieces to be its own subsystem
- a `createRequire('webui/server')` polyglot that bridges ESM and
  CJS-resolution for the React bundle
- its own provider-config IO (`loadSavedProviders`, `saveProviders`,
  `writeKeysBack`, `normalizeKeys`) that duplicates
  `provider-config-io.ts` from the webui package

With everything in a single file, the 2,400+ lines of WebSocket
handler bodies share closure-captured mutable state (`providers`,
`sessionRegistry`, `agentStatusTracker`, `vault`, `wpaths`,
`eventBridge`) and have no test harness — only
`webui-server-fleet.test.ts`, `webui-server-frontend.test.ts`,
`webui-server-mailbox.test.ts`, `webui-server-projects.test.ts`,
`webui-server-redaction.test.ts` cover specific handler call paths
in isolation. Nothing exercises the end-to-end `start()` boot shape.

## Why this matters

1. **The decomposition is already half-done.** The token-estimator
   was extracted to `@wrongstack/webui/server` (the `estimateTokens`
   / `messageTokens` / `messagePreview` / `stringifyContent` import
   at line 46–51). The file's own header calls out "Phase 2 of the
   refactor plan continues this pattern for the rest of the file."
   The work is acknowledged in source but unsequenced in issues.
   That's worse than not starting — contributors can pick the
   obviously-easy extractions (the inlined `estimateContextBreakdown`
   at line 126, the `getCostRates` at line 173, the masking helpers
   at line 200–300) without knowing which other block is the right
   one to attack next.
2. **The `cli-main.ts` and `webui-server/index.ts` issues are
   siblings.** Of the four >2,000-line files, only `tui/app.tsx` has
   a tracked refactor plan today (the tui-app-refactor issue, 8 PRs);
   this issue and the webui-server/index.ts issue are the remaining
   two-thirds of H-1. Filing them with sequenced PRs closes the
   loop on the system audit's H-1 finding.

> **H-1 progress 2026-06-13:** of the 24 H-1 PRs across
> the three issues, **6/24 have merged** — this issue
> accounts for 4 (PR 0-3 → #50, #51, #52, #53), the
> tui-app-refactor issue for 2 (PR 0 + PR 1b → #24,
> #27). The webui-package-server issue (#31) has not
> started yet.

## Proposed approach (sequenced, one PR per step)

Same `PR-0 characterization test → extract → verify` template as the
tui-app and cli-main refactors. `webui-server.ts` is a CLI entry that
delegates to a server module, so the extraction unit is a **server
sub-module** under `packages/cli/src/webui-server/` (matching the
naming convention the file already implies).

### PR 0 — Baseline boot-shape integration test (must come first)

Add a vitest test that invokes `start({ port: 0, host: '127.0.0.1' })`
with a stub `ProviderConfig`, a stub `vault`, and a stub
`SessionRegistry`. The test should:

- Call `start()` with `process.env['WSTACK_WEBUI_INSPECT'] = '1'`
  and assert it returns a JSON-serializable handle describing the
  bound port, the WebSocket upgrade path, and the registered
  handler names.
- Call `start()` with a stub `WebSocket` that sends each
  `provider.add` / `provider.key.add` / `session.list` message and
  assert the stub `sendResult` is called with the expected payload.
- Snapshot the public API surface (`start`, `isLoopbackBind`,
  `tokenMatches`) that other modules import — call it with the same
  inspect flag and assert no signature changes.

This is the safety net for everything that follows. **All later PRs
must keep this test green and re-run it manually after every phase
extraction.** No test → no extraction.

The June 5 plan didn't include this step; it's the lesson from the
tui-app refactor (2026-06-13): "Big-file refactors need
characterization tests first, not after."

> **Status 2026-06-13:** merged as PR #53. The shipped
> scope is narrower than the original sketch:
> - the export is `runWebUI` (not `start`) — the plan
>   body referred to the function by a working name
>   that never landed.
> - the `WSTACK_WEBUI_INSPECT` env flag was *not*
>   introduced in this PR; the boot shape is pinned by
>   direct `runWebUI` invocation and a `session.start`
>   round-trip over a real WebSocket.
> - port pinning was removed — `findFreePort` increments
>   on collision, so the test reads the actual bound
>   port from `onListening.info.wsPort` rather than
>   asserting a specific value.
> - three test cases (API surface, boot→ws→session.start,
>   onListening host) — 53ms total.

### PR 1 — `webui-server/logger-shim.ts` (low risk)

Extract the inlined `Logger` shim (lines 80–111) into
`packages/cli/src/webui-server/logger-shim.ts`. Pure move +
named-export; no behavior change. The shim is a stand-in for the
real `Logger` while this CLI module is consumed by other CLI
modules that don't import the full `@wrongstack/core` tree. Make
that comment explicit in the new file.

> **Status 2026-06-13:** merged as PR #50. The shim
> was extracted to `webui-server/logger-shim.ts` with
> 7 unit tests. `webui-server.ts` is 20 lines shorter.

### PR 2 — `webui-server/cost-helpers.ts` (low risk)

Extract `getCostRates`, `computeUsageCost` (the inlined
"Cost computation helpers" block at lines 137–180) into
`webui-server/cost-helpers.ts`. These are pure functions over the
`CostRates` / `TokenUsage` interfaces — they are testable in
isolation and have no shared closure state.

> **Update 2026-06-13 (after PR #51):** the plan body
> originally listed `maskedKey` in this PR. The function
> does not exist in `webui-server.ts` (it was removed in
> an earlier cleanup), so PR #51 shipped with
> `getCostRates` + `computeUsageCost` only. `maskedKey` is
> not part of this refactor; if a future helper needs
> similar masking, it should land in a dedicated
> `webui-server/redaction.ts` module (PR 6) instead of
> this one.

This PR pairs with the file's own header note: "Phase 2
of the refactor plan continues this pattern for the rest
of the file."

### PR 3 — `webui-server/context-breakdown.ts` (low risk)

Extract `estimateContextBreakdown` (lines 93–135, the
"context breakdown" block) into
`webui-server/context-breakdown.ts`. The function consumes
`estimateTokens` / `messageTokens` / `messagePreview` from
`@wrongstack/webui/server` and stitches them into a single report.

> **Update 2026-06-13 (after PR #52):** the plan body
> listed lines 126–155. After PR 1 + PR 2 removed the
> logger shim and the cost helpers, the context-breakdown
> block was at lines 93–135 when PR #52 shipped. The
> extraction was straightforward: 7 unit tests, 0
> regressions. The `PromptBlock` / `ToolLike` /
> `MessageLike` interfaces are now re-exported from
> `context-breakdown.ts` so call sites in
> `webui-server.ts` keep their import shape.

After this PR, only the report-shape concerns live here; the
underlying token math lives in `@wrongstack/webui/server`. The two
implementations are no longer "drifting apart" — they're
correctly layered.

### PR 4 — `webui-server/provider-config.ts` (low risk)

Extract `loadSavedProviders`, `saveProviders`, `writeKeysBack`,
`normalizeKeys` (the provider-config IO block at lines ~2,400–2,800)
into `webui-server/provider-config.ts`. The file already imports
`provider-config-io.ts` from the webui package for some
operations; the new module wraps both the inlined and the imported
helpers behind a single `ProviderConfigStore` interface so callers
stop caring which is which.

Risk: medium because `provider-keys.ts` from the webui package
already exists. The two implementations may silently diverge if
not careful. The new module should *re-export* the webui-package
implementation where they overlap and *only* contain genuinely
CLI-specific extras (`writeKeysBack`'s `addKey` semantics,
`normalizeKeys`'s migration logic).

> **Update 2026-06-13 (after PR #55):** the plan body listed
> `writeKeysBack` and `normalizeKeys` in this PR. These two
> functions are *already* imported from
> `packages/cli/src/provider-config-utils.js` (not inlined in
> `webui-server.ts`), so PR #55 extracted only the inlined
> helpers (`loadSavedProviders`, `saveProviders`, `getVault`)
> and did not move them. If a future PR needs to dedupe the
> import path (e.g. wrap them behind a single
> `ProviderConfigStore` interface), it should land as a
> follow-up to PR 4.

> **Update 2026-06-13 (after PR #55):** the plan body listed
> `writeKeysBack` and `normalizeKeys` in this PR. These two
> functions are *already* imported from
> `packages/cli/src/provider-config-utils.js` (not inlined in
> `webui-server.ts`), so PR #55 extracted only the inlined
> helpers (`loadSavedProviders`, `saveProviders`, `getVault`)
> and did not move them. If a future PR needs to dedupe the
> import path (e.g. wrap them behind a single
> `ProviderConfigStore` interface), it should land as a
> follow-up to PR 4.

### PR 5 — `webui-server/ws-handlers/` directory (medium risk) 🔥

This is the **core extraction**. The 25+ inline `handleXxx` WebSocket
handlers (lines ~2,800–3,300) move into
`packages/cli/src/webui-server/ws-handlers/<topic>.ts`, grouped by
topic:

```
webui-server/ws-handlers/
  providers.ts      — handleProviderAdd, handleProviderKeyAdd, … (~400 lines)
  sessions.ts       — handleSessionList, handleSessionGet, …      (~300 lines)
  mailbox.ts        — handleMailboxSend, handleMailboxRead, …      (~200 lines)
  worktree.ts       — handleWorktreeList, handleWorktreeCreate, …  (~200 lines)
  memory.ts         — handleMemoryList, handleMemoryRemember, …    (~200 lines)
  index.ts          — barrel: `registerAllHandlers(wsServer, ctx)` (~50 lines)
```

After this PR, `webui-server.ts` is a composition root: it boots the
HTTP server, the WebSocket server, and calls
`registerAllHandlers(wsServer, { providers, sessionRegistry, … })`.
Adding a new WS message type becomes "edit one file in
`ws-handlers/`", not "scroll to the right line in a 3,400-line
file."

Risk: high because the handlers share closure-captured state
(`providers`, `vault`, `wpaths`, `eventBridge`, `broadcast`). The
`registerAllHandlers` factory must receive all shared state as a
`WsHandlerContext` parameter; no closure captures.

### PR 6 — `webui-server/static-serve.ts` (low risk)

Extract the `dist` discovery + SPA fallback + content-type mapping
into `webui-server/static-serve.ts`. The file already consumes
`createHttpServer` from `@wrongstack/webui/server` for the
path-traversal guard and CSP logic; the new module layers CLI-
specific concerns on top (custom `distDir` resolution, the
`createRequire('webui/server')` polyglot, the React-bundle
hash-busting).

### PR 7 — `webui-server/lifecycle.ts` (low risk)

Extract the SIGINT/SIGTERM shutdown handling, the `instance-
registry` register/unregister, and the `openBrowser` orchestration
into `webui-server/lifecycle.ts`. After this PR, `webui-server.ts`
contains only the top-level `start()` body: ~150 lines that read as
"boot static serve → boot ws server → register handlers → wait for
shutdown signal."

### PR 8 — Final pass (low risk)

`webui-server.ts` should be < 200 lines after PRs 1–7: just the
`start()` function, its re-exports of the public API, and a doc
comment pointing to the seven `webui-server/*.ts` modules so
contributors know where each concern lives. The `Logger` re-export
keeps its public surface; the cost/token helpers and the WS
handlers stop being importable directly from this file.

## Acceptance criteria

- [ ] Baseline integration test (PR 0) added and committed.
- [ ] Each of PRs 1–7 lands with:
  - The targeted code in a single module under
    `packages/cli/src/webui-server/` (or its `ws-handlers/`
    subdirectory).
  - The original WS server behavior preserved (message types,
    handler dispatch, side effects — verified by the integration
    test).
  - `pnpm --filter @wrongstack/cli typecheck` clean.
  - `pnpm --filter @wrongstack/cli test` passing (the
    ~17,000-LOC CLI test suite plus the 5 existing
    `webui-server-*.test.ts` files plus the new integration test).
  - A 30-second manual smoke test: launch
    `node packages/cli/dist/index.js --webui --ws-port 0`, open the
    printed `http://127.0.0.1:<port>/` URL, send one provider-add
    WS message via the browser devtools, and confirm the WebUI
    renders the new provider.
- [ ] After PR 8: `webui-server.ts` is < 200 lines and contains
  only the `start()` function and the public API re-exports.
- [ ] The June 5 plan's "1.2: split cli/index.ts" exit criteria
  are satisfied: every WebUI server concern lives in its own
  `webui-server/<name>.ts` file, with `webui-server.ts` as the
  composition root only.

## Out of scope

- `webui/src/server/index.ts` (3,104 lines) is the sibling
  decomposition. File `docs/issues/2026-MM-DD-webui-package-server-refactor.md`
  using the same template; do not bundle it here. Note: the
  sibling has *already* been partially decomposed into 16
  `*-handlers.ts` / `*-ws-handler.ts` modules, so its extraction
  pattern is different (extract the remaining composition blocks,
  not the entire file).
- `cli/cli-main.ts` (2,424 lines) has its own tracked refactor
  (`docs/issues/2026-06-13-cli-main-refactor.md`, 7 PRs).
- `tui/app.tsx` (5,671 lines) has its own tracked refactor
  (`docs/issues/2026-06-13-tui-app-refactor.md`, 8 PRs).
- The cost/token-helper *drift* between this file and
  `@wrongstack/webui/server/usage-cost.ts` is a separate audit;
  once this issue closes, the two implementations should be
  identical.

## Rollback strategy

Each PR is its own commit on its own branch. Revert the PR → revert
the behavior. The integration test in PR 0 is the gate; if a later
PR's WS message handling differs from the prior commit by more than
the test allows (handler dispatch table, response payloads, side
effects), that PR is held until parity is restored.

For the bigger PRs (PR 5 in particular) a feature flag is overkill
— the integration test plus the existing
`webui-server-*.test.ts` files are the gates. If both pass
unchanged, the PR merges.

## Why I'm not implementing this now

The previous tui-app refactor (2026-06-13 morning) made it clear
that a 2,000+ line file in a single session is too big to hold in
mind at once. The same is true of `webui-server.ts` — and unlike
`tui/app.tsx`, this file has no test harness for the `start()` boot
path, so the first PR *must* be the baseline integration test, and
nothing else can land until that test is in place.

The file's own header at line 40–45 acknowledges the
decomposition is in progress ("Phase 2 of the refactor plan
continues this pattern for the rest of the file") but stops short
of sequencing the steps. This issue formalizes the **PR-by-PR**
approach so a future session (or human contributor) can take it on
with clear scope per commit.

## Tracking

When the issue is opened on GitHub, link the 8 PRs to it in
descending order so the timeline is visible. Use the
`refactor/webui-server-split` label (proposed).

## Related

- June 5 audit, item 1.2 ("Split cli/index.ts and sdd.ts") —
  sdd.ts was already split; cli/index.ts is the legacy name for
  `cli-main.ts`. `webui-server.ts` is a third file that the June 5
  audit implicitly bundled with `cli/index.ts` but is actually
  a distinct subsystem.
- 2026-06-13 system audit, finding H-1 ("Four >2,000-line files
  are the gating constraint") — this issue is two of the three
  decomposition plans called for by that finding.
- 2026-06-13 tui-app refactor, PR 0 (the characterization-test
  pattern this issue reuses).
- 2026-06-13 cli-main refactor, PR 0 (same pattern, adapted for a
  `main()` composition root instead of an HTTP+WS server).
- 2026-06-13 webui-package-server refactor, PR 0 (sibling issue
  for `webui/src/server/index.ts`; the same H-1 finding, the
  remaining third of the four).
- `docs/notes/bugs.md` finding C-2 ("WebSocket Auth Token
  Exposed in URL Query String") — the cookie-based WS auth
  delivery described in this issue's `Related` section
  references the WS upgrade path that this file owns.
