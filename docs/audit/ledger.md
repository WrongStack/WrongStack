# Audit ledger

Status per module. `—` means not started.

| Layer | Module | Status | Findings | Commit |
| --- | --- | --- | --- | --- |
| L0 | `persistence` | done | 1 critical | pending (see note) |
| L0 | `governance` | done | 8 (4 high, 1 correctness, 1 perf, 1 lifecycle, 1 minor) | pending (see note) |
| L1 | `kanban` | done | 3 (2 high, 1 business logic) | pending (see note) |
| L2 | `core/*` | breadth done + 12 deep reads | 4 (3 business logic, 1 memory) | pending (see note) |
| L3 | 12 packages | breadth pass done — battery clean | 0 | — |
| L4 | `runtime`, `sdd`, `*-mcp` | done — battery + sdd deep read | 1 (business logic) | pending (see note) |
| L5 | server/hq/simpleui/tui | breadth done; `webui` deferred (active WIP) | 0 | — |
| L6 | `cli` | breadth + safe hotspots done; auth surface deferred (foreign WIP) | 0 | — |

> **Commits are deferred.** Another session is editing `packages/webui` in this
> worktree, and the pre-commit hook refuses to regenerate the Core API snapshot
> while snapshot inputs carry unstaged edits. Fixes accumulate in the working
> tree and are committed per module once that work lands. Nothing here is
> staged, so it cannot be swept into the other session's commit.

---

## L0 — `persistence`

Boundary: no workspace dependencies. Consumed by `core` (which re-exports the
primitives from `core/utils/atomic-write.ts`) and `kanban`. Three source files:
`atomic-write.ts`, `socket-path.ts`, `index.ts`.

### AUDIT-001 — `withFileLock` spun forever instead of timing out (critical)

`packages/persistence/src/atomic-write.ts`

Three of the acquisition loop's retry paths reached `continue` without
consulting the deadline and without yielding:

- the stale-lock branch, after an `unlink` that failed;
- the stale-lock branch, when the re-`stat` showed a different mtime;
- the `catch` around `stat`, when stat itself failed.

Two are reachable in ordinary Windows operation — a crashed holder whose lock
file is still open by an AV scanner or another user gives `unlink` → `EPERM`
forever, and a lock file the process cannot `stat` gives `EACCES` forever. In
both cases the loop retried at full speed and `timeoutMs` was never consulted,
so it could not end.

Severity is a hard hang, not a slowdown: every `fs` call in the loop settles as
a microtask, and an unbroken microtask chain starves the event loop entirely.
Reproduced in an isolated process — a 200 ms timer armed before the loop never
fired, and the process had to be killed externally. The lock's own timeout
therefore could not fire either.

Every caller behind this lock hangs with a core pinned: chronicle `journal` and
`metrics-store`, `partition-range-cache`, `knowledge-graph`, `goal/checkpoint`
and `phase-store`, the HQ `event-log`/`simple-log`/`timeseries-store`, the
review finding/report stores, `annotations-store`, and the CLI's
`project-manifest` and `provider-status`.

**Fix.** All contention retries funnel through one `retryAfterBackoff()` that
checks the deadline and sleeps with exponential backoff capped at 100 ms and at
the remaining budget. The `ENOENT` path is treated as forward progress rather
than contention: its first retry stays immediate and deadline-free, so a
`timeoutMs: 0` caller against a not-yet-created directory still acquires, while
a *repeated* `ENOENT` (something removing the directory underneath the retry)
falls into the same backoff.

**Tests.** Four regressions in `tests/atomic-write-branches.test.ts`: an
unremovable stale lock, a permanently failing `stat`, and a vanishing lock
directory all now reject with the bounded timeout error under a capped retry
count; the `timeoutMs: 0` + missing-directory case still acquires.

### Cleared

- `atomicWrite` / `atomicReplaceWithWriter` / `commitTemp` — temp file is
  unlinked on every failure path, the handle is closed in `finally`, the
  permission-narrowing (`opts.mode & existing`) rule is correct and covered.
- `renameWithRetry` — bounded delay table, index guarded before use, and the
  deliberate refusal to fall back to `copyFile` preserves the atomicity
  contract.
- `waitForLockRelease` — watcher is closed on every settle path, `settle` is
  idempotent, and the fallback timer is harmless when it double-fires.
- `socket-path.ts` — pure validation, no state.

### Noted, not changed

The module-level convenience exports cover `atomicWrite`, `ensureDir`, and
`withFileLock` but not `atomicReplaceWithWriter`. `core` is unaffected — it
builds its own primitive set through `createPersistencePrimitives` so it can
inject its structured `FsError`, and re-exports all four. `kanban` does consume
the bare exports (`kanban/src/utils/atomic-write.ts`), so the streaming
replace is simply unavailable to it. That is not a defect in this package, but
it means any `kanban` store that rewrites a whole file must materialize the
replacement as one buffer — carried forward as a memory question for the L1
`kanban` module rather than answered here.

---

## L0 — `governance`

Boundary: no workspace dependencies. Consumed only by `runtime`, through
`governance-bootstrap.ts` and `governance-sanitize.ts` — and from there by the
CLI behind the opt-in `WRONGSTACK_GOVERNANCE_ENV=1` flag. 39 source files.

See the coverage note at the end of this section for what was read line by line
and what was swept by defect class.

### AUDIT-002 — rejecting one bad IPC frame cost ~590 MB (high)

`packages/governance/src/protocol-decoder.ts`

The decoder sits on the untrusted side of the IPC boundary, and its issue list
is serialized straight back into the error response. Two of its validators had
no ceiling, so the cost of *rejecting* an input could vastly exceed the input:

- `capabilityArray` and `runtimeModelCapabilityArray` recorded the
  length-limit violation and then walked the array anyway — unlike
  `arrayValue`, which returns. Each entry produced an `invalid_value` report,
  a duplicate report, and an entry in a `seen` set.
- `issue()` itself had no cap, so nothing stopped the list from outgrowing the
  frame that produced it.

Measured against the transport's own 8 MB frame cap: a 7.6 MB frame whose
`capabilities` array holds ~2 000 000 short strings produced **4 000 000 issue
objects and 590 MB of heap in 465 ms**. That response then goes to
`JSON.stringify` in `encodeGovernanceIpcFrame`, allocating further before
throwing "frame too large", and the failure path in
`authenticated-project-service.ts` decodes the same input a second time through
`service.handleUnknown`, so the peak is roughly doubled.

Reachable by any *authenticated* client — decoding happens after credential
checks — which makes a buggy client as dangerous as a hostile one.

**Fix.** Both capability arrays return once the length is already known to be
invalid, and `issue()` caps the list at 100 with an explicit truncation marker.
Because every issue in the file is created through `issue()`, that one choke
point also bounds `exactKeys`, which had the same shape at lower amplification.
After: 1 issue, ~0 MB.

**Tests.** Three regressions in `tests/protocol-decoder.test.ts` pin that an
oversized capability array yields *only* the length issue (proving the entries
were never walked), the same for model capabilities, and that a 20 000-unknown-
field request truncates at the cap with the marker last.

### AUDIT-003 — quadratic IPC framing on both sides (performance)

`packages/governance/src/project-server.ts`, `packages/governance/src/project-client.ts`

Both sides accumulated with `buffer = Buffer.concat([buffer, chunk])` on every
`data` event, which makes framing quadratic in the frame size. Reaching the
8 MB cap through 64 KB socket reads copies ~524 MB — and because the size check
ran *after* the concat, that whole cost was paid before the frame could be
rejected. A client could burn a core by repeatedly sending junk it knew would
be refused.

An initial guess that checking the size before concatenating would fix this was
wrong, and measuring said so: 524 MB → 516 MB. The cost is in reaching the cap,
not in the last chunk. Holding the chunks and joining once is the actual fix:
**524 MB / 79 ms → 0 MB / 6 ms**.

**Fix.** Both sides keep a chunk array with a running size and concatenate once,
at the delimiter. The delimiter is a single byte and therefore cannot straddle a
chunk boundary, so each chunk is searched on its own. The cap now applies to the
frame rather than to whatever the peer packed in after the delimiter.

