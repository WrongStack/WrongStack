import type { Logger } from '@wrongstack/core/types';
import { type TelegramApiClient, TelegramBotApiError, TelegramNetworkError } from './api-client.js';
import type { OffsetStore } from './offset-store.js';
import type { PollLock } from './poll-lock.js';

/**
 * Telegram long-poll loop (card 7A-3).
 *
 * Owns: standby/lock acquisition retry, the poll cadence (including the
 * 409-conflict backoff to 60s after 3 consecutive conflicts), the update
 * cursor with its idempotency boundary, and offset persistence.
 *
 * ## P1.6 cursor contract (must not regress)
 * The cursor is committed to the OffsetStore only after a non-empty poll
 * that processed at least one update: `if (offsetStore && updates.length > 0)
 * void saveOffset()`. An empty poll or a 0 -> 0 idle tick MUST NOT trigger
 * a write. Replay dedup is preserved by `offset = update_id + 1` combined
 * with Telegram's `offset=N` contract, plus the `< this.offset` skip that
 * drops already-processed updates a proxy/replay might return.
 *
 * Moved verbatim from bot.ts (poll/schedulePoll/acquireAndPoll/
 * handleLockLost/loadOffset/saveOffset); the bot keeps a public readonly
 * `poller` plus thin lifecycle delegates.
 */
export class Poller {
  /**
   * Live api accessor — called at use time, NOT captured at construction
   * (card 7A-2 lesson): tests replace `bot.api` after setup via
   * Object.assign, so a captured instance would never see the mock.
   */
  private readonly api: () => TelegramApiClient;
  private readonly pollIntervalMs: number;
  private readonly log: Logger;
  private readonly controller: AbortController;
  private readonly offsetStore?: OffsetStore | undefined;
  private readonly lock?: PollLock | undefined;
  private readonly standbyRetryMs: number;

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private standbyTimer: ReturnType<typeof setTimeout> | null = null;
  private standbyAnnounced = false;
  private pollActive = false;
  private _startedAt: number | null = null;
  private offset = 0;

  /**
   * Consecutive HTTP 409 ("another getUpdates in flight") responses. Two
   * wstack instances polling the same bot token used to fight at full poll
   * speed forever, erroring on every cycle. After CONFLICT_BACKOFF_AFTER
   * consecutive conflicts this instance backs off to a slow poll and warns
   * once; any successful poll resets to the normal cadence.
   */
  private _conflictStreak = 0;
  private static readonly CONFLICT_BACKOFF_AFTER = 3;
  private static readonly CONFLICT_POLL_MS = 60_000;

  /** Called for each update that is a callback_query. */
  private readonly onCallbackQuery: (
    cq: import('./api-client.js').TelegramApiCallbackQuery,
  ) => void;
  /** Called for each update that carries a message/edited_message. */
  private readonly onMessageUpdate: (msg: import('./api-client.js').TelegramApiMessage) => void;

  constructor(deps: {
    api: () => TelegramApiClient;
    pollIntervalMs: number;
    log: Logger;
    controller: AbortController;
    offsetStore?: OffsetStore | undefined;
    lock?: PollLock | undefined;
    standbyRetryMs: number;
    onCallbackQuery: Poller['onCallbackQuery'];
    onMessageUpdate: Poller['onMessageUpdate'];
  }) {
    this.api = deps.api;
    this.pollIntervalMs = deps.pollIntervalMs;
    this.log = deps.log;
    this.controller = deps.controller;
    this.offsetStore = deps.offsetStore;
    this.lock = deps.lock;
    this.standbyRetryMs = deps.standbyRetryMs;
    this.onCallbackQuery = deps.onCallbackQuery;
    this.onMessageUpdate = deps.onMessageUpdate;
    if (this.lock) {
      this.lock.onLost = () => this.handleLockLost();
    }
    // Restore persisted offset so a crash/restart doesn't cause message replay.
    if (this.offsetStore) {
      void this.loadOffset();
    }
  }

  get active(): boolean {
    return this.pollActive;
  }

  get startedAt(): number | null {
    return this._startedAt;
  }

  /** True when polling is started but waiting for the poll lock. */
  get standby(): boolean {
    return this.pollActive && this.lock !== undefined && !this.lock.held;
  }

  /** Consecutive HTTP 409 responses at last poll — observability for the
   * 60s backoff threshold (public getter, not a private-field seam). */
  get conflictStreak(): number {
    return this._conflictStreak;
  }

  /** Start polling for updates. Idempotent. */
  start(): void {
    if (this.pollActive) return;
    this.pollActive = true;
    this._startedAt = Date.now();
    this.acquireAndPoll();
  }

