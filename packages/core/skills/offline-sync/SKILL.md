---
name: offline-sync
description: "Offline-first apps: IndexedDB, SQLite on OPFS, Expo SQLite, service workers, mutation outboxes, sync cursors and conflicts. Use when users must keep working without a connection, drafts must survive restarts, or offline edits must reconcile with the server without duplicates or silent overwrites. Not for live push between online clients (use realtime-systems) or server queue workers (use queues-jobs)."
trigger: "Use when a change adds local persistence, an offline outbox, background sync, service worker caching or conflict handling to a web or mobile app."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: data
  domain: "product"
---

# Offline Sync

## Selection card
- Task: Build or repair local persistence, the mutation outbox and server reconciliation with explicit conflict and account rules.
- Start: Read the local storage layer and its schema version, the outbox or sync engine config, the server write endpoints (idempotency, versioning), and logout handling.
- Finish: edits made offline survive reload and app restart, replay exactly once after reconnect (including a lost response), conflicts resolve per the stated policy, and account switches leak nothing.

## Overview

Offline sync is distributed systems on hardware you do not control: clocks drift, storage gets evicted, two tabs replay the same outbox, and a request can succeed on the server while the client sees a network error.
Verify current persistence/sync libraries against the chosen browser/mobile runtime. Latest SDK versions do not define application conflict policy.

## Rules