### Cleared

- `management-receipt-cache.ts` — the record map is capped (1 024) and TTL-pruned
  on every reserve, and the fingerprint walker carries an explicit depth and node
  budget. No unbounded state.
- `ipc-protocol.ts` — strict envelope shape, bounded credential fields, frame cap
  enforced on encode.
- `attachment-broker-controller.ts` — the timer is cancelled on every exit path,
  `stop()` is ordered so a rotation completing after it cannot re-arm the timer,
  and deleting the current entry while iterating `#pendingRevocations` is safe.
- `project-server.ts` lifecycle — sockets are tracked in a set, destroyed on
  close, and removed by both the `close` and `error` handlers; a failed `start()`
  tears down listener, store, and pending sockets.

### Noted, not changed

- `authenticated-project-service.ts:131` decodes the request, and on failure
  hands the raw input to `service.handleUnknown`, which decodes it a second
  time. With AUDIT-002 fixed this is only wasted CPU on a rejected request, and
  removing it would mean widening the exported surface of `project-service.ts`.
- `GovernanceProjectServer` gives each connection a 10 s *inactivity* timeout,
  so a peer that dribbles one byte every 9 s holds one of the 128 connection
  slots indefinitely. The endpoint directory is created `0700`, so this is
  same-user only — a boundary that is already fully trusted elsewhere — which is
  why it is recorded rather than fixed.
- `#pendingRevocations` grows by one entry per rotation while `revokeGrant`
  keeps throwing. Rotation is on the order of tens of minutes and the controller
  reports `degraded` throughout, so this cannot accumulate meaningfully.

### AUDIT-004 — observation reads had no window and filtered in JavaScript (high)

`packages/governance/src/event-store.ts`, `packages/governance/src/project-service.ts`

`governance_observations` is append-only — its UPDATE and DELETE triggers say so
— and so it grows for the lifetime of a project. Every grant issue, revoke,
expiry and rotation, every attachment-broker lifecycle event, every daemon
shutdown, and all task/tool/evidence traffic lands there. The two read endpoints
did not window that table at all:

- `read_observations` loaded every row for the project, then dropped the audit
  categories in JavaScript;
- `read_audit_observations` loaded every row *with no task filter at all*, then
  kept only the audit categories — materializing the whole table to return the
  minority of it.

Measured against a 100 000-row table with a realistic category mix:

| | rows | heap | time | serialized |
| --- | --- | --- | --- | --- |
| as written | 28 570 | 148 MB | 401 ms | 8.9 MB |
| category filter in SQL | 28 570 | 49 MB | 106 ms | 8.9 MB |
| SQL filter + `LIMIT 100` | 100 | ~0 MB | 1 ms | ~0 MB |

The 8.9 MB response is past the transport's own 8 MB frame cap, so
`encodeGovernanceIpcFrame` throws and the caller gets "response too large".
Past roughly that many observations the endpoints cannot succeed at all: each
attempt spends 148 MB and 400 ms to produce a failure. That is a functional
defect, not only a cost one — and it worsens monotonically, because nothing
ever removes a row.

**Fix.** `readObservations` is replaced by `readObservationsPage`, which takes
the exact category set, a cursor and a limit, and applies all three in SQL. The
category set is passed as an `IN` list built from the closed enum rather than a
`LIKE` on the `capability_grant_`/`daemon_` prefixes — `_` is a single-character
wildcard in `LIKE`, so the prefix form would have silently widened the match.
Both request types gained optional `afterSequence`/`limit`, and the
`observations` result gained `nextAfterSequence`, mirroring the
`read_evidence_candidates` pagination that already existed two cases above in
the same file. The unwindowed read is gone rather than left in place, so it
cannot be reached again.

**Tests.** A store-level regression walks a mixed-category table in disjoint,
ordered pages and asserts the excluded category never leaves SQLite, plus the
empty-category and invalid-limit guards; a service-level regression walks a
five-row feed in two pages and asserts `nextAfterSequence` distinguishes a first
page from a complete answer.

### AUDIT-005 — lease controller kept the process alive and could crash it (live, opt-in)

`packages/governance/src/credential-lease-controller.ts`

Two divergences from its sibling `attachment-broker-controller.ts`, which gets
both right:

- the default scheduler did not `unref()` its timer. A renewal is pending for
  most of a credential's life — ~55 of every 60 minutes at the defaults — so the
  timer would have been the reason a host process could not exit.
- the timer callback ran `void this.rotateNow()` with no `.catch()`. `rotateOnce`
  handles request and validation failures itself, but the work before its own
  `try` (the injected `requestIdFactory`, `now`) and an injected scheduler on the
  retry path can still throw, which from a timer callback becomes an unhandled
  rejection and takes the process down.

**Correction.** This was first recorded as latent, on the grounds that
`GovernanceCredentialLeaseController` is only reachable through
`GovernanceAdminSession` and nothing outside the package constructs one. That
was wrong: `runtime-compatibility.ts` builds the admin session through
`connectGovernanceAdminSession`, which constructs a lease and starts it by
default, and the chain into the product is real —
`packages/cli/src/cli-main-helpers.ts` → `bootstrapGovernanceRuntime`
(`packages/runtime/src/governance-bootstrap.ts`) → `prepareGovernanceCompatibilityRuntime`.
It is gated behind the opt-in `WRONGSTACK_GOVERNANCE_ENV=1` flag, so it is off
by default, but with the flag on it is a live path. See AUDIT-007, which
compounds with it.

### AUDIT-006 — grant listing ordered by locale (correctness, minor)

`packages/governance/src/capability-grant.ts`

`listGrants()` sorted with `localeCompare`, and that order is what the
`list_capability_grants` cursor walks. A cursor is only sound while the order is
stable, and `localeCompare` with no locale argument depends on the host's
default. Both keys are ASCII by construction — an ISO-8601 timestamp and a
`^[A-Za-z0-9_-]{1,128}$` identifier — so a byte-wise comparison is provably the
same order without the dependency (verified: identical output over 10 000 rows).

The expected performance win did not materialize and is recorded as such:
13.2 ms → 10.6 ms per request at the 10 000-grant ceiling. The cost is dominated
by `describe()` materializing every record, not by the comparator. Full
materialization per page remains — noted below rather than restructured.

### Noted, not changed (continued)

- `listGrants()` still materializes all records on every `list_capability_grants`
  request before slicing a page of at most 100, and the cursor lookup is a linear
  `findIndex` over that array. At the 10 000-grant ceiling that is ~11 ms per
  request, so paging the whole set costs about a second of CPU. Fixing it
  properly means an ordered index over the grant map, which is a larger change
  than the measured cost justifies today.

### AUDIT-007 — closing a governed runtime tore down nothing when the revoke failed (high)

`packages/governance/src/runtime-compatibility.ts`

`GovernanceCompatibilityRuntime.close()` stopped the admin session inside the
`.then` branch that required the revoke to have succeeded:

```js
.then((response) => {
  if (response.ok && response.result.type === 'capability_grant_revoked') {
    this.#closed = true;
    adminSession.stop();          // only on success
  }
  ...
})
```

So local teardown was conditional on a *remote* call. The failure that matters
is the ordinary one: closing after the daemon has already gone means the revoke
cannot be delivered at all and the promise rejects, skipping `.then` entirely.
The admin lease was then left running — still holding a renewal timer, still
rotating a `capability_admin` credential for a runtime its owner had closed.

Compounds with AUDIT-005. Before that fix the lease timer was not `unref`ed, so
this combination is what a user actually sees: with `WRONGSTACK_GOVERNANCE_ENV=1`,
a CLI session whose daemon is gone at shutdown could not exit — a renewal timer
up to ~55 minutes out kept the event loop alive, and the code path that was
supposed to cancel it had been skipped.

