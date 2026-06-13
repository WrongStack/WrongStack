# Split `packages/webui/src/server/index.ts` (3,128 lines) into topic dispatchers

**Filed:** 2026-06-13
**Status:** Open
**Priority:** Medium (long-running; partial decomposition already shipped, finishing the rest is the next step)
**Effort estimate:** 4–6 days, sequenced into 7 PRs
**Risk:** High — the file is the WebUI's central WebSocket message dispatcher and zero end-to-end test covers its full message-type matrix today

## Problem

`packages/webui/src/server/index.ts` is 3,128 lines as of the
2026-06-13 `check-file-size.mjs` run (the third of four files in the
repo over 2,000 — `tui/app.tsx: 5,671`, `cli/webui-server.ts: 3,407`,
and `cli/cli-main.ts: 2,424` are the others). The June 5 refactor plan (item 1.3, "Split webui layer")
called for splitting `server/index.ts`, but unlike the other three
giant files, this one is *already partially decomposed* — 16 sibling
modules live under `server/`:

```
server/
  autophase-ws-handler.ts          424 lines
  boot.ts                           35 lines
  collaboration-ws-handler.ts     853 lines
  custom-context-modes.ts          166 lines
  entry.ts                          46 lines
  file-handlers.ts                 245 lines
  file-picker.ts                    74 lines
  http-server.ts                   368 lines
  index.ts                       3,104 lines  ← this file
  instance-registry.ts             159 lines
  lifecycle.ts                      84 lines
  mailbox-handlers.ts              125 lines
  memory-handlers.ts                92 lines
  open-browser.ts                   72 lines
  port-utils.ts                     66 lines
  provider-config-io.ts            106 lines
  provider-handlers.ts             132 lines
  provider-keys.ts                 159 lines
  provider-store.ts                110 lines
  setup-events.ts                  323 lines
  token-estimator.ts               135 lines
  types.ts                          47 lines
  usage-cost.ts                     59 lines
  worktree-ws-handler.ts           167 lines
  ws-auth.ts                       211 lines
  ws-utils.ts                       68 lines
```

What's left in `index.ts` after those extractions:

- the **central `handleMessage` switch** with 3,000+ lines of `case`
  arms covering ~50 distinct WebSocket message types (agent, brain,
  session, worktree, autophase, mailbox, files, memory, goal, plan,
  tasks, todos, tools, fleet, mode, config, cost, token, checkpoint,
  …)
- the boot/serve wiring that composes the sibling handlers
- the `WsServerContext` type that the central switch closes over
  (`sessionRegistry`, `agentStatusTracker`, `brain`, `wpaths`,
  `vault`, `eventBridge`, `broadcast`, …)
- 100+ lines of WS message-payload-type definitions (`type
  AgentMessage = { type: 'agent.…', payload: … }`) that could move
  to a dedicated `messages.ts` schema module

With everything in a single function, every new WebSocket message
type adds 20–100 lines to the same switch, and the closure-captured
`WsServerContext` is referenced from 50+ places — making the
file nearly impossible to refactor without an integration test
harness. Today only `ws-handlers-resume.test.ts`,
`collaboration-ws-handler.test.ts`, `worktree-ws-handler.test.ts`,
`ws-auth.test.ts`, and `ws-utils.test.ts` cover adjacent pieces
in isolation. Nothing exercises the central `handleMessage`
dispatcher end-to-end.

## Why this matters

1. **The decomposition is already 60% done.** The 16 sibling
   modules ship and are individually tested. The remaining 40% is
   the central dispatcher and the boot/serve wiring. Filing this
   issue finishes the work the codebase has clearly been doing for
   months.
2. **The four >2,000-line files are now sequenced.** Of those four,
   `tui/app.tsx` has its tracked refactor
   (`docs/issues/2026-06-13-tui-app-refactor.md`, 8 PRs);
   `cli/cli-main.ts` has its tracked refactor
   (`docs/issues/2026-06-13-cli-main-refactor.md`, 7 PRs);
   `cli/webui-server.ts` has its tracked refactor
   (`docs/issues/2026-06-13-webui-server-refactor.md`, 8 PRs).
   This issue is the **fourth and final** of the H-1 decomposition
   plans — closing it means every file over 2,000 lines has a
   sequenced path to < 500 lines.

## Proposed approach (sequenced, one PR per step)

Same `PR-0 characterization test → extract → verify` template as the
tui-app, cli-main, and webui-server refactors. The decomposition
unit is a **topic dispatcher** under `packages/webui/src/server/`,
following the same naming pattern the file already uses for its
siblings (`*-ws-handler.ts`, `*-handlers.ts`).

### PR 0 — Baseline dispatcher integration test (must come first)

Add a vitest test that opens a real WebSocket connection to a
test-spawned `httpServer`, then sends every documented
WebSocket message type and asserts the dispatcher routes to the
correct sibling handler (using `vi.spyOn` on the handler module's
exported `handleMessage` function). The test should:

- Spawn `httpServer` on port 0 with a stub `WsServerContext`.
- For each message type (`agent.resume`, `brain.ask`, `session.list`,
  `provider.add`, `mailbox.send`, `worktree.list`, `autophase.tick`,
  `files.read`, `memory.remember`, `goal.set`, `plan.add`,
  `tasks.advance`, `todos.toggle`, `tools.list`, `fleet.status`,
  `mode.set`, `config.read`, `cost.compute`, `token.estimate`,
  `checkpoint.list` — i.e. the full ~50-type matrix), open a WS
  client and assert the sibling handler's `handleMessage` was
  called with the expected payload.
- Cover the unknown-message-type path (assert the error response
  shape).

This is the safety net for everything that follows. **All later PRs
must keep this test green and re-run it manually after every
dispatcher extraction.** No test → no extraction.

The June 5 plan didn't include this step; it's the lesson from the
tui-app refactor (2026-06-13): "Big-file refactors need
characterization tests first, not after."

### PR 1 — `server/messages.ts` (low risk)

Extract the inlined `type XxxMessage = { … }` payload definitions
(somewhere around lines 200–400, 100+ lines of types only) into
`server/messages.ts`. Pure type move + re-export from `index.ts`.
This is the same pattern as `tui/src/app-state.ts` from the tui-app
refactor (the issue's "out of scope" note explicitly mentions that
type-only extraction is a separate effort — here we do it as PR 1
to make the dispatcher extractions easier to review).

### PR 2 — `server/dispatch/agent.ts` (medium risk)

Extract the `case 'agent.…':` arms (the longest topic group, ~600
lines) into `server/dispatch/agent.ts` with a
`createAgentDispatcher(ctx: WsServerContext)` factory that returns
`{ handleMessage, canHandle }`. The central switch becomes:

```ts
const dispatchers = [
  createAgentDispatcher(ctx),
  createBrainDispatcher(ctx),
  createSessionDispatcher(ctx),
  // …
];
async function handleMessage(ws, msg) {
  for (const d of dispatchers) {
    if (d.canHandle(msg.type)) return d.handleMessage(ws, msg);
  }
  send(ws, { type: 'error', payload: { phase: 'handleMessage', message: `Unknown: ${msg.type}` } });
}
```

This is the **core extraction**. After this PR, the dispatcher
pattern is established and PRs 3–6 follow the same template. The
`canHandle(msg.type)` check is a string-prefix match
(`msg.type.startsWith('agent.')`) so the central switch doesn't
need to enumerate message types.

Risk: medium because the agent arms share closure-captured
`WsServerContext` state (sessionRegistry, agentStatusTracker,
eventBridge). The `createAgentDispatcher` factory must receive the
context as a parameter; no closure captures.

### PR 3 — `server/dispatch/brain.ts` (low risk)

Extract the `case 'brain.…':` arms (~150 lines) following the
PR-2 template. Brain is a small topic with only a handful of
message types (`brain.ask`, `brain.log`, `brain.config`); the
extraction is mechanical.

### PR 4 — `server/dispatch/session.ts` (low risk)

Extract the `case 'session.…':` arms (~400 lines) following the
PR-2 template. Session is the second-largest topic; it shares
some state with the agent topic (sessionRegistry) so the PR
re-uses the same `WsServerContext` parameter shape.

### PR 5 — `server/dispatch/{plan,tasks,todos,goal,checkpoint}.ts` (low risk)

Extract the planning-adjacent topic groups into a single
`server/dispatch/plan-suite.ts` module since they all read from the
same `planStore` / `taskStore` / `todoStore` /
`checkpointStore` / `goalStore` services. ~500 lines total,
mechanical extraction.

(If the planning topic groups prove unwieldy in one file, split
this into separate `plan.ts` / `tasks.ts` / `todos.ts` /
`goal.ts` / `checkpoint.ts` dispatchers in a follow-up PR.)

### PR 6 — `server/dispatch/{config,mode,cost,token,tools,fleet,mailbox,worktree,autophase,files,memory}.ts` (low risk)

Extract the remaining topic groups into a single
`server/dispatch/misc.ts` module, since each is < 200 lines and
the boilerplate (canHandle / handleMessage factory) dominates over
the per-topic logic. ~1,200 lines total. (If a particular topic
grows past 300 lines, split it into its own dispatcher file in a
follow-up PR.)

### PR 7 — Final pass (low risk)

`index.ts` should be < 250 lines after PRs 2–6: the `WsServerContext`
type, the `WsServer` class, the `handleMessage` switch loop (now
~30 lines), the `startWsServer({ ctx, port, host })` boot body, and
the `WsServerOptions` interface. The dispatcher barrel
`server/dispatch/index.ts` re-exports the per-topic dispatchers.

Add a doc comment to `index.ts` pointing to the dispatcher modules
so contributors know where each message-type group lives.

## Acceptance criteria

