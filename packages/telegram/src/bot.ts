import type { Logger } from '@wrongstack/core/types';
import { TelegramApiClient } from './api-client.js';
import {
  ApprovalFlow,
  type TelegramApprovalRequestInput,
  type TelegramApprovalResult,
} from './approval-flow.js';
import type { TelegramBotOptions } from './bot-types.js';
import { TelegramInbox } from './inbox.js';
import type { PollLock } from './poll-lock.js';
import { Poller } from './poller.js';
import { TelegramOutbox } from './outbox.js';

export type {
  TelegramBotOptions,
  TelegramBotResponse,
  TelegramIncomingMessage,
} from './bot-types.js';
export type { TelegramApprovalRequestInput, TelegramApprovalResult } from './approval-flow.js';
export { escapeHtml, truncateForTelegram } from './text-format.js';

export class TelegramBot {
  private readonly api: TelegramApiClient;
  private readonly log: Logger;
  private readonly lock?: PollLock | undefined;
  readonly approvals: ApprovalFlow;
  readonly poller: Poller;
  readonly inbox: TelegramInbox;
  private readonly outbox: TelegramOutbox;
  constructor(opts: TelegramBotOptions) {
    this.api = new TelegramApiClient({ token: opts.token });
    this.log = opts.log;
    this.lock = opts.lock;
    this.inbox = new TelegramInbox({
      log: this.log,
      allowedUsers: opts.allowedUsers,
      allowedChats: opts.allowedChats,
      bufferMax: opts.bufferSize,
      onMessage: opts.onMessage,
      sendNotice: (chatId, text) => this.sendMessage(chatId, text),
    });
    this.outbox = new TelegramOutbox({
      log: this.log,
      api: () => this.api,
      getParseMode: opts.getParseMode,
    });
    this.approvals = new ApprovalFlow({
      log: this.log,
      api: () => this.api,
      inboundDenialReason: (userId, chatId) => this.inbox.denialReason(userId, chatId),
    });
    this.poller = new Poller({
      api: () => this.api,
      pollIntervalMs: opts.pollIntervalSec * 1000,
      log: this.log,
      controller: new AbortController(),
      offsetStore: opts.offsetStore,
      lock: opts.lock,
      standbyRetryMs: opts.standbyRetryMs ?? 15_000,
      onCallbackQuery: (cq) => {
        void this.approvals
          .dispatchCallback(cq)
          .catch((err) =>
            this.log.debug(
              `Callback dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      },
      onMessageUpdate: (msg) => this.processMessage({ ...msg, text: msg.text! }),
    });
  }
  start(): void {
    this.poller.start();
  }
  stop(): void {
    this.poller.stop();
    this.approvals.cancelAll('shutdown');
    this.lock?.release();
    this.log.info('Telegram bot stopped');
  }
  get standby(): boolean {
    return this.poller.standby;
  }
  get startedAt(): number | null {
    return this.poller.startedAt;
  }
  get running(): boolean {
    return this.poller.active;
  }
  getMessages(opts?: {
    chatId?: string | number | undefined;
    limit?: number | undefined;
  }): ReturnType<TelegramInbox['getMessages']> {
    return this.inbox.getMessages(opts);
  }
  acknowledge(lastMessageId: number, chatId?: string | number | undefined): number {
    return this.inbox.acknowledge(lastMessageId, chatId);
  }
  get bufferCount(): number {
    return this.inbox.bufferCount;
  }
  private processMessage(msg: Parameters<TelegramInbox['processMessage']>[0]): void {
    this.inbox.processMessage(msg);
  }
  sendMessage(
    chatId: string | number,
    text: string,
    signal?: AbortSignal | undefined,
  ): ReturnType<TelegramOutbox['sendMessage']> {
    return this.outbox.sendMessage(chatId, text, signal);
  }
  sendMessageWithKeyboard(
    chatId: string | number,
    text: string,
    buttons: Array<{ text: string; callback_data: string }>,
    signal?: AbortSignal | undefined,
  ): ReturnType<TelegramOutbox['sendMessageWithKeyboard']> {
    return this.outbox.sendMessageWithKeyboard(chatId, text, buttons, signal);
  }
  async health(
    signal?: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<TelegramOutbox['health']>>> {
    return this.outbox.health(signal);
  }
  get callbackWaiters(): ApprovalFlow['callbackWaiters'] {
    return this.approvals.callbackWaiters;
  }
  awaitApproval(input: TelegramApprovalRequestInput): Promise<TelegramApprovalResult> {
    return this.approvals.awaitApproval(input);
  }
  bindApprovalPrompt(requestId: string, promptMessageId: number): boolean {
    return this.approvals.bindApprovalPrompt(requestId, promptMessageId);
  }
  cancelApproval(requestId: string, fromUser = 'cancelled'): boolean {
    return this.approvals.cancelApproval(requestId, fromUser);
  }
}