**Fix.** Teardown moved to `.finally`, so it runs whether the revoke succeeds,
fails, or never reaches the daemon. Stopping the lease only stops *renewal* —
the credential already held stays valid for its own TTL, so a prompt retry of
`close()` can still authenticate, while an abandoned runtime now expires by
itself instead of renewing forever. `#closed` continues to report the remote
outcome rather than the local one, so a failed close is not misreported as a
clean one.

**Test.** A regression in `tests/runtime-compatibility.test.ts` launches a
governed runtime with the lease actually running, kills the daemon, and asserts
that a rejecting `close()` still leaves the lease `stopped` (`stopped_by_owner`)
while `snapshot().closed` stays `false`.

Verified against the pre-fix code rather than assumed: with the `.finally`
teardown removed, the lease is still `scheduled` after `close()`. Every other
test in that file runs with `adminLease: { startLease: false }`, which is why
the lease lifecycle had no coverage and this went unnoticed.

### AUDIT-008 — cycle detection overflowed the stack at the size the protocol allows (correctness)

`packages/governance/src/plan-version.ts`

`findCycle` was a recursive depth-first search that descended once per edge, so
a plan shaped as a single chain recursed as deep as it had steps. The protocol
decoder accepts up to 10 000 steps and 10 000 edges — and measured at exactly
that ceiling, the recursion throws `RangeError: Maximum call stack size
exceeded` (1 000 and 5 000 steps are fine, 10 000 is not).

A plan the protocol accepts therefore could not be validated at all. The
server's catch-all turns the `RangeError` into a `store_failure` response, so
the daemon survives, but the caller is told its store failed rather than that
its plan is too deep — and a genuine cycle at that depth goes unreported.

**Fix.** The same search over an explicit frame stack. The colouring is
unchanged — `visiting` is grey, `visited` is black, `path` is the grey chain a
back edge closes — so the reported cycle path is identical.

**Verification.** A differential harness ran both implementations over 20 000
random graphs (14 830 cyclic, 5 170 acyclic) with zero mismatches, and agreed on
self-loops. At 10 000 steps the old one raises `RangeError` where the new one
returns `null`; adding a back edge from the last step to the first makes it
report the full 10 001-node cycle.

**Test.** A regression in `tests/plan-version.test.ts` validates a 10 000-step
chain without throwing, and asserts that the same chain plus a back edge is
still reported as `cycle_detected` — which also proves the test reaches
`findCycle` rather than short-circuiting on an earlier validation issue.

### Cleared (continued)

- `transition-engine.ts` — the governance state machine holds. The invariant
  that a model cannot admit its own work has no bypass: `completed` is reachable
  only from `ready_to_merge`, which is reachable only from `reviewing`, and both
  reject `actor === 'model'`. Every edge into `authorized` passes the
  authorization guard, the post-authorization states (`blocked`, `verifying`,
  `reviewing`, …) cannot re-enter execution without the execution-grant and
  snapshot facts, and all five terminal states are absorbing.
- `project-daemon.ts` shutdown — `stop()` is written so it cannot reject: every
  `await` carries its own `.catch`, and `process.disconnect()` is guarded by
  `process.connected` in the same synchronous statement. The seven
  `void stop(...)` call sites are therefore safe despite having no `.catch`.
- `daemon-launcher.ts` — the bootstrap handshake removes all three listeners and
  clears its timer on every settle path, and `releaseChild()` disconnects the IPC
  channel and unrefs the child so the daemon outlives its launcher.

### Cleared (verification, persistence and replay)

- `verification-execution-lease.ts` — domain-separated lease id, 32-byte random
  secret, `timingSafeEqual` over fixed-width digests, and a deterministic
  binding hash built from an explicitly ordered object. A corrupted stored hash
  fails closed, because `Buffer.from(bad, 'hex')` yields a shorter buffer and
  the length check rejects before the comparison.
- `verification-ledger-store.ts` transaction discipline — `consume` and `issue`
  both take `BEGIN IMMEDIATE` up front, and *every* early return between the
  begin and the end closes the transaction first, so no failure path leaks an
  open transaction into the next call. Single use is enforced twice: an
  in-transaction consumption lookup and a `UNIQUE` constraint on `lease_id`.
- `verification-ledger-store.ts` canonical replay — reading all events for one
  task is inherent to rebuilding the aggregate, and unlike the observations
  table the event count is bounded by a single task's own lifecycle. Not the
  AUDIT-004 shape.
- `task-aggregate.ts` — replay is strict about revision continuity: the first
  event must be `task_created` at revision 1, and every later event must be
  exactly `aggregate.revision + 1`, so both gaps and duplicates are rejected
  rather than silently folded into state.
- `daemon-metadata.ts` liveness — declaring a daemon `live` requires *both* a
  live owner PID and a reachable endpoint, so PID reuse alone cannot resurrect
  stale metadata; the inverse case (endpoint reachable, owner dead — the zombie
  pipe) is classified `endpoint_invalid` rather than live. The launcher then
  re-checks pid, instanceId and startedAt against the metadata during the
  handshake.
- Validation regexes across the package — all are single-quantifier character
  classes. No nested or adjacent quantifiers, so no catastrophic-backtracking
  shape.
- `deepFreeze` recursion in `protocol-decoder.ts`, `event-store.ts`,
  `verification-ledger-store.ts` and `management-receipt-cache.ts` — unbounded
  in form, but every input reaches it through the decoder's
  `MAX_NESTING_DEPTH = 32` cap. Worth stating explicitly next to AUDIT-008: the
  package has two input ceilings, and only `MAX_ARRAY_ITEMS = 10_000` was large
  enough to turn recursion into a stack overflow. Depth-capped recursion is
  fine; breadth-capped recursion was not.

### Coverage note

"Swept" means different things by risk class, deliberately. Transport, stored
state, process lifecycle and domain rules were read line by line:
`protocol-decoder`, `ipc-protocol`, `ipc-endpoint`, `project-server`,
`project-client`, `management-receipt-cache`, `attachment-broker-controller`,
`capability-grant`, `credential-lease-controller`, `event-store` (read paths),
`runtime-compatibility`, `admin-session` (construction), `transition-engine`,
`plan-version`, `task-aggregate` (replay), `daemon-launcher`, `daemon-metadata`
(liveness), `verification-execution-lease`, `verification-ledger-store`
(transactions), `project-daemon` (shutdown), and the request entry points of
`project-service` / `authenticated-project-service`.

The remaining files are pure validators and serializers — `task-contract`,
`verification-run-contract`, `verification-planner`,
`verification-issuance-coordinator`, `verification-tool-gateway`,
`verification-check-registry`, `verification-check-binding`,
`evidence-candidate`, `autonomy-envelope`, `daemon-protocol`,
`legacy-shadow-adapter`, `workspace-snapshot-fence`, `workflow-state`,
`sanitize`. Those were examined by defect class rather than line by line:
input-derived recursion, catastrophic regex backtracking, uncapped collections,
transaction boundaries, and unreferenced timers. Nothing in that class turned up
after AUDIT-008. If a later finding elsewhere implicates one of them, it gets a
line-by-line read then.

---

## L1 — `kanban` (in progress)

Boundary: depends only on `@wrongstack/persistence`. Consumed by nine packages
including `core`, so defects here propagate widely. 68 source files across
`manager/` (5 861 lines), `verification/` (3 010), `server/` (2 931), plus
`storage.ts`, `types.ts` and `atomicity/` at the root. Two public entry points:
`.` and a test-only `./test-support`.

Swept so far: `storage.ts`.

### AUDIT-009 — an eviction that could not evict, on the event-append path (high)

`packages/kanban/src/storage.ts`

`eventLogState` caches per-board event-log size and line count so an append does
not have to re-read the file to know whether to trim. It is bounded by
`EVENT_LOG_MAX_CACHE_ENTRIES = 128`, enforced by `evictStaleEventLogCache()` —
whose own comment states the intent: *"so a long-lived multi-project CLI process
does not leak one cache entry per (project, board) for the lifetime of the
process."*

It could not do that. It dropped only entries whose backing file had been
deleted (`ENOENT`). Boards are created roughly one per session and nothing
removes them, so in the ordinary case every cached file still exists, nothing
was evictable, and the map grew without limit regardless.

