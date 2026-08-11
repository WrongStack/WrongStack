# Project Daemons

> **Status**: Active — adopted 2026-08-11
> **Applies to**: every per-project IPC daemon in the workspace

WrongStack runs a small set of long-lived background processes, one per project.
They exist so that state with a single owner — a SQLite database, an index, a
journal — has exactly one writer no matter how many surfaces are open. A TUI
session, a WebUI tab, the HQ dashboard, an MCP client, and a fleet agent all
talk to the same daemon for the same project.

This document covers what they are, the ownership election that starts them,
how they recover from a dead predecessor, and what to do when one is wedged.

---

## The daemons

| Daemon | Owns | Endpoint helper |
|---|---|---|
| `kanban` | Board state, workflow command queue | `kanbanProjectServerEndpoint(projectRoot)` |
| `sage` | Long-term memory store | `sageProjectServerEndpoint(projectRoot)` |
| `chronicle` | Event journal, derived metrics, file observer | `chronicleProjectServerEndpoint(projectDir)` |
| `mailbox` | Inter-agent messaging | `mailboxProjectServerEndpoint(projectDir)` |
| `session-catalog` | Live session registry, leases | `sessionCatalogProjectServerEndpoint(projectDir)` |
| `codebase-index` | Symbol/file index, code map | `projectIndexServerEndpoint(projectRoot)` |
| `governance` | Policy evaluation (opt-in per project) | `governanceProjectServerEndpoint(projectRoot)` |

All are spawned on demand by their client, detached, and exit on an idle
timeout (default 5 minutes with no connected clients). Nothing needs to start
or stop them by hand.

Endpoints are derived deterministically from the project path: a Unix domain
socket under `$TMPDIR/ws<xx>-v<N>/<hash>.sock`, or a `\\.\pipe\wrongstack-*`
named pipe on Windows. The `0700` parent directory is the ownership boundary —
the socket name is predictable, so without a private directory another local
user could pre-bind it in a world-writable `/tmp` and receive the project's
traffic.

---

## The bind is the ownership election

A daemon does not check whether a peer is running and then start. It binds, and
binding is what makes it the owner. Whoever binds owns the project's state;
everyone else must exit without opening a second writer.

This ordering is load-bearing and appears in every daemon:

1. Bind the endpoint.
2. **Only then** open SQLite / initialize the store.
3. Write the metadata file (`pid`, `authToken`, `startedAt`).
4. Greet connecting clients with `hello`.

Step 2 comes after step 1 so that a losing contender never becomes a database
owner even briefly. Step 4 comes after step 3 because clients authenticate with
a token read from the owner-only metadata file; greeting before that file
exists would leave a window where the socket accepts connections nobody can
authenticate against.

---

## Self-healing: the stale endpoint

On Unix, `bind()` creates a filesystem entry that `close()` is responsible for
removing. A daemon killed with `SIGKILL`, reaped by the OOM killer, or stopped
with its container never runs that cleanup. The socket file survives with
nothing listening behind it.

That leftover file is a **permanent wedge** unless the next daemon handles it:

- a client `connect()` gets `ECONNREFUSED` and concludes "no daemon, spawn one"
- the spawned daemon's `listen()` gets `EADDRINUSE`, because the path exists
- the daemon dies, the client retries, and the cycle repeats — forever

Nothing breaks the loop on its own. The project's daemon stays unstartable
until a human deletes the file.

### The reclaim ladder

`EADDRINUSE` alone cannot distinguish "a live owner holds this endpoint" from
"a dead owner left the file behind". A connect probe can: it succeeds against a
live owner and fails against a stale entry. Every daemon therefore runs:

```
mkdir 0700 parent  →  listen
                        ├─ ok            → chmod 0600, own the project
                        └─ EADDRINUSE    → probe the endpoint
                                             ├─ answers  → a live owner exists; exit 0
                                             └─ silent   → stale; unlink and re-listen
```

Only the second branch may unlink. Removing a live owner's socket would sever
every connected client and elect a second writer over the same database — a
worse failure than the wedge, and a silent one.

This ladder lives in exactly one place:

**`bindProjectEndpoint()` in `@wrongstack/persistence`** (`src/project-endpoint.ts`)

It returns an outcome to switch on rather than an exception to classify:

| Outcome | Meaning | Caller action |
|---|---|---|
| `bound` | This process owns the endpoint | Proceed to open the store. `reclaimedStaleEndpoint` says whether a dead predecessor was cleaned up |
| `already-owned` | A live daemon owns the project | `process.exitCode = 0` and return. Not an error |
| `failed` | Could not bind, could not reclaim | Report `error` and exit non-zero. The only outcome warranting operator attention |

