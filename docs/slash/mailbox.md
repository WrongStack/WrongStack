# `/mailbox` - Operator mailbox commands

> ⚠️ **Operator only** — these commands require `WRONGSTACK_OPERATOR_ID` to be
> set and the calling identity to be the project operator. Non-operator users
> receive an error.

## Overview

The `/mailbox` slash command provides operator-level management of the project's
shared GlobalMailbox. It supports:

- **Dashboard** — `status` shows message counts, receipt breakdown, connected
  agents, credential health, and lock state.
- **Credential management** — `credential list`, `credential issue`, `credential
  revoke` for the identity credential system (GM-P0.6 / GM-P0.7).
- **Receipt inspection** — `receipt <msgId>` shows per-principal receipt state.
- **Compact** — `compact` triggers an LLM-driven compaction pass (GM-P0.5).
- **Send** — `send` is an interactive composition workflow with audience
  selection (`all` / `leaders`).
- **User settings** — `userConfig list|set|get|rm` manages local preferences
  (GM-P0.8).

## Identity enforcement

All `/mailbox` commands require:

1. `WRONGSTACK_OPERATOR_ID` environment variable set to a non-empty value.
2. The current principal identity must match that value.

If either condition is unmet, the command prints an error and exits.

## Credential commands

### `credential list`

```
/mailbox credential list
```

Outputs a table with columns: credential ID, principal ID, kind, capabilities,
status (active/revoked/expired), issue time, and expiry time.

### `credential issue <principalId> <kind> [capabilities...]`

```
/mailbox credential issue build-agent agent       mail.read.self mail.ack.self
/mailbox credential issue deploy-bot service       mail.read.all mail.events.all
/mailbox credential issue ci-operator operator     mail.admin.receipts mail.send.actionable
```

Prints the credential ID and the raw secret **once**. The secret is never stored
on disk — save it securely.

### `credential revoke <id> [reason]`

```
/mailbox credential revoke f1a2b3c4 rotated to new key
```

Revokes a credential immediately. Concurrent clients using this credential will
fail on their next request. Use after rotating to a new credential to minimize
downtime.

## Compaction

`/mailbox compact` triggers a bounded compaction pass:

- Aggregates complete message+receipt chains into compact entries.
- Preserves receipt state (readBy, completedBy).
- Respects the `compactThreshold` from the mailbox config (default 100 raw
  messages before compaction triggers).

## Dashboard output

```
Mailbox Status — project "wrongstack"
========================================
  Messages:         147
    Raw:             18
    Compacted:      129
  Unread:            12
  Agents online:     7

  Credentials:       5
    Active:           3
    Expired:          1
    Revoked:          1

  Receipt state:
    readBy:      2047 entries
    completedBy:  148 entries

  Lock:            2.3 KiB
  Last compact:    ~24m ago (2.3s)

  Operator:   leader@wrongstack (since 2026-07-20)
```

The credential section only appears when credentials are in use (at least one
issued or revoked credential).

## Code Reference

- `packages/cli/src/slash/mailbox-handler.ts` — dispatch
- `packages/core/src/coordination/mailbox-credential-store.ts` — credential store
- `packages/core/src/coordination/global-mailbox.ts` — message + receipt operations