The cost was worse than the leak. Once the map passed 128 the sweep ran on
*every* `appendKanbanEvent`, `stat`ing every entry sequentially — and it ran
inside `withFileLock`, so the time was spent holding a cross-process lock that
other sessions were waiting on. Measured, with every board still present:

| cached boards | time per event append | entries evicted |
| --- | --- | --- |
| 128 | 0.1 ms | 0 |
| 256 | 14.6 ms | 0 |
| 512 | 36.1 ms | 0 |
| 1024 | 51.1 ms | 0 |

**Fix.** `rememberEventLogState()` replaces it. A `Map` iterates in insertion
order, so re-inserting on write makes that order a recency order and eviction is
a bounded drop from the front — no filesystem work on the append path at all,
and the bound actually holds. Dropping a live entry is harmless: the next append
for that board recomputes its line count exactly as a cold process would.

**Test.** A regression in `tests/storage.test.ts` appends across
`EVENT_LOG_MAX_CACHE_ENTRIES + 72` boards whose files all exist, and asserts the
cache sits exactly at the bound — then keeps appending, to both new and
already-cached boards, and asserts it stays there.

### Cleared

- Event-log trimming itself — `EVENT_LOG_MAX_ENTRIES = 10 000` down to
  `EVENT_LOG_TRIM_TO = 5 000`, the whole-file read gated behind a 512 KB size
  threshold, the rewrite done through `atomicWrite`, and the whole thing
  best-effort so a trim failure cannot break event recording.
- `getKanbanPath` / `getKanbanEventsPath` — board ids are validated against
  `^[A-Za-z0-9][A-Za-z0-9_-]*$` *and* the resolved path is checked to stay under
  the kanban directory, so a traversal attempt fails on both counts.
- `readFileWithRetry` — bounded Windows retry table for the EPERM/EBUSY window
  a concurrent `atomicWrite` rename opens for lockless readers.

### Answering the question carried over from `persistence`

L0 asked whether `kanban` lacking `atomicReplaceWithWriter` forces costly
whole-buffer rewrites. It does not, in practice: the only whole-file rewrite is
the event-log trim, and it is bounded to `EVENT_LOG_TRIM_TO = 5 000` entries
behind a 512 KB trigger. Peak is a few MB on a path that runs rarely. Not worth
plumbing the streaming primitive through for.

### AUDIT-010 — a config expressing no opinion silently meant "atomic" (business logic)

`packages/kanban/src/atomicity/assess.ts`

`assessAtomicity` divides the weighted criterion scores by the total weight, and
fell back to a score of `1` when that total was zero:

```js
const score = totalWeight > 0 ? weighted / totalWeight : 1;
```

A score of 1 is the *most permissive* verdict — `atomic`, meaning "do not
decompose". So a weight set that zeroed every criterion, expressing no opinion
at all, silently switched decomposition off, and did so in the direction that
looks healthy: over-sized tasks came back `atomic` with a perfect score and full
confidence.

Zeroing a *subset* is supported and tested — `tests/atomicity.test.ts` scores on
effort alone that way — which is exactly what makes zeroing all of them a
plausible slip rather than an absurd input. `resolveAtomicityConfig` applies
defaults but validates nothing, so nothing else catches it either. The verdict
feeds SDD decomposition through `sdd/plan-decompose.ts` and
`sdd/task-generator.ts`.

**Fix.** An all-zero weight override is indistinguishable from supplying no
weights, so it now falls back to the built-in weights and produces a real
assessment. The built-ins are all positive, so the fallback cannot re-enter the
same state, and the degenerate division is gone rather than papered over.

**Test.** The existing "effort only" case is extended: zeroing every weight must
produce the same verdict as passing no weights at all, must not be `atomic` for
a 40-hour task, and must yield a finite score.

### Cleared (server and transport)

- `server/project-server.ts` framing — the buffer cap is checked before the
  frame loop, with a comment explaining why that ordering matters. The repeated
  `buffer.slice(nl + 1)` is not quadratic: V8 returns sliced-string views, and
  8 MB of minimal frames (2 796 202 of them) drains in 41 ms.
- `server/project-server.ts` backpressure — `writeFrame` drops a client once its
  queued output passes 8 MB, so a client that stops reading cannot grow the
  owner's heap one broadcast at a time. Malformed frames answer through the same
  path, so the error responses are bounded by the same cap.
- `server/sqlite-storage.ts` — `kanban_events` is pruned on append
  (10 000 → 5 000), mirroring the file backend, so `readEvents` is bounded and
  this is not the AUDIT-004 shape. Every hot predicate is indexed, including the
  `(board_id, seq)` index that keeps the per-append `COUNT(*)` off a full scan.
- `server/client.ts` — the heartbeat interval and every request timeout are
  `unref`ed, and the heartbeat's fire-and-forget carries a `.catch`. This client
  is what `core`, `cli`, `tui` and the web surfaces all connect through, so it is
  the one place a referenced timer would have held every host process open.
- Timers in `project-server.ts` and `kanban-supervisor-bridge.ts` — idle,
  liveness, lease and reconnect timers are all `unref`ed and all cleared in
  `stop()`.

### Noted, not changed

`project-server.ts:765` runs `void metadataWritten.then(…)` with no rejection
handler, while its two sibling `void` sites in the same file both handle
rejection. It is safe in fact: `metadataWritten` is constructed with only a
`resolve`, so it cannot reject, and the callback's `socket.write` does not throw
synchronously after destroy. Recorded because the inconsistency is the kind of
thing that stops being safe when someone later gives that promise a reject path.

### AUDIT-011 — a cyclic task graph made verification recurse forever (high)

`packages/kanban/src/verification/completion-protocol.ts`

`verifyTaskCompletion` descends into `childTaskIds`: a parent that is `atomic`
with children calls `verifySubtasks`, which for any child that is itself
`atomic` with children calls `verifyTaskCompletion` again. Nothing bounded that
descent, and nothing upstream guarantees the parent/child relation is acyclic.

`splitTask` is safe — it mints fresh child ids, which cannot already be
ancestors — but `syncTaskGraphIntoBoard` (`manager/task-graph-internal.ts`)
copies `node.children` straight into `childTaskIds` with no acyclicity check,
and a board file is ordinary project data other tools can write. Notably the
same function *does* guard the dependency relation against self-reference
(`dependencyId === taskId`), so the class was considered — just not for the
parent/child edge.

`A → B → A` therefore recursed without end. Because the recursion is `async`,
it does not fail fast with a stack overflow the way AUDIT-008 did: each hop
re-reads the board from storage and keeps going, so it hangs and grows instead.

**Fix.** A descent-path set threaded through the recursion, added on entry and
removed on exit. Path-scoped rather than run-scoped on purpose: a task
legitimately reachable through two different parents (a diamond) must not be
mistaken for a cycle. A cyclic graph is corrupt structure rather than a
verification outcome, so it throws — consistent with the function's existing
`Board not found` / `Task not found` throws — instead of returning a verdict
that could be read as a pass.

**Tests.** Two regressions in `tests/verification/completion-protocol.test.ts`:
`A → B → A` rejects with the cycle error, and a diamond (`Top → [Left, Right]`,
both → `Shared`) still verifies and reports two children.

### Cleared (verification)

- `BoundedProcessOutput` — caps retained stdout/stderr at 4 MB, accumulates
  chunks and concatenates once, and reports truncation. The boundary cases are
  right: an exactly-fitting chunk is not marked truncated, and a zero-length
  chunk against a full buffer is not either.
- Child-process lifecycle in `verification-context.ts` — `windowsHide`,
  `detached` only off Windows, `terminateProcessTree` on timeout, timers cleared
  on every settle path, and `settled` guards against double resolution.
- The command gate — default-deny with only `pwd`/`true`/`false`/`test`
  permitted, a broad blocklist, shell-operator and env-expansion detection, and
  a deliberate note explaining why no backslash-escape guard is used. Success
  criteria are model-authored, so this is the surface that matters, and it is
  strict by default.

### Noted, not changed