- [ ] Baseline integration test (PR 0) added and committed.
- [ ] Each of PRs 1–6 lands with:
  - The targeted topic group in a single module under
    `packages/webui/src/server/dispatch/`.
  - The original `handleMessage` behavior preserved (every
    `case` arm's side effects, response payloads, and
    `sendResult` calls — verified by the integration test's
    full message-type matrix).
  - `pnpm --filter @wrongstack/webui typecheck` clean.
  - `pnpm --filter @wrongstack/webui test` passing (the
    ~4,200-LOC test suite across 33 test files, including
    `collaboration-ws-handler.test.ts: 747 lines`,
    `ws-auth.test.ts: 411 lines`, and the new dispatcher
    integration test).
  - A 30-second manual smoke test: launch
    `node packages/cli/dist/index.js --webui --port 0`, open
    the printed URL, click through every UI panel (agent,
    brain, session, plan, tasks, todos, goal, cost, token,
    fleet, mailbox, worktree, autophase, files, memory), and
    confirm each panel still functions.
- [ ] After PR 7: `index.ts` is < 250 lines and contains only
  the `WsServerContext` type, the `WsServer` class, the
  dispatcher barrel call, and the `startWsServer()` boot body.
- [ ] The June 5 plan's "1.3: split webui layer" exit criteria
  are satisfied: every WebSocket message-type group lives in
  its own `server/dispatch/<topic>.ts` file, with `index.ts`
  as the composition root only.

## Out of scope

- The 16 existing sibling modules under `server/`
  (`autophase-ws-handler.ts`, `file-handlers.ts`,
  `mailbox-handlers.ts`, `provider-handlers.ts`, …) are already
  extracted and individually tested. The dispatcher layer being
  added in this issue is a *new* layer above them, not a
  replacement.
- `cli/webui-server.ts` (3,407 lines) has its own tracked refactor
  (`docs/issues/2026-06-13-webui-server-refactor.md`, 8 PRs).
- `cli/cli-main.ts` (2,424 lines) has its own tracked refactor
  (`docs/issues/2026-06-13-cli-main-refactor.md`, 7 PRs).
- `tui/app.tsx` (5,671 lines) has its own tracked refactor
  (`docs/issues/2026-06-13-tui-app-refactor.md`, 8 PRs).
- The `collaboration-ws-handler.ts: 853 lines` file is itself
  over the 350-line soft cap and may need a future decomposition.
  This issue does not bundle that work; file a separate
  `docs/issues/2026-MM-DD-collab-ws-handler-refactor.md` if/when
  it becomes a bottleneck.

## Rollback strategy

Each PR is its own commit on its own branch. Revert the PR → revert
the behavior. The integration test in PR 0 is the gate; if a later
PR's `handleMessage` dispatch differs from the prior commit by
more than the test allows (handler routing, response payloads, side
effects), that PR is held until parity is restored.

For the bigger PRs (PR 2 in particular) a feature flag is overkill
— the integration test plus the existing
`*-ws-handler.test.ts` / `ws-auth.test.ts` files are the gates. If
both pass unchanged, the PR merges.

## Why I'm not implementing this now

The previous tui-app, cli-main, and webui-server refactors
(2026-06-13) made it clear that a 2,000+ line file in a single
session is too big to hold in mind at once. The same is true of
`webui/src/server/index.ts` — but unlike `tui/app.tsx`, this file
has no test harness for the central `handleMessage` switch, so
the first PR *must* be the baseline dispatcher test, and nothing
else can land until that test is in place.

This issue formalizes the **PR-by-PR** approach so a future
session (or human contributor) can take it on with clear scope
per commit.

## Tracking

When the issue is opened on GitHub, link the 7 PRs to it in
descending order so the timeline is visible. Use the
`refactor/webui-package-server-split` label (proposed).

## Related

- June 5 audit, item 1.3 ("Split webui layer
  `server/index.ts`, `useWebSocket.ts`, `stores/index.ts`") — this
  issue covers `server/index.ts` only. The `useWebSocket.ts` and
  `stores/index.ts` decompositions are separate work.
- 2026-06-13 system audit, finding H-1 ("Four >2,000-line files
  are the gating constraint") — **this issue is the fourth and
  final decomposition plan** called for by that finding. After it
  lands, H-1 is fully tracked across all four files.
- 2026-06-13 tui-app refactor, PR 0 (the characterization-test
  pattern this issue reuses).
- 2026-06-13 cli-main refactor, PR 0 (same pattern, adapted for a
  `main()` composition root).
- 2026-06-13 webui-server refactor, PR 0 (same pattern, adapted
  for a CLI entry that owns the standalone WebUI HTTP/WS server
  boot path).
- 2026-06-13 webui-server refactor, "Out of scope" note (the
  sibling `webui/src/server/index.ts` issue is the file this
  issue is filed for).
- The 16 existing sibling modules under `server/` — see the
  `Problem` section above for the full list. This issue adds a
  *new* dispatcher layer above them; it does not replace them.
