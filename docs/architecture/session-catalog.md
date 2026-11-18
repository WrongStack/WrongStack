# Session catalog and presence

The per-project Session Catalog daemon owns catalog/index mutations, live
presence, ownership leases, resume reservations and maintenance admission.
Each active session host owns its append-only transcript writer; the catalog
daemon does not serialize every transcript event.

| Boundary | Source |
|---|---|
| IPC operations, credentials, defaults and events | [`protocol.ts`](../../packages/core/src/session-catalog/protocol.ts) |
| Daemon startup and client requests | [`client.ts`](../../packages/core/src/session-catalog/client.ts), [`project-server.ts`](../../packages/core/src/session-catalog/project-server.ts) |
| SQLite catalog owner | [`store.ts`](../../packages/core/src/session-catalog/store.ts), [`store-schema.ts`](../../packages/core/src/session-catalog/store-schema.ts) |
| Presence registry | [`session-registry.ts`](../../packages/core/src/session-catalog/session-registry.ts) |

Session leases exclude a second owner of the same session. Resume reservations
coordinate claiming, and maintenance leases guard destructive catalog work.
Protocol defaults are 30 seconds for a session lease and 15 seconds for a resume
reservation; the store bounds supplied durations. Live presence is different
from saved transcript history, so a disconnected surface refreshes the catalog
rather than assuming it saw every event.

The schema also tracks agent metadata and transcript content hashes, plus hot
and cold storage metadata. Additive schema repair does not itself imply a
breaking schema-version bump. Read the schema/store owners before changing
storage layout or rebuilding derived indexes.

## Startup readiness and connection failures

The endpoint bind elects the owner; metadata is published afterwards. A missing
metadata file therefore does not distinguish an absent daemon from one still
starting. `callExisting` is observation-only: it never spawns a daemon and fails
fast without a recorded live owner. With a live owner it retries within its
bounded connection window. Normal calls may start a daemon within the separate
startup deadline. Do not turn cross-project discovery into an unconditional
wait or give it authority to spawn services.

On Windows, a pre-bind named-pipe connection can fail with `ENOENT`; other
platforms may report `ECONNREFUSED`. The controlled client tests in
`packages/core/tests/session-catalog-client-stale-error.test.ts` cover recovery
for both errors with a live owner. The probe-wait tests cover absent/dead
owners, and the startup-disconnect tests cover clients leaving while metadata
publication is gated.

The historical HQ mailbox CI connection failure has not been attributed to a
specific throwing site. Passing these tests is not proof that the intermittent
failure is fixed. Keep the narrowly scoped CI retry until a reproduction
identifies the cause. For a diagnostic run, set `WRONGSTACK_CATALOG_DAEMON_LOG`
to a task-owned log path; the existing opt-in trace records connect/spawn
choices and daemon lifecycle output. Correlate that trace with the failing
stack and endpoint before changing election or readiness behavior.

See [project daemons](../project-daemons.md), [session journal](session-journal.md)
and [project goals](project-goals.md). The original completed rollout plan is
[archived](../archive/plans/session-catalog-project-service-2026-08.md).