`CommandAllowlistConfig` uses `+` to *add* in `allowedCommands` but to *remove*
in `blockedCommands`, and the second meaning is not documented on the interface.
`blockedCommands: ['+rm']` therefore unblocks `rm` — the dangerous direction —
for a caller who read the field name and expected the opposite. It is
unreachable today: no production path passes `commandAllowlist` at all
(`completion-protocol.ts` constructs `VerificationContext` without it), so
`buildAllowlist(undefined)` always yields the strict defaults. Recorded rather
than changed because altering prefix semantics on a security surface with no
current caller is a decision for whoever wires that config up.

### Cleared (manager)

- Dependency cycles *are* guarded — `assertNoDependencyCycles` is a proper
  grey/black DFS that throws, `hasDependencyPath` carries a `seen` set, and
  `syncTaskGraphIntoBoard` rejects self-dependency edges. This is what makes
  AUDIT-011 a gap rather than an oversight in kind: the codebase detects cycles
  on the `dependsOn` relation and had nothing equivalent for `childTaskIds`.
- `assertNoDependencyCycles` is recursive and does an O(n) `board.tasks.find`
  per visit, so it is O(n²) with depth bounded by the dependency chain — but it
  is called only from `syncTaskGraphIntoBoard`, not on every mutation, so
  neither cost is on a hot path at realistic board sizes.
- Assignment races — every lease check (`heartbeatTaskAssignment`, terminal
  writes, recovery) runs *inside* the board mutation lock and compares
  `expectedLeaseId`, so a recovered-and-reassigned task cannot be overwritten or
  renewed by its previous owner. The comments state this intent explicitly.
- `recoverStaleKanbanAssignments` emits its events *after* `mutateBoard`
  returns, so the board lock is not held across N event appends — each of which
  would otherwise take the event-log file lock underneath it.
- An assignment with no `leaseExpiresAt` is not silently stranded. It is
  unreclaimable by design (the recovery sweep skips it), but the classifier
  names that state — `running_no_lease`, "Running assignment is missing lease
  metadata" — with `claimable: false`, so queue health surfaces it rather than
  showing a task that looks healthy forever. The dispatch path always sets a
  TTL (`dispatch.ts:151`); only the direct assignment API leaves it optional.

### Coverage note

Read line by line: `storage.ts`, `server/project-server.ts` (framing, write
path, lifecycle), `server/sqlite-storage.ts` (schema, event pruning, indexes),
`server/client.ts` (timers, reconnect), `atomicity/assess.ts` and
`atomicity/criteria.ts`, `verification/completion-protocol.ts`,
`verification/verification-context.ts` (process spawn, output bounding, command
gate), `manager/dependency-helpers.ts`, `manager/assignment.ts` (lease and
recovery paths), `manager/task-classifier.ts`, `manager/task-graph-internal.ts`
(graph sync).

Swept by defect class rather than line by line: the rest of `manager/`
(`_internal.ts`, `lifecycle.ts`, `tasks.ts`, `boards.ts`, `dispatch.ts`,
`decomposition.ts`, `serialization.ts`, and the small helpers) and the remaining
`verification/` plugins. The classes checked were the ones this campaign has
already found to recur here: module-level collections that grow without a bound,
timers that are not `unref`ed, fire-and-forget promises without a `.catch`,
input-derived recursion, unbounded reads, and quadratic accumulation. Every hit
resolved to a legitimate constant set or a per-project map with a natural bound.

---

## L2 — `core` (in progress)

Boundary: depends on `@wrongstack/kanban` and `@wrongstack/persistence`.
Consumed by every other package. 678 source files, ~163 000 lines across 29
subdirectories — on its own, roughly seven times everything audited above it.

### First pass: defect-signature sweep across all 678 files — no findings

The five signatures this campaign has already produced findings from were run
over the whole package. All hits resolved to correct code, which is itself worth
recording: it says where *not* to keep looking, and it means the findings above
are not a pattern core shares.

- **Non-`unref`ed intervals.** 12 `setInterval` sites; every one either unrefs
  (two do it far enough below the call that a narrow context window misses it —
  `brain-monitor.ts:377` is 16 lines down) or is a per-request SSE keep-alive
  that is cleared on close (`mailbox-http-router.ts:822`).
- **Uncapped module-level collections** (the AUDIT-009 shape). 107 of them; the
  107 are almost all constant lookup sets. Seven mutable caches have no
  `delete`/`clear` at all, and each is bounded by construction: `textCache` and
  `promptCache`/`candidateCache` key on a fixed set of bundled files and roster
  ids, `agentStateRootRealCache` on one home root, `captureCooldowns`/
  `captureFrequency` on the role enum. `sharedRemoteMailboxes` is the best of
  them — the outer map keys on project directory (a handful per process) and the
  genuinely unbounded dimensions are `WeakMap`s keyed on the EventBus and
  publisher objects, so they are collected with their owners.
- **Unbounded reads of append-only stores** (the AUDIT-004 shape). Nothing.
  `input-history-store` caps at 100 entries on both read and write;
  `file-observer` guards its hashing read with `stat.size <= maxHashBytes` and
  skips it entirely when size and mtime are unchanged.
- **Quadratic accumulation** (the AUDIT-003 shape). The `Buffer.concat` hits are
  all single-shot crypto finalizations, not per-chunk accumulation.
- **Fire-and-forget without `.catch`** — 75 sites, deliberately deprioritized:
  `installCrashShield()` is installed at `cli-entry-point.ts:121`, so an
  unhandled rejection does not take the CLI down. Worth revisiting for the
  daemons that are spawned as their own processes and may not install it.

### Read in depth: `security/secret-vault.ts` — no findings

Picked because it is security-critical and not covered by any existing project
note. The construction holds up:

- AES-GCM with a fresh random IV per encryption — no IV reuse — the tag stored
  alongside and set before `decipher.final()`, so tampering fails closed.
- IV and tag lengths are validated before use, and the wrapped-key format is
  identified by magic + exact size before parsing.
- The KEK is scrypt-derived with explicit `N`/`r`/`p`/`maxmem`.
- Critically, `loadOrCreateKey` only falls through to *creating* a key on
  `ENOENT`; a permission error, an I/O error, or a corrupt-format `ConfigError`
  all rethrow. A transient read failure therefore cannot replace the key and
  silently destroy every stored secret. Creation itself uses `flag: 'wx'` with
  an `EEXIST` handler that re-reads the winner's file.

### A heuristic that did not work

An attempt to find the AUDIT-011 shape (input-derived recursion with no
visited/depth guard) by grepping for self-calling functions produced only noise
— ordinary method names called several times in a file (`dispose`, `stop`,
`on`). Recursion is not reliably detectable by grep at this scale; in `core` it
has to come from reading each subdirectory, the way `governance` and `kanban`
were done.

### Remaining

Effectively all of it, by depth. `coordination/` (144 files, 42 k lines),
`execution/` (51 files, 17 k), `storage/` (75 files, 16 k), `types/` (9.6 k),
`utils/` (9.8 k), `core/` (9.1 k), `hq/` (8.6 k), `chronicle/` (8.2 k),
`plugins/` (6.5 k), `security/` (the remaining 17 files), `goal/`, `kernel/`,
`skills/`, `models/`, `tools/`, `worktree/`, and the smaller directories.

### AUDIT-012 — terminal task outcomes were not absorbing (business logic)

`packages/core/src/coordination/task-auctioneer.ts`

`complete()` and `fail()` both fetch the goal, decrement the winning agent's
in-flight count, and patch the node — without ever checking whether the goal had
*already* finished. `KnowledgeGraph.update` is a blind patch-merge, and its
`_isTerminal` helper is used only to order pruning, never to reject a transition
out of a terminal state, so nothing downstream caught it either.

Two consequences, both reachable from an ordinary duplicate or late report —
which is exactly what a fleet of separate agent processes produces:

- **The agent's load silently under-reports.** A repeated terminal report
  decrements the count a second time. Because `agentTaskCount` clamps with
  `Math.max(0, …)` rather than going negative, the double decrement is invisible
  and the agent looks idler than it is — so it can be awarded work past
  `maxTasksPerAgent`. The clamp that looks defensive is what hides the error.
