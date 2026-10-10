---
name: offline-sync
description: "Implement offline-capable applications with local persistence, queued changes and explicit synchronization conflicts. Use when users must work without a stable connection or resume drafts across interruptions; define data ownership and conflict semantics before retrying writes."
trigger: "Implement offline-capable applications with local persistence, queued changes and explicit synchronization conflicts. Use when users must work without a stable connection or resume drafts across interruptions; define data ownership and conflict semantics before retrying writes."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: data
  domain: "product"
---

# Offline Sync

## Selection card
- Task: Reconcile offline edits, outboxes and conflicts.
- Start: Identify the data owner, query/schema, consistency and recovery contract.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Implement offline-capable applications with local persistence, queued changes and explicit synchronization conflicts.

Verify current persistence/sync libraries against the chosen browser/mobile runtime. Latest SDK versions do not define application conflict policy.

## Rules

1. Separate local durable state, pending mutations, server acknowledgement and presented UI state.
2. Give queued mutations stable identity and replay/idempotency semantics across restart.
3. Specify conflict rules from domain behavior: version checks, mergeable fields, user decisions or server precedence.
4. Scope cached/private data by account/tenant and define logout, revocation and deletion behavior.
5. Bound retry/backoff and queue growth; connection available does not guarantee authenticated server availability.
6. Handle schema evolution for persisted local records; app upgrades can resume an older queue.

## Workflow

1. Map online/offline/interrupted states and which tasks must remain available.
2. Implement persistence and mutation queue using existing data boundaries.
3. Test disconnect before/after server commit, duplicate delivery and app restart.
4. Force two-client conflicts and verify the stated resolution behavior.
5. Exercise logout/account switch and migration of existing local state.

## Before returning

Local/server ownership and conflict policy explicit; restart/replay/duplicate cases tested; private caches isolated; unsynced state visible.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/).

## Skills in scope

- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- api-design — api design contracts and verification.
- react-native-expo — build and upgrade React Native or Expo applications with navigation, native modules and verified platform integration.
- flutter-mobile — build and upgrade Flutter applications with typed state, navigation, platform plugins and device verification.
- testing — testing contracts and verification.
