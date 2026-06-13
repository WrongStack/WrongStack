# webui-server Refactor — Status & Remaining Work

Checkpoint for Issue #30 (the `packages/cli/src/webui-server.ts` N-PR
refactor). Update this before switching context, handing off, or resuming.

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
| 5h | ws-handlers/ — **remaining groups** | 🔴 in progress | — |

`webui-server.ts` is ~3000 lines (down from ~3250). The self-contained
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
```

Per-group contexts now extend a small `WsCommon` base (`send`/`broadcast`/
`log`) rather than one shared god-object growing a field per concern. All
contexts are now built **before** the WS connection handler is wired, so a
fast client message can't reach a handler before its context initializes
(fixed a latent TDZ in PR 5g).

A module-map doc comment at the top of `webui-server.ts` points to each.

---

## PR 5h — remaining ws-handler groups (🔴 in progress)

Extracted so far: **providers** (5), **brain** (5b), **introspection**
(5c), **worklist** (5d), **agent-config** (5e), **prefs** (5f),
**projects** (5g) — each fully unit-tested, threaded via a per-group
context extending `WsCommon`. Current reality:

- **Already delegated** — `memory.*`, `files.*`, `mailbox.*`, `shell.open`
  cases already call the shared `@wrongstack/webui/server` handlers. No
  CLI-local extraction to do.
- **Still inline** — the `handleMessage` switch cases for
  `sessions` / `session.*`, `context.*`, plus
  `handleUserMessage`. These
  are coupled to run-loop state (the abort controllers, client map,
  custom-mode store, session writer/store, the session.start payload
  builder, the prefs-snapshot/persist closures) — extract test-first, one
  group at a time, growing each group's context.

**Why deferred (not "forgotten"):** these cases are coupled to ~25 pieces
of run-loop state (`abortController` + `abortControllers`, `clients`,
`pendingConfirms`, `eventUnsubscribers`, `autoPhaseHandler`,
`getCustomModeStore`, `opts.agent`/`events`/`session`/`sessionStore`,
the event bridge, `broadcast`, …) and have **no standalone unit
coverage**. Moving them safely means first growing `WsHandlerContext` to
carry that state explicitly, then extracting one group at a time behind
characterization tests — a dedicated test-first effort, not an
opportunistic move bundled into another PR.

**Suggested approach when picked up:**
1. Pick one cohesive group (sessions is a good first — it's large and
   relatively self-contained around `sessionStore`/`session`).
2. Add a handler-level test that drives the current inline behaviour
   through a real (or faithfully faked) context — lock in the contract.
3. Add the group's dependencies to `WsHandlerContext`.
4. Move the cases into `webui-server/ws-handlers/<group>.ts` as
   `ctx`-threaded functions; the switch case calls them.
5. Repeat. The `WsHandlerContext` + provider group from PR 5 are the
   template.

---

## Notes

- The standalone webui server (`packages/webui/src/server/index.ts`) is a
  near-duplicate that is further along its own extraction (`provider-keys`,
  `provider-config-io`, `lifecycle`, `setup-events`, `ws-utils`, …). It's
  the reference for shapes the CLI side can mirror.
- All extracted modules have unit tests under
  `packages/cli/tests/webui-server/`.