- **A finished task can be rewritten.** `fail()` arriving after a genuine
  `complete()` flipped a `done` goal to `failed` and replaced its result with
  the error string.

Worth contrasting with `governance/transition-engine.ts`, cleared earlier in
this audit: there all five terminal states are absorbing, enforced by the
transition table. The same rule simply was not applied here.

**Fix.** Both entry points return early when the goal is already `done` or
`failed`, using a helper that mirrors `KnowledgeGraph._isTerminal`'s definition
for goals. First outcome wins.

**Tests.** Two regressions in `tests/coordination/task-auctioneer.test.ts`: a
repeated completion must not issue a second graph update, and a late failure
must leave a completed task's status and result intact. Verified against the
pre-fix code — they fail with `expected 2 to be 1` and
`expected 'failed' to be 'done'` respectively.

### Cleared (coordination, partial)

- `knowledge-graph.ts` — thoroughly bounded: 2 000 nodes with terminal-first
  eviction and an explicit fallback that evicts the oldest live nodes rather
  than let an all-active graph grow, 1 000 subscriptions, 1 000 pending
  deliveries per subscription with `shift()` on overflow. Eviction also cleans
  the companion `seq` map, the secondary index, and any pending deliveries
  referencing the node — the companion-map leak this campaign found in
  `kanban` (AUDIT-009) is not present here.
- `task-auctioneer.ts` map lifecycle — `pendingBids`, `bidTimers` and
  `bidRetryCounts` are all deleted on the terminal paths and `dispose()` clears
  the timers. `agentTaskCounts` keeps a zero entry per agent id rather than
  deleting it, which is bounded by the auctioneer's own lifetime and not worth
  a change.

### AUDIT-013 — a failed run silenced the agent-stall watchdog (business logic)

`packages/core/src/coordination/brain-monitor.ts`

`BrainMonitor` tracks live runs to decide whether a stall is even possible:
`agent.run.started` increments `activeRuns`, and the watchdog returns early
whenever `activeRuns === 0`. It decremented on **both** `agent.run.completed`
and `agent.run.error`.

Those are not alternatives. `Agent.run` emits `agent.run.completed` on every
exit path — the success path at `core/agent.ts:274` and, unconditionally, the
catch path at `:310` — and emits `agent.run.error` at `:302` *in addition* when
the run failed. One failed run therefore subtracted two.

The consequence is that the watchdog stops watching. With two concurrent runs
where one fails, `activeRuns` reaches 0 while a run is still live, so every
subsequent tick returns early and a genuine stall is never reported. The
`Math.max(0, …)` clamp is what kept this invisible: without it the counter would
have gone negative and been obviously wrong.

This file's own header states the intended contract — *"a run is active
(`agent.run.started` without its matching completion)"* — one completion per
start, which is exactly what `agent.run.completed` provides.

**Fix.** Decrement only on `agent.run.completed`. The `agent.run.error`
subscription did nothing else, so it is gone; `core/agent.ts:302` is the only
emitter of that event in the workspace, and it is always followed by the
completion event.

**Tests.** Two in `tests/coordination/brain-monitor-signals.test.ts`, using a
`runFailed()` helper that emits the pair in the same order `Agent.run` does: with
a second run still live the watchdog must still engage, and once every run has
ended it must stay quiet. The first fails pre-fix with
`expected [] to have a length of 1`; the second passes either way and is the
control.

### Method note — clamps as a finding signature

AUDIT-012 and AUDIT-013 were both found by looking for `Math.max(0, …)` on a
counter. The clamp is written as a defence, and it does prevent a nonsense
negative value — but where the underlying accounting is wrong it converts a
loud, obviously-broken counter into a quietly wrong one, and the wrongness is
always in the permissive direction (an agent that looks idle, a watchdog that
thinks nothing is running). Worth carrying into the remaining packages: a
clamped decrement is a question about whether every increment has exactly one
matching decrement.

The same sweep also cleared several: `brain-ledger` / `brain-trace`
`pendingWriteCount`/`pendingWriteBytes`, `fleet-manager`'s remaining-budget
readouts (those clamp a *subtraction of two independent totals*, not a running
counter), and `spawn-budget`'s depth clamp.

### Cleared (coordination, continued)

- `provider-status-tracker.ts` — the two streak counters reset each other
  symmetrically (a success zeroes `consecutiveFailures`, a failure zeroes
  `consecutiveSuccesses`), both maps are bounded by the provider×model catalog,
  and — the part actually checked for — block expiry does not depend on anyone
  calling the sweep: `isBlocked`/`isAvailable` evaluate `stateExpiresAt`
  lazily on read, with an explicit JSDoc distinguishing the non-mutating
  snapshot from the mutating recovery. A quota block set for a whole provider
  is dropped on the first success from any of its models.

### Deliberately skipped

- `subagent-budget.ts` — the file is exactly the counter-accounting risk class
  AUDIT-012/013 came from, but its counters are monotonic (no decrements, so
  the clamp signature does not apply), its negotiation path is densely
  commented with references to previously fixed races (per-kind dedup,
  watchdog wall-clock ownership), and the project memory marks the budget
  watchdog subsystem as the user's own work-in-progress. Auditing around an
  active edit risks colliding with it — deferred until that work lands.

### AUDIT-014 — the dead-fleet synthetic path bypassed the results cap (memory)

`packages/core/src/coordination/multi-agent-coordinator.ts`

`completedResults` is capped at `MAX_COMPLETED_RESULTS = 10 000`, with the trim
living inside `recordCompletion` — and a comment on the field stating the
intent: *"Prevents completedResults from growing unbounded in long-running
coordinators."*

`emitPendingAborted` pushes a synthetic `aborted_by_parent` result directly,
deliberately bypassing `recordCompletion` — its own comment explains why: that
path does `inFlight--`, which for a never-dispatched pending task would steal a
decrement from a genuinely in-flight one. The reasoning is sound, but the cap
was bypassed along with the accounting. On a coordinator whose fleet has died,
*every* assigned task synthetic-completes through exactly this path, and with no
real completion ever running the trim again, the array grows one result per
assign without bound. The same shape as AUDIT-009: an intended bound with one
path around it.

**Fix.** The trim is extracted into `trimCompletedResults()` and called from
both `recordCompletion` and `emitPendingAborted`. The inFlight bypass stays —
only the cap now applies everywhere.

**Test.** A regression in `tests/coordination/multi-agent-coordinator.test.ts`
kills the fleet, assigns 10 050 tasks, and asserts the results array holds at
most 10 000 with the newest synthetic kept. Fails pre-fix with
`expected 10050 to be less than or equal to 10000`.

### Cleared (coordination, continued)

- `agent-monitor.ts` — the per-subagent transcript is a true ring
  (`_maxEntries`, default 500, trimmed on both push sites and on load), the
  JSONL write queue is capped by count and bytes with drop-oldest, and the byte
  accounting is exact: every push's increment has one matching decrement,
  either on drop or on drain — so its `Math.max(0, …)` clamps guard correct
  arithmetic rather than hiding a broken counter (contrast AUDIT-012/013).
  `removeSubagent` clears the session, the open stream, and the event
  subscription together.
- `multi-agent-coordinator.ts` waiters — `awaitTasks` checks the cache and
  registers its listener in one synchronous block, so no completion can slip
  between the miss and the subscription; `awaitTasksAny` drains what is done
  and otherwise resolves on the first matching completion, detaching its timer
  and listener on every path.

### Cleared (execution, storage, and the remaining core directories)

- `execution/council-orchestrator.ts` — abort wiring uses the platform
  primitives (`AbortSignal.timeout` + `AbortSignal.any`), so there are no
  manually attached listeners to leak; every seat failure is caught and
  canonicalized per status (cancelled vs timed-out vs failed).
- `execution/eternal-autonomy.ts` / `parallel-eternal-engine.ts` — the
  long-running engines hold only scalar counters across iterations; every
  array in the dispatch path is cycle-local. No cross-iteration accumulation.
