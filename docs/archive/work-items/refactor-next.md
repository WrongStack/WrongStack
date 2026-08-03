# webui-server Refactor — Status (Issue #30 COMPLETE ✅)

Checkpoint for Issue #30 (the `packages/cli/src/webui-server.ts` N-PR
refactor). **All planned PRs are merged** — every self-contained concern,
and every `handleMessage` ws-handler group, now lives in a focused
`webui-server/*` module. `handleMessage` is a pure router. This doc is kept
as the historical map; there is no remaining extraction work.

## Completed status

| PR | Module / concern | Status | PR # |
|----|------------------|--------|------|
| 0  | Baseline integration test | ✅ merged | #53 |
| 1  | logger-shim.ts | ✅ merged | #50 |
| 2  | cost-helpers.ts | ✅ merged | #51 |
| 3  | context-breakdown.ts | ✅ merged | #52 |
| 4  | provider-config.ts (IO) | ✅ merged | #55 |
| 4f | **ProviderConfigStore facade** (PR 4 follow-up) | ✅ merged | #60 |
| 6  | static-serve.ts (+ unit tests) | ✅ merged | #57 |
| 5  | ws-handlers/ — **provider group** | ✅ merged | #58 |
| 7  | lifecycle.ts | ✅ merged | #59 |
| 8  | Final pass (module-map header + this doc) | ✅ merged | #61 |
| 5b | ws-handlers/ — **brain group** | ✅ merged | #62 |
| 5c | ws-handlers/ — **introspection group** | ✅ merged | #63 |
| 5d | ws-handlers/ — **worklist group** (todos/tasks/plan) | ✅ merged | #64 |
| 5e | ws-handlers/ — **agent-config** (modes/model) | ✅ merged | #65 |
| 5f | ws-handlers/ — **prefs** (prefs/autonomy.switch) | ✅ merged | #66 |
| 5g | ws-handlers/ — **projects** (list/select/add/working_dir) | ✅ merged | #67 |
| 5h | ws-handlers/ — **context** (clear/debug/compact/repair/modes) | ✅ merged | #68 |
| 5i | ws-handlers/ — **process** (list/kill/killAll) | ✅ merged | #69 |
| 5j | ws-handlers/ — **sessions** (goal.get/sessions.list/session.*) | ✅ merged | #70 |
| 5k | ws-handlers/ — **connection** (user_message/abort/ping/tool.confirm_result) | ✅ merged | #71 |

`webui-server.ts` is ~2070 lines (down from ~3250). The self-contained
concerns now live under `packages/cli/src/webui-server/`:

```
webui-server/
  logger-shim.ts        — console→Logger adapter            (PR 1)
  cost-helpers.ts       — token/usage cost math             (PR 2)
  context-breakdown.ts  — context-window estimation         (PR 3)
  provider-config.ts    — provider IO + ProviderConfigStore (PR 4 + 4f)
  static-serve.ts       — dist discovery + HTTP bring-up    (PR 6)
  lifecycle.ts          — registry / ready+open / shutdown  (PR 7)
  ws-handlers/
    index.ts            — WsCommon + per-group contexts + barrel (PR 5/5b/5c)
    providers.ts        — provider/model/key handlers       (PR 5)
    brain.ts            — brain.status/risk/ask handlers     (PR 5b)
    introspection.ts    — skills/tools/diag/stats snapshots  (PR 5c)
    worklist.ts         — todos/tasks/plan handlers          (PR 5d)
    agent-config.ts     — modes/mode.switch/model.*          (PR 5e)
    prefs.ts            — prefs.get/update, autonomy.switch   (PR 5f)
    projects.ts         — projects.list/select/add, working_dir (PR 5g)
    context.ts          — context.clear/debug/compact/repair/modes (PR 5h)
    process.ts          — process.list/kill/killAll           (PR 5i)
    sessions.ts         — goal.get/sessions.list/session.*     (PR 5j)
    connection.ts       — user_message/abort/ping/tool.confirm_result (PR 5k)
```

Per-group contexts now extend a small `WsCommon` base (`send`/`broadcast`/
`log`) rather than one shared god-object growing a field per concern. All
contexts are now built **before** the WS connection handler is wired, so a
fast client message can't reach a handler before its context initializes
(fixed a latent TDZ in PR 5g).

A module-map doc comment at the top of `webui-server.ts` points to each.

---

## ws-handlers extraction — COMPLETE

All eleven groups are extracted, each fully unit-tested and threaded via a
per-group context extending `WsCommon`: **providers** (5), **brain** (5b),
**introspection** (5c), **worklist** (5d), **agent-config** (5e), **prefs**
(5f), **projects** (5g), **context** (5h), **process** (5i), **sessions**
(5j), **connection** (5k).

- **Delegated, not extracted** — `memory.*`, `files.*`, `mailbox.*`,
  `shell.open` call the shared `@wrongstack/webui/server` handlers directly.
  There was never CLI-local code to move for these.
- **`connection` (5k)** was the last and was expected to be the riskiest
  (it owns the per-socket abort controllers + the pending-confirm map and
  drives `agent.run`). In practice the four cases only touch
  `abortControllers`, `pendingConfirms`, and `opts.agent` — so they moved
  cleanly behind a `ConnectionContext` that shares those two maps by
  reference with the connection/close handlers, plus `opts` by reference so
  `user_message` runs the live (post-project-switch) agent. 10 unit tests
  cover overlap-rejection, result/error mapping, per-socket abort scoping,
  ping, and confirm-resolve.

`handleMessage` is now a pure router: every case unpacks its payload and
calls a `handleXxx(ctx, …)`. The per-group contexts are all built before
the WS connection handler is wired (TDZ-safe). The template to follow for
any future ws message is: add the handler to its topic file, export it
through `ws-handlers/index.ts`, add a router case.

---

## Notes

- The standalone WebUI server (`packages/webui/src/server/index.ts`) is a
  near-duplicate that is further along its own extraction (`provider-keys`,
  `provider-config-io`, `lifecycle`, `setup-events`, `ws-utils`, …). It's
  the reference for shapes the CLI side can mirror.
- All extracted modules have unit tests under
  `packages/cli/tests/webui-server/`.