  /** Stop polling and cancel all in-flight requests. Lock release and
   * approval cancellation stay with the bot's own stop() composition. */
  stop(): void {
    this.pollActive = false;
    this.controller.abort();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.standbyTimer) {
      clearTimeout(this.standbyTimer);
      this.standbyTimer = null;
    }
  }

  /**
   * Acquire the poll lock (when configured) and start the poll loop, or
   * stand by and retry until the current holder releases it.
   */
  acquireAndPoll(): void {
    if (!this.pollActive) return;
    if (this.lock && !this.lock.tryAcquire()) {
      if (!this.standbyAnnounced) {
        this.standbyAnnounced = true;
        this.log.info(
          'Telegram: another wstack instance is already polling this bot token — standing by; will take over when it stops.',
        );
      }
      this.standbyTimer = setTimeout(() => this.acquireAndPoll(), this.standbyRetryMs);
      this.standbyTimer.unref?.();
      return;
    }
    if (this.standbyAnnounced) {
      this.standbyAnnounced = false;
      this.log.info('Telegram: poll lock acquired — taking over polling.');
    } else {
      this.log.info(`Telegram bot polling started (${this.api().safeBaseUrl})`);
    }
    this.schedulePoll();
  }

  /** The lock was stolen while we held it — pause polling and stand by. */
  handleLockLost(): void {
    if (!this.pollActive) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.warn(
      'Telegram: poll lock lost to another instance — pausing polling and standing by.',
    );
    this.standbyAnnounced = true; // acquireAndPoll already announced via this warn
    this.standbyTimer = setTimeout(() => this.acquireAndPoll(), this.standbyRetryMs);
    this.standbyTimer.unref?.();
  }

  schedulePoll(): void {
    if (!this.pollActive) return;
    // Lost the poll lock mid-flight — the standby retry loop owns recovery.
    if (this.lock && !this.lock.held) return;
    const delay =
      this._conflictStreak >= Poller.CONFLICT_BACKOFF_AFTER
        ? Poller.CONFLICT_POLL_MS
        : this.pollIntervalMs;
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll());
    }, delay);
  }

  async poll(): Promise<void> {
    try {
      const updates = await this.api().getUpdates({
        offset: this.offset,
        timeoutSeconds: 10,
        deadlineMs: 15_000,
        signal: this.controller.signal,
      });
      this._conflictStreak = 0;

      for (const upd of updates) {
        // Telegram normally honors `offset`, but a proxy/replay or a test
        // transport can return an already-processed update. Keep the cursor as
        // the local idempotency boundary instead of dispatching duplicates.
        if (upd.update_id < this.offset) continue;
        if (upd.callback_query) {
          this.onCallbackQuery(upd.callback_query);
          this.offset = upd.update_id + 1;
          continue;
        }

        const raw = upd.message ?? upd.edited_message;
        if (!raw?.text) {
          this.offset = upd.update_id + 1;
          continue;
        }
        try {
          this.onMessageUpdate(raw);
          this.offset = upd.update_id + 1;
        } catch (err) {
          this.log.debug(
            `Telegram processMessage failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Do not advance the cursor — Telegram will resend this update.
          // Stop the batch so later ids are not skipped while this one retries.
          break;
        }
      }

      // P1.6: commit the cursor only after processing. An empty poll or a
      // 0 -> 0 idle tick MUST NOT trigger a write. Require updates.length > 0
      // so a successful but empty poll leaves the persisted offset
      // unchanged — preserves the replay dedup boundary on restart.
      if (this.offsetStore && updates.length > 0) void this.saveOffset();
    } catch (err) {
      if (err instanceof TelegramNetworkError && err.aborted) return;
      if (err instanceof TelegramBotApiError && err.errorCode === 409) {
        this._conflictStreak++;
        if (this._conflictStreak === Poller.CONFLICT_BACKOFF_AFTER) {
          this.log.warn(
            this.lock
              ? 'Telegram: another consumer outside this machine is polling this bot token (HTTP 409) — backing off to 60s polls. Check other machines/bots using this token, or a registered webhook (deleteWebhook).'
              : 'Telegram: another instance is polling this bot token (HTTP 409) — backing off to 60s polls until it stops.',
          );
        }
        this.log.debug(`Telegram getUpdates failed: ${err.description}`);
        return;
      }
      this.log.debug(`Telegram poll error: ${(err as Error).message}`);
    }
  }

  async loadOffset(): Promise<void> {
    if (!this.offsetStore) return;
    try {
      const saved = this.offsetStore.read();
      if (saved !== null) {
        this.offset = saved;
        this.log.debug(`Telegram polling offset restored: ${this.offset}`);
      }
    } catch {
      // Best-effort — a corrupt or missing file starts from 0.
    }
  }

  async saveOffset(): Promise<void> {
    if (!this.offsetStore) return;
    try {
      this.offsetStore.write(this.offset);
    } catch (err) {
      this.log.debug(`Failed to persist Telegram offset: ${err}`);
    }
  }
}