- `storage/session-store/load-cache.ts` — LRU with entry and byte caps; every
  `set` adds bytes once, every removal goes through one `delete()` that
  subtracts once, and re-`set` deletes first. Its clamp guards correct
  arithmetic.
- `storage/session-recovery.ts` — streaming line read with parallel
  event/size arrays that push, shift and reset together; bounded by
  `MAX_PENDING_EVENTS`/`MAX_PENDING_BYTES`.
- `infrastructure/logger.ts` — pending-write count/byte accounting increments
  behind a capacity gate and decrements exactly once per completed write.
- `goal/goal-runner.ts`, `goal/phase-orchestrator.ts` — both intervals are
  cleared in their stop paths; they are foreground-operation timers, so not
  unref'ing them is defensible.
- `observability/otlp-*.ts` — both push intervals unref, three lines below the
  call (the same near-miss window as `brain-monitor`, and the same verdict).
- Directory-level signature sweep over `kernel/`, `plugins/`, `hooks/`,
  `skills/`, `models/`, `notifications/`, `registry/`, `tasking/`,
  `worktree/`, `replay/`, `extension/`, `middleware/`, `prompts/`,
  `defaults/`, `tools/`: zero non-unref'd intervals, zero suspicious clamps,
  zero module-level mutable collections.

With this, every `core` subdirectory has had at least a signature pass, and the
high-risk files (by size, statefulness, or absence from project memory) have
been read: 10 deep reads, 3 findings, the rest recorded above.

---

## L3 — twelve packages (breadth pass complete, no findings)

`tools`, `providers`, `mcp`, `sage`, `plugins`, `acp`, `techstack`, `telegram`,
`security-scanner`, `requirement-intake`, `plug-lsp`, `bench` — ~146 000 lines.
The full signature battery (non-unref'd intervals, clamped counters, unbounded
module maps, quadratic concat) ran over every package, and every hit resolved
clean on inspection:

- **Intervals** — 9 candidates; 8 had their `unref` just below the grep window,
  and the ninth (`tools/codebase-index/project-server.ts` client-lease sweep)
  unrefs at +8 lines *and* is cleared in `stop()`.
- **Clamped counters** — the two real ones both balance exactly:
  `mcp/registry.ts` `inFlightCalls` decrements in a `finally` inside
  `wrapMCPTool`, one per `onStart`; `sage/project-server.ts` `pendingRequests`
  decrements in the dispatch promise's `finally`.
- **Module maps** — every mutable module-scope map in `tools`, `sage`,
  `plugins`, `techstack` has at least one delete/clear path; the no-evict ones
  are warn-once sets bounded by their key domain.
- **`plugins/runtime/bounded-map.ts`** deserves the note: the package already
  ships the AUDIT-009 remedy as first-class infrastructure — an LRU
  `BoundedMap`/`BoundedSet` with the same delete-and-re-insert recency trick,
  optional TTL, and eviction counters surfaced through plugin health. The
  header comment describes exactly the slow-leak failure mode this audit found
  in `kanban`.
- **`acp/agent/stdio-transport.ts`** — 20 MB frame cap checked on the retained
  remainder, queued-message caps by count and chars, and exact queue byte
  accounting.

This is consistent with the project memory: these packages (tools exec
allowlist, provider error taxonomy, SAGE injection, plugin stores, ACP wire
format) have been through targeted hardening in earlier sessions. Deep
line-by-line reads here are deferred in favour of the unswept L4–L6 surfaces;
if a finding elsewhere implicates one of these packages, it gets the full
treatment then.

---

## L4 — `runtime`, `sdd`, the `*-mcp` adapters

Battery over all seven packages: two interval candidates, both clean on
inspection (`sdd/start-sdd-run.ts` unrefs through a cast and clears in the
run's `finally`; `codebase-index-mcp/cli.ts` is a *documented deliberate*
keep-alive lease for daemon election, cleared after startup). No suspicious
clamps, no unbounded module maps.

### AUDIT-015 — cancelling a task that had already completed rewrote it to failed (business logic)

`packages/sdd/src/sdd-parallel-run.ts`, with the enabling behaviour in
`packages/core/src/tasking/task-tracker.ts`

`TaskTracker.updateNodeStatus` applies any transition blindly — including
`completed → failed`. `cancelTask` checked only that the node *exists*, so
cancelling an already-completed task:

- rewrote its status to `failed` ("cancelled by user"),
- stamped the `cancelled` metadata marker,
- emitted `sdd.task.failed`, and
- left the graph inconsistent — a "failed" node whose dependents were already
  unblocked by its genuine completion and may themselves be complete.

The race is user-shaped: the task finishes, the board has not refreshed, the
user clicks cancel. Finished work then shows as "Cancelled" and the run's
final completed count undercounts. The docstring enumerates "currently
running" and "has not started" — rewriting finished work was never
contemplated.

Same family as AUDIT-012 (auctioneer terminal states) — third instance of
terminal-state transitions not being absorbing outside `governance`, which
enforces them by table.

**Fix.** `cancelTask` returns `false` for a `completed` node, the same signal
it gives for an unknown task. Cancelling a *failed* task deliberately stays
allowed: its cancelled marker is what blocks the end-of-run retry sweep from
requeueing it.

**Tests.** Two in `tests/sdd-parallel-run.test.ts`: cancel on a completed task
returns false and leaves status and metadata untouched (fails pre-fix with
`expected true to be false`); cancel on a failed task still marks it
cancelled.

### Cleared (L4)

- `sdd-parallel-run.ts` sweep logic — the end-of-run failed-task sweep is
  double-guarded (`maxFailedSweeps` cap and a made-progress check), the run
  drains with `Promise.allSettled`, and per-task supervisor rescues carry
  their own loop guard.
- `runtime`, `kanban-mcp`, `mailbox-mcp`, `sage-mcp`,
  `requirement-intake-mcp` — battery-clean; thin adapter layers over already-
  audited surfaces.

---

## L5 — `webui-server`, `webui-hq`, `simpleui`, `tui` (breadth pass, no findings); `webui` deferred

Battery over the four auditable surfaces (~135 000 lines):

- **`tui`** — 27 non-unref'd intervals and 13 clamps, all clean: the intervals
  are foreground-app timers cleared in effect cleanup (a TUI *should* keep its
  process alive), and every clamp is layout/index arithmetic
  (`Math.max(0, width - …)`), not a running counter. Consistent with project
  memory: TUI RAM has been through several dedicated sweeps already.
- **`webui-server`** — all six handler intervals (presence heartbeat, three
  broadcast loops, board poll, watcher metrics) have their `clearInterval`;
  both module caches (`chronicle-routes` access cache, `codemap-cache`) are
  capped LRU with recency re-insertion — codemap additionally caps per-body
  and total chars. The worktree broadcast loop pushes full state every 2 s
  *unconditionally*, but only while worktree handles exist, serializes once
  per tick, and the payload is a handful of handles with a 6-entry activity
  cap — observed, immaterial.
- **`simpleui`**, **`webui-hq`** — every interval paired with a clear;
  the one module map is a roster-bounded name cache.

**`webui` (107 000 lines) is deferred entirely**: the concurrent session's WIP
there has grown to 154 modified files with edits landing minutes ago. Auditing
a surface while another session actively rewrites it produces findings against
code that may already be gone — it gets its pass when that work lands.

---

## L6 — `cli` (breadth pass + safe hotspots; auth surface excluded as foreign WIP)

Battery over all 396 files: 15 interval sites — every one pairs with a
`clearInterval` (the six `hq-server.ts` timers are cleared together in
shutdown) or unrefs; 6 clamps, all picker/renderer index arithmetic; 3 module
maps, each swept or warn-once.

Deep reads on the hotspot files not under the concurrent session's WIP:

- `hq-server/ws.ts` — 1 MB `maxPayload` at the server, a per-socket error
  handler documented against the `ws` oversized-frame crash, strict frame
  validation with typed close codes, browser sockets restricted to
  `client.resume`, event log ring-capped at 5 000, resume-gap replies capped
  by envelopes, bytes and staleness, and the peer-dedup map time-swept on
  access.