> **Rule**: a new project daemon MUST bind through `bindProjectEndpoint()`.
> Do not hand-roll `server.listen()` plus an `EADDRINUSE` handler.

The rule exists because the ladder was previously copied by hand into five
daemons at three levels of completeness, and the two that omitted the probe —
`kanban` and `codebase-index` — were wedgeable by design. One `SIGKILL` against
the kanban daemon made every subsequent `wstack` invocation in that project
fail at startup with a socket path in a stack trace.

On Windows there is nothing to reclaim: a named pipe has no filesystem entry
and vanishes with the process holding it, so `EADDRINUSE` there always means a
live owner. `bindProjectEndpoint()` short-circuits to `already-owned` rather
than probing.

`governance` is the one daemon that does not use this primitive. It has a
richer election of its own — a startup lease plus metadata-ownership
inspection (`inspectGovernanceDaemon`, `shouldRecoverGovernanceEndpoint`) —
which subsumes the ladder above. It is also opt-in per project.

---

## Degradation: a daemon is never fatal

Every one of these daemons backs an **optional** capability. Kanban is a
projection of todos, plans, and tasks that are authoritative elsewhere.
Chronicle is an audit trail. The codebase index is an accelerator. Losing any
of them costs the user a view or some speed — never their work.

So the second half of the contract is at the call site:

> **Rule**: an unreachable project daemon degrades the feature. It never fails
> the session.

`hydrateSessionKanban()` is the reference implementation: it catches, records
the reason in `sessionKanbanDegradation()`, and returns `null`. The CLI reads
that reason once during session setup and emits a single line:

```
Kanban board sync unavailable — continuing without it (<reason>).
Run `wstack doctor --daemons` for detail.
```

This rule was written after the call site broke it. `await
hydrateSessionKanban(context)` in `packages/cli/src/wiring/session.ts` was
unguarded, so a stale kanban endpoint unwound through `setupSession` and killed
`wstack` before it produced a prompt. No session at all, because a board the
user had not asked to see could not be reached.

---

## Inspecting daemons

```bash
wstack doctor --daemons                 # list every project daemon and its status
wstack doctor --daemons --clear-stale   # unlink endpoints that probe as stale
```

Statuses:

| Status | Meaning |
|---|---|
| `live` | Answering on its endpoint. `pid` shown when the metadata file is readable |
| `stale` | The endpoint exists but nothing answers — a wedge. Current daemons reclaim this on next start |
| `stopped` | No endpoint, no daemon. The normal state before first use |

Listing never spawns a daemon: every endpoint is a pure derivation from the
project path, and liveness is a connect probe. A diagnostic that resurrects the
subsystem it measures cannot report on it.

`--clear-stale` only removes endpoints that a *fresh* probe just reported as
stale, and it offers no "restart" — daemons are spawned on demand, so clearing
the wedge is the whole job. The next command that needs one starts it.

### Why this is a command and not a startup prompt

A plausible-sounding alternative is to show the daemon list at CLI startup and
ask whether to reuse or kill-and-restart them. That is the wrong default:

- **While healthy, the answer is always "reuse".** A question with one correct
  answer is friction on every launch.
- **It is unsafe to answer.** Daemons are shared per project across every
  surface. "Kill all and start fresh" from a second session nukes the first
  session's live state, and the launcher has no way to show the user what is
  connected.
- **It leaks an implementation detail.** Daemons are infrastructure; while
  things work, their existence is not the user's concern.

The chosen split is: self-heal silently by default, print one warning line when
self-healing fails, and expose this command for when someone wants to look.

---

## Manual recovery

Self-healing covers the wedge from the next daemon start onward. For a machine
running an older build, or to clear it immediately:

```bash
wstack doctor --daemons --clear-stale
```

Or by hand — the socket directories are per-daemon and per-protocol-version:

```bash
ls -la "${TMPDIR:-/tmp}"/wskb-v*/     # kanban
rm -f "${TMPDIR:-/tmp}"/wskb-v*/<hash>.sock
```

To see why a daemon is failing to start, run it in the foreground. Clients
spawn daemons with `stdio: 'ignore'`, so startup errors are otherwise
discarded:

```bash
node .../@wrongstack/kanban/dist/project-server.js --project-root /path/to/project
```

---

## Related

- [mailbox-architecture.md](mailbox-architecture.md) — the mailbox daemon's protocol
- [chronicle-architecture.md](chronicle-architecture.md) — the chronicle daemon's storage model
- [kanban-architecture.md](kanban-architecture.md) — the kanban daemon's domain
- [troubleshooting.md](troubleshooting.md#failed-to-connect-to-project-server) — symptom-first entry
