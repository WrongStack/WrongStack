# Telegram Plugin — Operations Runbook

**Applies to:** `@wrongstack/telegram` >= v0.293.0  
**Last updated:** 2026-07-28  
**Related:** `docs/adr/adr-003-telegram-broker-and-webhook.md`, `packages/telegram/README.md`

> Every migration and recovery step in this document is either **reversible** (the
> original state can be restored without data loss) or explicitly marked as
> **destructive** (the operation cannot be safely undone). Read the "Rollback"
> section of each procedure before acting.

---

## Table of Contents

1. [Legacy allow-all migration](#1-legacy-allow-all-migration)
2. [Token rotation after historic exposure](#2-token-rotation-after-historic-exposure)
3. [Pairing recovery](#3-pairing-recovery)
4. [Cursor reset consequences](#4-cursor-reset-consequences)
5. [409 / webhook conflict resolution](#5-409--webhook-conflict-resolution)
6. [Standby ownership takeover](#6-standby-ownership-takeover)
7. [Queue saturation](#7-queue-saturation)
8. [Health diagnostics](#8-health-diagnostics)
9. [Rollback procedures](#9-rollback-procedures)
10. [Release note checklist](#10-release-note-checklist)

---

## 1. Legacy allow-all migration

### Background

Versions before v0.283.0 treated an empty `allowedUsers` / `allowedChats` as
"allow everyone". This was changed in P0.1: empty lists now mean **no one** is
allowed, and `inboundMode` must be explicitly set to `"public"` to allow all.

### Detection

Run `/telegram-health` and check the `Allowed` line. If it shows
`everyone (users) / everyone (chats)`, your config still uses the legacy
behaviour but has been automatically upgraded to `inboundMode: "allowlist"`
(or `"paired"` if a `notifyChatId` existed).

### Migration steps

1. **Determine the desired access level:**

   - **Paired (single user):** The `notifyChatId` user is the only allowed
     inbound sender. Run `/telegram-setup` to pair, or manually set:
     ```
     /telegram-settings chat <userId>
     ```
     This sets `inboundMode: "paired"`, `allowedUsers: [<userId>]`,
     `allowedChats: [<chatId>]`.

   - **Allowlist (specific users/chats):** Run:
     ```
     /telegram-settings chat <chatId>
     ```
     Then edit `~/.wrongstack/profiles/<name>/config.json` to add
     `allowedUsers` and `allowedChats` lists. Setting `inboundMode: "allowlist"`
     enforces them.

   - **Public (anyone who finds the bot):** Explicitly set:
     ```
     /telegram-settings chat <chatId>
     ```
     Then edit the config to add `"inboundMode": "public"`. This is a
     **security-sensitive** choice — only use for bots that must accept
     unsolicited messages.

2. **Verify:** Run `/telegram-health` — the `Mode` and `Allowed` lines must
   reflect the intended policy. Send a test message from an allowed and a
   disallowed account to confirm.

### Rollback

**Reversible.** Restore the previous `inboundMode`, `allowedUsers`, and
`allowedChats` values from backup config. If no backup exists, set
`inboundMode: "disabled"` to block all inbound until the correct values are
determined.

---

## 2. Token rotation after historic exposure

### When to rotate

- The bot token was accidentally committed to a repository.
- The token appeared in a log file, error message, or chat transcript.
- The token was shared with a third party.
- A team member who had token access left the organisation.
- As a routine security measure (recommended every 6 months).

### Procedure

1. **Revoke the old token** from [@BotFather](https://t.me/BotFather)
   (`/revoke`).

2. **Generate a new token** from @BotFather (`/token`).

3. **Update the wstack config:**

   ```
   /telegram-setup
   ```
   Enter the new token at the masked prompt. The token is encrypted before
   being written to disk. It never appears in slash history, TUI transcript,
   or plaintext config.

4. **Restart the plugin** (or restart wstack) so the new token takes effect.
   The `botToken` field is classified as **restart-required** (P2.2) — a
   live config reload does NOT pick up a changed token.

5. **Verify:**
   - Run `/telegram-health` — must show `✅ @your_bot`.
   - Run `/telegram-settings test` — a test message must be delivered.

6. **(Optional) Revoke old webhooks:** If a webhook was registered with the
   old token, call `deleteWebhook` via the Telegram API:
   ```
   curl -X POST "https://api.telegram.org/bot<NEW_TOKEN>/deleteWebhook"
   ```

### Token safety rules

| Rule | Detail |
|---|---|
| Never paste token as a slash argument | `/telegram-setup` refuses inline tokens with a masked prompt. |
| Never log the token | `safeBaseUrl` redacts the token from all log output (`/bot[REDACTED]/getMe`). |
| Never echo the token in errors | `DefaultSecretScrubber` strips Bot API token patterns from error messages. |
| Encrypt at rest | `persistTelegramConfig` encrypts the token before writing to config. |

### Rollback

**Destructive.** The old token is permanently revoked by Telegram. There is
no way to un-revoke a token. Keep the new token accessible so you can
reconfigure if needed.

---

## 3. Pairing recovery

### Scenario: Paired chat is lost

The paired `notifyChatId` was deleted, the user blocked the bot, or the
config was lost.

### Recovery steps

1. **Discover eligible chats** by running `/telegram-setup` without arguments.
   This calls `getUpdates` to find recent chats that have messaged the bot.

2. If the bot was messaged from the desired account recently, it appears in
   the candidate list. Select its number to pair.

3. **If no candidates appear:**
   - Message the bot from the desired account (any text).
   - Wait 2–3 seconds, then run `/telegram-setup` again.
   - The account should now appear in the list.

4. **If the bot was blocked:**
   - Unblock the bot in Telegram.
   - Send any message to the bot.
   - Run `/telegram-setup` — it should now detect the chat.

5. **Manual pairing (advanced):**
   If the chat ID is known, run:
   ```
   /telegram-settings chat <knownChatId>
   ```
   This sets `notifyChatId` and registers the ID in `allowedOutboundChats`.
   For private chats, it also sets `inboundMode: "paired"`.

### Verifying pairing

Run `/telegram-settings test`. If the test message arrives, pairing is
successful.

### Rollback

**Reversible.** Restore the previous `notifyChatId` value from backup config,
or re-run `/telegram-setup` with the original chat.

---

## 4. Cursor reset consequences

### What the cursor does

The polling cursor (`offset`) tracks which updates have been received.
When persisted (via `offset-store`), it survives restarts so the same
updates are not replayed. The per-chat inbox cursor (`inbox-cursor-store`)
tracks which messages the agent acknowledged via `telegram_read`.

### When cursors reset

- **offsetStoragePath is unset or empty-string:** the cursor is in-memory
  only and resets on every plugin restart. Updates since the last restart
  are replayed.

- **offsetStoragePath is set but the file is deleted:** same effect as
  above — the cursor starts at 0 and replays all available updates.

- **offsetStoragePath file is corrupted:** the store rejects corrupt files
  with an error (logged at `warn` level) and starts from 0.

### Consequences of a cursor reset

| Effect | Detail |
|---|---|
| Update replay | Every update currently in Telegram's 24-hour buffer is re-delivered. The P1.6 deduplication guard (`update_id <= previous offset`) cannot prevent this because the previous offset is lost. |
| Duplicate notifications | If the bot sends automatic notifications based on updates (e.g., session-ended), replayed updates could trigger duplicate notifications. |
| No data loss | No data is permanently lost — the agent sees the same messages again. |
| Inbox reset | The per-chat inbox cursor is separate; it retains its position unless its file is also deleted. |

### Safe cursor reset procedure

If a cursor reset is intentional (e.g., migrating to a new machine):

1. **Stop the bot** (stop wstack or disable the Telegram plugin).
2. **Delete the cursor files:**
   ```
   rm ~/.wrongstack/telegram/offset-<tokenHash>.json
   rm ~/.wrongstack/telegram/inbox-<tokenHash>-*.json
   ```
   Find the exact filenames by checking `~/.wrongstack/telegram/`.
3. **Restart the bot.** Updates will be replayed from the Telegram buffer
   (up to 24 hours old).
4. **Monitor for duplicate notifications.** The P3.1 telemetry snapshot
   shows `upd_dedup` — if this spikes, the replay is working correctly.

### Rollback

**Reversible** — only if the cursor files were backed up before deletion.
Restore the backup files before restarting the bot. Without a backup, the
cursor is permanently lost and updates since the last commit are replayed.

---

## 5. 409 / Webhook conflict resolution

### What causes 409

`HTTP 409 Conflict` on `getUpdates` means **another consumer is already
polling this bot token**. Telegram allows exactly one `getUpdates` call at a
time per token.

### Detection

- `/telegram-health` shows `Conflicts: N streak` at the bottom.
- Polling is backed off to 60s after 3 consecutive conflicts.
- The plugin logs a warning: `another consumer outside this machine is
  polling this bot token (HTTP 409)`.

### Common causes

| Cause | Resolution |
|---|---|
| Another wstack instance (TUI + WebUI) | One holds the lock; the other stands by. This is normal. Check `/telegram-health` for the lock owner. |
| Another bot polling the same token outside wstack | Find and stop the other process. If it's a webhook, call `deleteWebhook`. |
| A registered webhook conflicts with polling | Call `deleteWebhook` to remove the webhook; polling resumes automatically. |
| Stale lock file from a crashed instance | The lock file auto-expires after 45s (30s in v0.295+). Wait for the stale heartbeat timeout. |

### Resolving webhook conflicts

If a webhook was previously registered (e.g., via another bot framework):

1. Call `deleteWebhook` from any HTTP client:
   ```
   curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
   ```
2. The next `getUpdates` call will succeed. No restart needed.
3. Verify: `/telegram-health` shows `Conflicts: none`.

### Resolving external poller conflicts

1. Identify the external process:
   ```
   # On Linux/macOS
   lsof -i :443 | grep telegram
   
   # Check lock file ownership
   cat ~/.wrongstack/telegram/poll-<hash>.lock
   ```
2. Stop the external process or configure it to use a different token.
3. The wstack lock file may take up to 45s to expire. Wait, or delete the
   lock file manually if you are certain no other instance is polling:
   ```
   rm ~/.wrongstack/telegram/poll-<hash>.lock
   ```

### Rollback

**Reversible.** Restoring a webhook requires calling `setWebhook` with the
previous URL and secret_token. Note that `setWebhook` automatically stops
polling — do not call it while polling is active unless you intend to switch
to webhook mode.

---

## 6. Standby ownership takeover

### How standby works

When a wstack instance fails to acquire the poll lock (another instance
holds it), it enters **standby mode**. The standby:
- Does NOT call `getUpdates` (Telegram never sends it updates).
- Retries lock acquisition every 15s (10s in v0.295+).
- Shows `Mode: standby` in `/telegram-health`.
- Returns stale buffered messages for `telegram_read`.
- Cannot receive callback queries for `telegram_approve`.

### Takeover triggers

The standby takes over polling when:

1. **The current holder stops gracefully.** The holder's `stop()` method
   releases the lock file. The next standby retry acquires it.

2. **The current holder's heartbeat expires.** The holder writes a heartbeat
   to the lock file every 15s (10s in v0.295+). If the heartbeat is older
   than 45s (30s in v0.295+), the lock is considered stale. The next standby
   retry acquires it.

3. **The lock file is deleted manually.** The standby acquires the lock on
   the next retry.

### Accelerating takeover

1. Stop the holding instance gracefully (exit wstack or disable the plugin).
2. The lock file is released immediately.
3. The standby acquires it within the retry interval (15s/10s).

If the holding instance is unreachable (crashed, network partition), wait
for the staleness timeout (45s/30s). **Do not delete the lock file manually**
unless you are certain no other instance is alive — deleting a live lock
creates a race condition.

### Verifying takeover

- `/telegram-health` changes from `Mode: standby` to `Mode: active`.
- The `Owner` line shows the new process pid.
- Incoming messages start flowing to this instance.

### Rollback

**Reversible.** The new holder can be displaced by a higher-priority instance
using the same lock mechanism — the last one to acquire wins. To force
rollback, restart the original holder; it will attempt to acquire the lock
and displace the current standby-turned-holder.

---

## 7. Queue saturation

### What causes queue saturation

The outbound queue has a per-chat pending limit (default 32) and a global
concurrency limit (default 4). Saturation occurs when:

- A rapid burst of notification events (session-ended, tool-executed,
  delegate-completed) exceeds the per-chat limit.
- The Telegram API is slow to respond (rate-limited, network issues).

### Detection

- `/telegram-health` shows `Queue: N pending · M in-flight`.
- Telemetry snapshot (every 5min) reports `queue_drop=N` and `queue_fail=N`.
- If `queue_drop` is increasing, notifications are being discarded.

### Resolution

| Situation | Action |
|---|---|
| Burst of notifications | **Normal.** Older pending notifications are dropped to keep the queue bounded. Manual sends are never dropped — they error to the caller. |
| Prolonged queue growth | Check Telegram API reachability. Run `/telegram-settings test`. If the test fails, there is a network issue. |
| Concurrency bottleneck | Increase `outboundQueueConcurrency` in config (restart-required). |
| Per-chat bottleneck | Increase `outboundQueuePerChat` in config (restart-required). |

### Adjusting queue parameters

```
# Edit the profile config directly:
~/.wrongstack/profiles/<name>/config.json

# Under extensions.telegram, add:
{
  "outboundQueuePerChat": 64,
  "outboundQueueConcurrency": 8
}
```

Both fields are **restart-required** — the plugin must be restarted for
changes to take effect.

### Rollback

**Reversible.** Restore the previous queue parameter values and restart.

---

## 8. Health diagnostics

### Quick health check

```
/telegram-health
```

Expected output for a healthy bot:

```
═══ Telegram Plugin Status ═══

Bot:       ✅ @my_bot
Mode:      active
Running:   yes
Started:   10:15:42

── Transport ──
Poll:      every 2s
Last poll: 10:22:37 · success
Cursor:    14235
Conflicts: none
API err:   none

── Authorization ──
Allowed:   1 users / 1 chats
Rejected:  0 unauthorized

── Outbound ──
Queue:     0 pending · 0 in-flight
Retries:   0 total

── Notifications ──
Session:   off
Delegate:  on
Long tool: 30000ms

── Lock ──
Owner:     pid 12345 · abcdef12…
```

### Common health states

| Mode | Polling | Reads | Approvals | Action needed |
|---|---|---|---|---|
| `active` | Yes | Live | Live | None |
| `standby` | No | Stale only | Not available | Wait for takeover, or stop the active instance |
| `degraded` | Failing | Buffer only | Buffer only | Check token, network, webhook conflicts |

### Diagnostic commands

| Command | What it checks |
|---|---|
| `/telegram-health` | Full transport state, queue depth, lock owner |
| `/telegram-settings` | Notification config and token presence |
| `/telegram-settings test` | End-to-end: sends a test message |
| `/telegram:chatid` | Shows the configured `notifyChatId` |

### Log-based diagnostics

The plugin logs a structured metrics snapshot every 5 minutes. Grep for
`[telegram.metrics]` in the wstack log output:

```
[telegram.metrics] polls=142/143 upd_accepted=87 upd_rejected=3
upd_dedup=2 retries=1 queue_pend=0 queue_inflight=0 queue_drop=0
queue_fail=0 approvals_settled=12 approvals_timeout=1 locks_acq=1 locks_lost=0
```

Key metrics to watch:

| Metric | Normal | Warning |
|---|---|---|
| `polls=ok/total` | >0.95 | <0.8 means many poll failures |
| `upd_dedup` | Low | Spike indicates cursor reset |
| `queue_drop` | 0 | >0 means notifications are being dropped |
| `approvals_timeout` | <0.1 * approvals | Spike indicates network issues |
| `locks_lost` | 0 | >0 means another instance is taking over |

---

## 9. Rollback procedures

### Rollback a config change

Every `/telegram-settings` command writes to a JSON config file. The
`persistTelegramConfig` function encrypts, writes atomically, and updates the
in-memory config store.

To rollback a single setting:

1. Note the current value with `/telegram-settings` before changing.
2. Re-run `/telegram-settings` with the original value.
3. Verify the change with `/telegram-settings`.

Alternatively, edit the config file directly:

```
~/.wrongstack/profiles/<name>/config.json
```

Under `extensions.telegram`, set the field to its previous value. The
plugin picks up the change automatically (hot keys) or on restart
(restart-required keys).

### Rollback a plugin upgrade

1. Stop wstack.
2. Install the previous version:
   ```
   npm install @wrongstack/telegram@<previous-version>
   ```
3. Start wstack. Verify with `/telegram-health`.

### Rollback a full deployment

1. Revert the git commit that included the Telegram changes.
2. Rebuild and restart.
3. Run the P3 Release Gate verification steps.

---

## 10. Release note checklist

For every release that includes Telegram plugin changes, verify:

### Behaviour changes

- [ ] Inbound policy changes documented (`inboundMode` defaults, migration warnings).
- [ ] New config fields listed with their hot/restart classification.
- [ ] Changed default values called out with migration guidance.
- [ ] Removed features or deprecated commands documented with alternatives.

### Security

- [ ] Any change to token handling, logging, or secret scrubbing is explicitly noted.
- [ ] New API endpoints or webhook URLs are documented with authentication requirements.
- [ ] Cursory review: no token/message body leaks in the diff.

### Operations

- [ ] Cursor file format changes are documented (delete/rebuild required?).
- [ ] Lock file format changes are documented (old lock files expire automatically?).
- [ ] New dependency (e.g., database, HTTP server) is called out.
- [ ] Restart required vs hot-reload — every config field correctly classified.

### Verification commands

Record the exact commands and expected output for post-release smoke tests:

```bash
# 1. Health check
/telegram-health

# 2. Test message
/telegram-settings test

# 3. Full test suite
pnpm --filter @wrongstack/telegram test

# 4. Typecheck
pnpm --filter @wrongstack/telegram typecheck

# 5. Manifest parity (checks docs match implementation)
pnpm --filter @wrongstack/telegram test -- tests/unit/manifest-parity.test.ts
```
