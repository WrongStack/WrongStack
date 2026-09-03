import type { Logger } from '@wrongstack/core/types';
import { type TelegramApiClient, TelegramBotApiError, TelegramNetworkError } from './api-client.js';
import type { OffsetStore } from './offset-store.js';
import type { PollLock } from './poll-lock.js';
export class Poller {
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
  private _conflictStreak = 0;
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
  start(): void {
    if (this.pollActive) return;
    this.pollActive = true;
    this._startedAt = Date.now();
    this.acquireAndPoll();
  }
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
    } else this.log.info(`Telegram bot polling started (${this.api().safeBaseUrl})`);
    this.schedulePoll();
  }
  handleLockLost(): void {
    if (!this.pollActive) return;
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
        this.offset = upd.update_id + 1;
      }
      if (this.offsetStore && updates.length > 0) void this.saveOffset();
    } catch (err) {
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
      if (saved !== null) {
        this.offset = saved;
        this.log.debug(`Telegram polling offset restored: ${this.offset}`);
      }
    } catch {}
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
