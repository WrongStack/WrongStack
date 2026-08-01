# @wrongstack/governance

Deterministic workflow vocabulary and transition policy for WrongStack.

This package deliberately has no provider, agent, tool, or UI dependency. Its deterministic core is wrapped
by isolated SQLite and local IPC adapters. Models remain the primary reasoning and execution resource: they
can propose plans, transitions, retries, replans, and completion. The transition engine decides whether a
proposal is inside the approved autonomy envelope and can therefore proceed automatically.

The package is not connected to the current runtime yet. Existing Agent, Director, Kanban, SDD, Goal,
and MCP behavior remains unchanged while the governance contract is introduced incrementally.

`TaskContractV1` defines requirements, acceptance criteria, evidence expectations, review dimensions,
rollback class, path scope, change budgets, and an A0-A4 autonomy envelope. Low-risk work can proceed
without human prompts; sensitive operations can be explicitly escalated or narrowly pre-authorized by
project policy.

`PlanVersionV1` stores immutable model-generated plan content as a requirement-linked DAG. Replanning
creates a parent-linked next version instead of rewriting history. Step-level autonomy classification
keeps ordinary implementation and verification automatic while isolating only the sensitive steps that
need escalation.

The pure task aggregate accepts command envelopes, evaluates trusted deterministic facts outside model
arguments, emits one immutable event proposal, and rebuilds state by deterministic replay. Persistence,
daemon ownership, and runtime adapters remain separate from model execution.

`SqliteGovernanceEventStore` is an isolated append-only persistence adapter. It commits an accepted event
and its command receipt in one `BEGIN IMMEDIATE` transaction, records rejected decisions for stable retry
semantics, rejects reuse of a command id with a different payload, and reconstructs historical results by
event replay. Trusted decision facts are stored with the receipt for auditability. Production runtime code
does not open this database yet; the opt-in project daemon remains the only process allowed to own it.

`GovernanceProjectService` adds a transport-neutral, project-scoped owner with explicit `task_read`,
`audit_read`, `command_submit`, and `shadow_observe` capabilities. Capabilities are supplied by trusted
server context rather than request payloads. Trusted transition facts are resolved by a service-owned policy
provider and are structurally absent from model command requests. The typed service core is not itself a
network security boundary; credential binding, unknown-input decoding, IPC election, and process lifecycle
are enforced by the surrounding local server and daemon adapters.

`decodeGovernanceServiceRequest` is the mandatory future wire boundary for unknown JSON. It rejects unknown
fields at every governed schema level, validates command/contract/plan/observation shapes, applies bounded
JSON depth and collection limits, and returns a deeply frozen request. Capability and trusted decision-fact
fields are absent from the accepted wire schema and are rejected if injected.

`LegacyGovernanceShadowAdapter` has only `shadow_observe`. It writes idempotent legacy observations to a
separate append-only ledger and cannot submit governance commands or transition canonical task state. This
allows compatibility telemetry before any legacy workflow is blocked or replaced.

`GovernanceCapabilityGrantRegistry` issues short-lived opaque grants bound to one project and client. Only a
SHA-256 verifier is retained; raw bearer tokens are returned once, expire inclusively, can be revoked, and
are intentionally lost when the future daemon restarts. `AuthenticatedGovernanceProjectService` resolves a
valid grant into an immutable capability set before calling the internal service. The legacy shadow adapter
uses this authenticated facade instead of constructing its own capabilities.

The ephemeral registry is bounded by `maxGrants`. It emits immutable lifecycle records through an injected
audit sink instead of retaining an unbounded in-memory history; the project server appends those records to
the persistent evidence ledger.

`GovernanceProjectServer` and `GovernanceProjectClient` provide a local IPC skeleton for isolated testing.
The server binds the deterministic per-project endpoint before opening `.wrongstack/governance/governance.sqlite`,
so a losing owner never opens a second database connection. Credentials travel in a strict transport
envelope, separate from the inner request, and only the authenticated facade receives decoded calls. Frames,
connections, and half-open socket lifetimes are bounded. Capability lifecycle observations require
`audit_read`; ordinary task readers cannot see them, and shadow writers cannot forge reserved audit events.

`launchGovernanceProjectDaemon` is an explicit, opt-in detached-process boundary. The built daemon acquires
the endpoint before SQLite, then returns one initial client grant over the private parent-child IPC channel.
The raw token is never placed in argv, inherited environment, or a bootstrap file. The daemon inherits only
a small operating-system environment allowlist, rejects unknown handshake fields, validates project/client
identity, and exits instead of silently falling back to a second in-process owner. A competing launch reports
`owner_conflict` without disturbing the current owner.

The daemon publishes strict, secrets-free liveness metadata under `.wrongstack/governance/daemon.json`:
protocol and schema versions, canonical project identity, endpoint, PID, instance id, and start time. It does
not persist bearer tokens, client credentials, or capabilities. Metadata is a discovery hint rather than an
ownership authority: endpoint binding remains authoritative, and the launcher verifies the on-disk instance
identity before returning a bootstrap credential.