- `fleet/host.ts` — the shadow work-depth counter balances: each
  started/completed pair fires exactly once (this file consumes
  `agent.run.completed` with its status field, the correct usage AUDIT-013's
  consumer got wrong), and the spawn-time suppression covers only
  `buildDirector()`, so the shadow's own task events pair up. The guarded
  decrement protects an observability heuristic, not safety accounting.
- `goal-host.ts` — child-process output collection is capped
  (`MAX_CMD_OUTPUT`) with a running total instead of quadratic re-joins;
  spawn carries `AbortSignal.timeout` and `windowsHide`; and the autonomous
  command allowlist is deliberately narrower than exec's, extended only from
  *trusted* config with the in-project stripping called out in a comment.

**Excluded as foreign WIP** (the concurrent session is actively rewriting the
HQ auth + OAuth surface — 22 cli files including `hq-server/auth*.ts`,
`login-attempt-store.ts`, `auth-menu/*`, `routes/auth-handlers.ts`): findings
against code mid-rewrite would be stale, and edits would collide. Queued for
after that work lands, along with `webui`.

### AUDIT-016 — TaskDAG terminal states were not absorbing (business logic)

`packages/core/src/coordination/task-dag.ts`

Fourth instance of the family (AUDIT-012 auctioneer, AUDIT-013's cousin,
AUDIT-015 SDD cancel), found by sweeping every direct `.status = '<terminal>'`
mutation in the workspace. `claim()` guards its transition
(`if (node.status !== 'ready') return false`) — `complete()`, `fail()` and
`skip()` did not. The asymmetry sits within one file.

Reachability is concrete: the DAG is shared across sessions, and
`autonomous-coordinator.ts:471/473` calls `dag.complete`/`dag.fail` from
*cross-session* goal updates ("Completed by another session"). Duplicated or
late cross-session reports are ordinary traffic. A late `fail()` after a
genuine `complete()` flipped `done` to `failed`, stamped an error over the
result, and re-emitted lifecycle events; the reverse rewrote a failure into a
success. Dependents were already safe — `_transition` checks its from-state —
but the node's own record was not.

**Fix.** `complete`/`fail`/`skip` early-return when the node is already in one
of the three settled states (`done`/`failed`/`skipped`), via one helper.
First outcome wins, mirroring `claim()`'s existing guard.

**Tests.** Two in `tests/coordination/task-dag.test.ts`: a late `fail()` after
`complete()` leaves `done` + result + no error (pre-fix:
`expected 'failed' to be 'done'`); a late `complete()`/`skip()` after `fail()`
leaves `failed` (pre-fix: `expected 'skipped' to be 'failed'`). Full
coordination suite: 2 112 tests green.

### The terminal-state sweep, closed out

Every direct terminal-status mutation in the workspace was enumerated and
dispositioned: `task-dag.ts` fixed (above); `session-analyzer.ts` is
last-event-wins *replay* of a historical log, which is correct semantics;
`requirement-intake/service.ts` mutates through a versioned helper with
`expectedVersion` optimistic concurrency; the `kanban` assignment/completion
sites run inside the board mutation lock with lease-id guards (cleared in L1);
the todo trackers are idempotent toggles with no counter attached. The family
is now systematically covered rather than found case by case.

### Cleared (queue drain, continued)

- `core/hq/persistence/event-log.ts` backward scan — the `Buffer.concat`
  flagged by the early sweep is per-window, bounded by
  `BULK_PREFIX_READ_CAP` plus one boundary line, with careful UTF-8 seam
  stitching and seam-line dedup across windows. Engineered precisely to avoid
  the whole-file allocation; not the AUDIT-003 shape.
- `sage/middleware/tool-call-memory.ts` — injection tracking is capped at
  20 000 with a dual-mode eviction that is explicit about *why*: time-based
  pruning under a cooldown, size-based oldest-first in once-per-session mode
  (where age says nothing about need). Per-call maps everywhere else.
- `core/coordination/mailbox-http-rate-limit.ts` — per-key arrays are capped
  at `limit` (rejected requests do not push), and both HTTP hosts wire the
  periodic `cleanup()`. The open question — the cardinality of
  `rateLimitKey` itself — lives in the HQ auth/client-address code the
  concurrent session is rewriting right now; queued with that surface.

Checkpoint: consolidated run over every touched package —
`persistence` + `governance` + `kanban` + `sdd` + `core/coordination` —
**3 949 tests passed** (1 pre-existing budgeted skip), 36 modified files,
zero NUL/CRLF corruption.

### AUDIT-017 — two committed source files carried raw NUL bytes, hiding them from every text search (tooling/integrity)

`packages/core/src/utils/cache-key.ts`, `packages/core/src/utils/glob-match.ts`

Both files use NUL as a cache-key domain separator — and both had it as a
**literal byte** in the source rather than the backslash-u0000 escape.
Committed in HEAD, so this predates the audit; it is the same authoring
failure this campaign hit and documented on 2026-08-05 (an editing tool
turning the escape into the raw byte), which means the class recurs and got
past review at least twice.

Runtime behaviour is identical either way — escape and byte produce the same
one-byte string, and the 1 302 utils tests (which pin cache-key hashes)
confirm it. The damage is to *tooling*: grep classifies both files as binary
and silently excludes them from every content search — git grep, ripgrep,
editor search, and this audit's own sweeps. `glob-match.ts` is the
trust-boundary glob compiler; a file like that being invisible to text search
is exactly where a future defect goes unnoticed. Found only because a grep
over `utils/` printed "Binary file matches" instead of a line.

**Fix.** Both raw bytes replaced with the six-character backslash-u0000
source escape. `file` reports both as UTF-8 text again; typecheck and the
full utils suite (1 302 tests) green.

**Guard.** The repo-wide scan (git ls-files x NUL probe over 2 190 tracked
source files) now comes back clean; the detection one-liner is recorded in
project memory alongside the authoring-failure note.

### Cleared (queue drain, final)

- `acp/client/acp-session.ts` — the pending-request map is airtight: response,
  timeout, send-failure and teardown paths each clear the timer and delete the
  entry, and `close()` rejects every remaining pending with a typed error.
- `tools/codebase-index/worker.ts` — `inFlight` is set/deleted in
  `try/finally` around the only awaited op; cancel aborts through the map.
- `tools/codebase-index/background-indexer.ts` — debounce timers cleared on
  fire and drained with their batches in teardown.

### AUDIT-018 — quadratic LSP receive path (performance)

`packages/plug-lsp/src/server/connection.ts`

The AUDIT-003 shape, one layer up: `buffer = Buffer.concat([buffer, chunk])`
on every stdout 'data' event until a full Content-Length frame accumulated.
Better than governance's version in one respect — the 16 MiB cap was checked
*before* the concat — but the accumulation itself was still quadratic in the
message size. Measured with the delivery shape Node actually produces (64 KiB
reads): one 16 MiB LSP response — a workspace-symbol or diagnostics payload on
a large repository — copied **2 056 MB in 322 ms**; the fix copies
**16 MB in 3 ms**. This sits on the hot path of every LSP round trip the
`plug-lsp` tools make.

**Fix.** A two-phase receive machine. Headers still accumulate by concat —
the `\r\n\r\n` terminator can straddle a chunk boundary — but a header block
is capped at 64 KiB, so that concat is trivially cheap; a stream producing
more header bytes than that without a terminator is not speaking LSP and is
closed. The body's length is known from Content-Length before its first byte
arrives, so body chunks are held in an array and joined exactly once at the
frame boundary. Skip semantics for absurd/NaN lengths are preserved
(pinned by the existing malformed-frames test), zero-length bodies dispatch
inline, and teardown clears all three state fields.

**Tests.** The existing suite passes unchanged except the overflow test's
white-box probe, updated to the new fields. One new regression drives a 2 MiB
body through 64 KiB slices with a second complete frame packed into the final
slice — exercising the header/body boundary in every alignment — and asserts
both messages dispatch intact.