1. Keep four things apart in storage and UI: last-known server state, the pending outbox, the optimistic view derived from both, and failed or conflicted mutations that need the user.
2. Every outbox entry carries a client-generated ID (used as the server's idempotency key), the target entity ID, its `baseVersion` and a payload schema version. The server stores each mutation's result, so a replay after a lost response returns the original outcome.
3. Decide conflict policy per operation before building UI: field-level merge or last-writer-wins on server-assigned versions for independent fields, server rejection with the current record (`409` or `412`) for invariants like stock and money, CRDTs (Yjs, Automerge) for collaborative text. Never resolve by device wall-clock time.
4. One replayer per device: tabs coordinate through the Web Locks API (`navigator.locks.request`) or a leader elected over BroadcastChannel, and mobile background tasks share the foreground lock.
5. Partition local data by user and tenant. On logout, revocation or account switch, purge or seal private stores and the pending outbox, and ask before discarding unsent work.
6. `navigator.onLine` and NetInfo connectivity mean "has a network", not "server reachable": drive retries from real request outcomes with jittered backoff, and pause on 401/403 until re-authentication instead of burning retries.
7. Local schema migrations also upgrade queued outbox entries; an app update must never silently drop unsent work.
8. Delta sync carries deletes as tombstones, and the server tells a client when its cursor is too old for a delta so it performs a full resync instead of silently skipping changes.

## First moves by situation

| Situation | First moves |
|---|---|
| New offline feature | Decide what works offline (read-only or writes); choose storage (IndexedDB via Dexie or idb, SQLite WASM on OPFS, Expo SQLite, WatermelonDB) or a sync engine; define outbox and conflict policy before UI |
| Duplicates after reconnect | Server lacks mutation-ID idempotency, or two tabs replayed the same outbox; check the server's dedupe table and the replay lock |
| Data gone after days away (Safari) | Request `navigator.storage.persist()`; Safari's tracking prevention deletes script-writable storage for sites without user interaction in seven days unless installed to the home screen; monitor `navigator.storage.estimate()` |
| IndexedDB `TransactionInactiveError` | The code awaited a non-IndexedDB promise (fetch, crypto) inside a transaction, which auto-committed; do network work before or after |
| Database upgrade `blocked` | Another tab holds the old version open; handle `versionchange` by closing the connection and prompting a reload |
| Stale app after deploy | A new service worker waits until every tab closes; forcing `skipWaiting` swaps code under pages whose local schema may not match, so prompt for reload and version caches |
| Expecting background sync | The Background Sync API is Chromium-only; replay on app start, `online` and `visibilitychange` everywhere; mobile OS background tasks are best-effort |
| Choosing a sync engine | Compare PowerSync, ElectricSQL, Replicache or Zero, RxDB and Couchbase Lite on auth integration, partial replication rules, conflict model and self-hosting; MongoDB Atlas Device Sync reached end of life, so do not start on it |

## Patterns and pitfalls

- **Disconnect after commit** — the server commits, the response is lost, the client retries; without a stored result per mutation ID the retry duplicates the write or reports a false conflict.
- **Ordering and dependencies** — replay mutations for one entity in order; a rejected create must hold its dependent updates; client-generated IDs avoid temporary-ID remapping across related records.
- **Compaction** — collapse several edits of one entity only for operations that are safe to merge, keeping the first entry's `baseVersion`.
- **Clock skew** — device clocks are off by minutes or hours; order with server versions or hybrid logical clocks.
- **CRDT growth** — histories and tombstones grow without bound; snapshot or compact documents and cap retained history.
- **Auth while offline** — tokens expire during long offline periods; refresh on reconnect before replaying; never persist tokens inside outbox entries.
- **Attachments** — blobs need their own resumable upload queue; metadata mutations reference blobs by client ID and tolerate a pending upload.
- **Local data at rest** — IndexedDB and plain SQLite are not encrypted; on shared or managed devices keep sensitive data out, or encrypt with keys held in the OS keychain.
- **SQLite in the browser** — OPFS synchronous access handles work only in dedicated workers; check which SQLite WASM VFS is used, since some require cross-origin isolation (COOP/COEP headers) and others limit concurrency.
- **Expo SQLite transactions** — `withTransactionAsync` is not exclusive, so other queries can interleave; outbox claims and migrations belong in `withExclusiveTransactionAsync()`.
- **Quota errors** — a `QuotaExceededError` on write must reach the user; swallowing it loses edits silently.

## Workflow

1. Map states: online, offline, flaky, lost response, app killed mid-replay, logged out with pending work.
2. Define the contract with the server: mutation ID handling, version preconditions, conflict responses, delta cursor and tombstones, full-resync trigger.
3. Write failing tests first for disconnect-after-commit, double replay from two tabs, two-client conflict and account switch.
4. Implement storage, outbox, single replayer and conflict handling on existing data boundaries.
5. Migrate existing local data and queued entries; test an upgrade from the previous app version.
6. Report which runtimes (browsers, iOS, Android) were exercised and which eviction or background limits remain.

## Proof

- Offline round trip: Playwright `context.setOffline(true)`, make edits, reload, `context.setOffline(false)`, then assert server state matches the local view
- Lost response: a test hook or proxy drops the response after the server commits; after replay the server holds exactly one row
- Two tabs: two pages in one browser context with pending work; the server receives each mutation once
- Conflict: two clients edit the same entity offline and reconnect; the result matches the stated policy and the losing edit is surfaced, not discarded
- Account switch: user A queues edits, logs out, user B logs in; none of A's data is visible and A's outbox is not sent with B's credentials
- Upgrade: queue mutations on the previous version, upgrade, and confirm they replay
- Mobile: airplane mode on a device or emulator, kill the app mid-queue, relaunch, and confirm replay

## Stop and ask

- The fix would discard or overwrite unsent user work.
- Conflict policy for money, inventory or permissions has not been decided by the product owner.
- Adopting a sync engine or hosted backend, or changing the server's write contract used by other clients.
- Sensitive data would be stored locally without encryption on shared devices.

## Before returning

- [ ] Server state, outbox, optimistic view and conflicts stored and displayed separately
- [ ] Outbox entries carry mutation ID, `baseVersion` and schema version; server deduplicates and returns stored results
- [ ] Conflict policy written per operation and proven with a two-client test
- [ ] Single replayer per device proven with two tabs or background plus foreground
- [ ] Local data partitioned by account; logout and account switch purge or seal it
- [ ] Reload, restart, lost-response replay and app-upgrade migration verified

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/), [Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API).

## Skills in scope

- database-development — server-side version checks, idempotency tables and delta queries.
- api-design — `Idempotency-Key`, `If-Match` preconditions, `409` payloads and delta sync cursors.
- react-native-expo — Expo SQLite, background tasks and connectivity in React Native apps.
- flutter-mobile — local databases and background sync in Flutter apps.
- realtime-systems — live invalidation that tells online clients to pull deltas.
- testing — simulated offline transitions, duplicate replay and two-client conflict tests.