`connectGovernanceProjectClient` is a non-starting discovery adapter for callers that already hold an
ephemeral credential. It requires live metadata, matching project identity, and a successful authenticated
health response before returning a client. Missing or contradictory state is returned as an explicit result;
the helper neither launches a daemon nor reads or writes credential material.

Daemon startup is serialized by an atomically created project-local lease. A lease held by a live PID is never
removed, malformed lease data fails loud, and release removes only the exact record owned by that instance.
After a failed endpoint probe, a dead or missing owner permits stale filesystem-socket cleanup only while the
lease is held on Unix-like platforms. Windows named pipes are not deleted; contradictory owner/endpoint state
fails with `endpoint_invalid` instead of guessing. An abrupt Windows process stop can leave stale metadata,
which the next launch treats as a dead liveness hint and replaces only after it has acquired the endpoint.

An explicitly bootstrapped `capability_admin` client can issue short-lived ordinary-client grants, list public
grant metadata in cursor pages of at most 100 records, rotate active credentials, and revoke grants through the
authenticated facade. Rotation preserves the target client and exact capability set, replaces the old verifier
only after one append-only `grant_rotated` audit event succeeds, and never places the replacement token in the
audit ledger. An administrator can rotate only its own `capability_admin` grant and cannot delegate that
capability.
The facade derives `issuedBy` from the authenticated administrator rather than request data, and lifecycle
events are appended to the audit ledger without storing the returned bearer token. Ordinary model clients
cannot call grant-management operations unless a trusted launcher deliberately gave them the admin grant.

Daemon lifecycle control is a separate `daemon_control` capability; `capability_admin` alone cannot inspect
or stop the owner process. Like `capability_admin`, it can be bootstrapped only through the trusted launcher
and cannot be delegated by a service request. Status reports the live PID, instance id, project id, and start
time from the daemon-owned adapter. Shutdown requests must name the expected instance id, derive the requester
from the authenticated grant, and append a reserved `daemon_shutdown_requested` audit observation before
acceptance. The server half-closes the client socket with the complete response and invokes the daemon stop
callback only after that response is flushed; an audit failure or stale instance id leaves the daemon running.
Shadow/model observations cannot forge the reserved `daemon_*` evidence namespace.

Successful grant issue, rotation, and revocation mutations reserve a bounded in-memory retry receipt before
changing registry state. Reusing the same administrator credential, `requestId`, and canonical payload within
30 seconds replays the exact response instead of repeating the mutation; reusing the id with another payload
is rejected. This also lets a self-rotating administrator recover its replacement credential with only the exact
old request. Receipt capacity fails before mutation, entries expire without timers, and the cache is cleared on
shutdown. Replacement tokens may exist in this bounded process memory during the retry window but are never
written to daemon metadata, SQLite, argv, environment variables, or audit observations. This is daemon-lifetime
network retry protection, not durable replay across a process restart.

`GovernanceCredentialLeaseController` is an opt-in process-local holder for one self-rotating
`capability_admin` credential. It schedules renewal before expiry, reuses one request id across a bounded
three-attempt retry cycle, swaps its internal IPC client only after strict replacement identity validation,
and serializes ordinary requests behind an in-flight rotation. The controller never exposes the current token
in its snapshot. Retry exhaustion and expiry are terminal, observable states rather than unbounded healing
loops; configured timeout and retry windows must fit inside the server's retry-receipt TTL. Failure text is
bounded and credential-shaped values are redacted. Its referenced scheduler exists only after a trusted caller
explicitly creates and starts the controller, and `stop()` cancels the pending timer without revoking the
still-valid grant.

`connectGovernanceAdminSessionFromLaunch` and `connectGovernanceAdminSession` compose daemon discovery,
authenticated health, public self-grant inspection, and the lease controller for a trusted control-plane
holder. A session is created only when project, daemon instance, grant, client, expiry, and
`capability_admin` identity agree. `read_own_capability_grant` reveals only the authenticated caller's public
grant descriptor and never its token. Session snapshots contain daemon and lease status but no credential.
This admin session must not be passed to a model-facing tool surface; ordinary agents should receive narrowly
scoped child grants. Session `readDaemonStatus()` and `shutdownDaemon()` require a separately bootstrapped
`daemon_control` grant. `shutdownDaemon()` binds the request to the verified session metadata and stops lease
renewal only after the acceptance response arrives. Session `stop()` stops renewal only—it does not terminate
the detached project daemon or revoke the current grant.

This is not connected to production orchestration yet: there is no automatic runtime spawn, idle policy,
durable credential discovery, automatic lease-controller creation, cross-process token handoff, or legacy
runtime callsite.
The detached daemon currently uses the service's conservative default decision context; a trusted policy
adapter must be installed before command execution is enabled for production callers. Existing WrongStack
execution continues unchanged.
