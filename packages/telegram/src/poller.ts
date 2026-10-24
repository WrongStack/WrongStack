import type { Logger } from '@wrongstack/contracts/types';
import { type TelegramApiClient, TelegramBotApiError, TelegramNetworkError } from './api-client.js';
import type { OffsetStore } from './offset-store.js';
import type { PollLock } from './poll-lock.js';
export class Poller {
  private readonly api: () => TelegramApiClient;
  private pollIntervalMs: number;
  private readonly log: Logger;
  // Not readonly: start() swaps in a fresh controller when a previous stop()
  // aborted this one (see start()).
  private controller: AbortController;
  private readonly offsetStore?: OffsetStore | undefined;
  private readonly lock?: PollLock | undefined;
  private readonly standbyRetryMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private standbyTimer: ReturnType<typeof setTimeout> | null = null;
  private standbyAnnounced = false;
  private pollActive = false;
  private _startedAt: number | null = null;
  private offset = 0;
  /** The saved offset exists but could not be read; polls hold until it can. */
  private offsetUnreadable = false;
  private _conflictStreak = 0;
  // Supersede fence: bumped by handleLockLost()/stop() so an in-flight poll's
  // .finally re-arm cannot revive a chain that was replaced while it ran.
  // Without it, a lock re-acquire (or stop→start) landing mid-long-poll leaves
  // two live getUpdates chains — Telegram 409s then ping-pong between them and
  // both degrade to CONFLICT_POLL_MS backoff until restart.
  private chainEpoch = 0;
  private static readonly CONFLICT_BACKOFF_AFTER = 3;
  private static readonly CONFLICT_POLL_MS = 60_000;
  private readonly onCallbackQuery: (
    cq: import('./api-client.js').TelegramApiCallbackQuery,
  ) => void;
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
    if (this.lock) this.lock.onLost = () => this.handleLockLost();
    if (this.offsetStore) void this.loadOffset();
  }
  get active(): boolean {
    return this.pollActive;
  }
  get startedAt(): number | null {
    return this._startedAt;
  }
  get standby(): boolean {
    return this.pollActive && this.lock !== undefined && !this.lock.held;
  }
  get conflictStreak(): number {
    return this._conflictStreak;
  }
  setPollIntervalMs(pollIntervalMs: number): void {
    this.pollIntervalMs = pollIntervalMs;
  }
  start(): void {
    if (this.pollActive) return;
    this.pollActive = true;
    this._startedAt = Date.now();
    // A previous stop() aborted the injected controller. Reusing it here would
    // put an already-aborted signal on every future getUpdates — each poll
    // rejects (silently: err.aborted → return) and the loop zombies forever
    // while active===true. A restart must poll with a live signal.
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.acquireAndPoll();
  }
  stop(): void {
    this.pollActive = false;
    this.chainEpoch += 1;
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
    // Another instance may have polled (and persisted a newer offset) while
    // this one stood by. Its last batch is only confirmed server-side by a
    // getUpdates with a higher offset, so polling with the offset read at
    // construction would re-deliver that batch. loadOffset() is synchronous
    // in practice (no await), so the offset is current before schedulePoll.
    void this.loadOffset();
    if (this.standbyAnnounced) {
      this.standbyAnnounced = false;
      this.log.info('Telegram: poll lock acquired — taking over polling.');
    } else this.log.info(`Telegram bot polling started (${this.api().safeBaseUrl})`);
    this.schedulePoll();
  }
  handleLockLost(): void {
    if (!this.pollActive) return;
    this.chainEpoch += 1;
    // The lock defines delivery ownership, not only timer ownership. Abort a
    // getUpdates call already in flight so this instance cannot process an
    // update after another poller has taken over. The successor chain needs a
    // fresh signal when standby later re-acquires the lock.
    this.controller.abort();
    this.controller = new AbortController();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.warn(
      'Telegram: poll lock lost to another instance — pausing polling and standing by.',
    );
    this.standbyAnnounced = true;
    this.standbyTimer = setTimeout(() => this.acquireAndPoll(), this.standbyRetryMs);
    this.standbyTimer.unref?.();
  }
  schedulePoll(): void {
    if (!this.pollActive) return;
    if (this.lock && !this.lock.held) return;
    const delay =
      this._conflictStreak >= Poller.CONFLICT_BACKOFF_AFTER
        ? Poller.CONFLICT_POLL_MS
        : this.pollIntervalMs;
    const epoch = this.chainEpoch;
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => {
        // A poll that was still in flight across a supersede event (lock
        // lost + re-acquired, or stop→start) must not re-arm its old chain
        // on top of the successor — two live getUpdates chains make Telegram
        // 409 ping-pong between them and both decay to conflict backoff.
        if (epoch === this.chainEpoch) this.schedulePoll();
      });
    }, delay);
  }
  async poll(): Promise<void> {
    const epoch = this.chainEpoch;
    const signal = this.controller.signal;
    // Polling with a stale offset would re-deliver the last batch the previous
    // owner already handled (it is confirmed only by a higher offset).
    if (this.offsetUnreadable) {
      await this.loadOffset();
      if (this.offsetUnreadable) return;
    }
    try {
      const updates = await this.api().getUpdates({
        offset: this.offset,
        timeoutSeconds: 10,
        deadlineMs: 15_000,
        signal,
      });
      if (epoch !== this.chainEpoch || signal.aborted) return;
      this._conflictStreak = 0;
      for (const upd of updates) {
        if (epoch !== this.chainEpoch || signal.aborted) return;
        if (upd.update_id < this.offset) continue;
        if (upd.callback_query) {
          // Same poison-safety contract as the message path below: a failing
          // handler must not wedge the offset, or Telegram redelivers this
          // update on every poll and blocks everything behind it. Log,
          // acknowledge, move on.
          try {
            this.onCallbackQuery(upd.callback_query);
          } catch (err) {
            this.log.debug(
              `Telegram callback handler failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (epoch !== this.chainEpoch || signal.aborted) return;
          this.offset = upd.update_id + 1;
          continue;
        }
        const raw = upd.message ?? upd.edited_message;
        if (!raw?.text) {
          this.offset = upd.update_id + 1;
          continue;
        }
        // A failing handler must not wedge the offset: Telegram redelivers
        // every update at/after the requested offset, so failing to advance
        // past a poison update would re-fetch and re-fail it on every poll,
        // permanently blocking all later updates. Log, acknowledge, continue.
        try {
          this.onMessageUpdate(raw);
        } catch (err) {
          this.log.debug(
            `Telegram processMessage failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (epoch !== this.chainEpoch || signal.aborted) return;
        this.offset = upd.update_id + 1;
      }
      if (this.offsetStore && updates.length > 0) void this.saveOffset();
    } catch (err) {
      if (epoch !== this.chainEpoch || signal.aborted) return;
      if (err instanceof TelegramNetworkError && err.aborted) return;
      if (err instanceof TelegramBotApiError && err.errorCode === 409) {
        this._conflictStreak++;
        if (this._conflictStreak === Poller.CONFLICT_BACKOFF_AFTER)
          this.log.warn(
            this.lock
              ? 'Telegram: another consumer outside this machine is polling this bot token (HTTP 409) — backing off to 60s polls. Check other machines/bots using this token, or a registered webhook (deleteWebhook).'
              : 'Telegram: another instance is polling this bot token (HTTP 409) — backing off to 60s polls until it stops.',
          );
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
      this.offsetUnreadable = false;
      if (saved !== null && saved > this.offset) {
        this.offset = saved;
        this.log.debug(`Telegram polling offset restored: ${this.offset}`);
      }
    } catch (err) {
      if (!this.offsetUnreadable) {
        this.log.warn(
          `Telegram: cannot read the saved polling offset (${err instanceof Error ? err.message : String(err)}) — holding polls until it is readable.`,
        );
      }
      this.offsetUnreadable = true;
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
