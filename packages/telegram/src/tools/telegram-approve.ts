import { randomUUID } from 'node:crypto';
import type { Logger, Tool } from '@wrongstack/core/types';
import type { TelegramBot } from '../bot.js';
import { truncateForTelegram } from '../bot.js';
import {
  resolveTelegramOutboundTarget,
  scrubTelegramOutboundText,
  TELEGRAM_APPROVAL_CAPABILITY,
  type TelegramChatId,
} from '../security/outbound.js';

interface TelegramApproveInput {
  /** Short label for what's being approved (≤ 60 chars). Shown as the prompt heading. */
  prompt: string;
  /** Optional details (≤ 1000 chars). Shown under the heading. */
  details?: string | undefined;
  /** Chat to post the prompt to. Falls back to notifyChatId. */
  chat_id?: string | number | undefined;
  /** How long to wait for a button press before auto-denying. Default 60s, max 600s. */
  timeout_ms?: number | undefined;
}

interface TelegramApproveOutput {
  approved: boolean;
  /** Immutable Telegram user ID; absent for timeout, shutdown, or rejection. */
  user_id?: number | undefined;
  /** Human-readable username/first name; never used for authorization. */
  display_name: string;
  /** Backward-compatible alias for display_name. */
  from: string;
  prompt_message_id?: number | undefined;
}

/**
 * Post a yes/no inline-keyboard prompt to a chat and block until the user
 * taps a button (or until `timeout_ms` elapses, in which case the call
 * auto-denies). Useful when the agent wants explicit approval before
 * continuing and the user is on their phone rather than the TUI.
 *
 * The agent calls this tool directly. It does not replace the host-level
 * `permission: 'confirm'` flow — for that, see the future B4 work.
 *
 * Permission: `auto` (NOT `confirm`). This is intentional — the tool's
 * purpose IS to obtain user approval; gating it behind another host-level
 * confirm dialog would be circular and would block the agent in
 * headless mode. The user-side approval (Telegram button press) is
 * the only confirm gate. The 600 s tool `timeoutMs` ceiling is the
 * safety net for the case where the user never responds.
 */
export function makeTelegramApproveTool(opts: {
  bot: TelegramBot;
  /** Paired/default target, resolved on every call for live config updates. */
  getDefaultChatId(): TelegramChatId | undefined;
  /** Additional trusted targets, resolved on every call for live config updates. */
  getAllowedOutboundChatIds?(): readonly TelegramChatId[];
  /** Immutable Telegram user IDs permitted to resolve an approval. */
  getAllowedUserIds?(): readonly TelegramChatId[];
  /**
   * Group approvals stay denied unless both this and explicit user IDs are
   * configured. Resolved on every call for live config updates.
   */
  getAllowGroupApprovals?(): boolean;
  maxMessageLength: number;
  log: Logger;
}): Tool<TelegramApproveInput, TelegramApproveOutput> {
  return {
    name: 'telegram_approve',
    description:
      'Post a scrubbed yes/no prompt only to the paired Telegram chat or an explicitly allowed outbound chat, then wait for a button press. Returns approval state plus immutable user_id and display_name; false means timeout, rejection, or explicit deny. This narrow capability requests remote approval but does not itself authorize or perform the proposed operation.',
    usageHint:
      'telegram_approve(prompt: "Delete build artifacts?", details: "Frees 2.3 GB. Cannot be undone.", timeout_ms: 60000)',
    category: 'Telegram',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          maxLength: 200,
          description: 'Short label for what is being approved. Shown as the prompt heading.',
        },
        details: {
          type: 'string',
          maxLength: 1000,
          description: 'Optional context under the heading.',
        },
        chat_id: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Chat to post the prompt to. Uses the plugin default when omitted.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 600_000,
          description:
            'How long to wait before auto-denying. Default 60 000 ms, max 600 000 ms (10 min).',
        },
      },
      required: ['prompt'],
    },
    permission: 'auto',
    mutating: true,
    riskTier: 'standard',
    capabilities: [TELEGRAM_APPROVAL_CAPABILITY],
    timeoutMs: 610_000,
    async execute(input, ctx, toolOpts) {
      const chatId = resolveTelegramOutboundTarget(input.chat_id, opts);
      const timeoutMs = Math.min(Math.max(input.timeout_ms ?? 60_000, 1000), 600_000);
      const configuredUserIds = opts.getAllowedUserIds?.().map(String) ?? [];
      const isGroup = String(chatId).startsWith('-');
      if (isGroup && (opts.getAllowGroupApprovals?.() !== true || configuredUserIds.length === 0)) {
        throw new Error('Telegram group approvals require explicit per-user configuration.');
      }
      const expectedUserIds = configuredUserIds.length > 0 ? configuredUserIds : [String(chatId)];

      // Stable request identity shared by the yes/no callback actions.
      const requestId = randomUUID().slice(0, 16);
      const yesKey = `approve:${requestId}:yes`;
      const noKey = `approve:${requestId}:no`;

      // Scrub every user-controlled outbound field before truncation so raw
      // credentials never reach Telegram, even inside an approval prompt.
      const prompt = scrubTelegramOutboundText(input.prompt);
      const details = input.details
        ? truncateForTelegram(scrubTelegramOutboundText(input.details), 800)
        : undefined;
      const heading = `⚠️ ${prompt}`;
      const detailsLine = details ? `\n\n${details}` : '';
      const text = `${heading}${detailsLine}\n\n_Reply by tapping a button. Auto-denies in ${Math.round(timeoutMs / 1000)}s._`;

      opts.log.info(`telegram_approve → chat_id=${chatId} (${prompt.length} prompt chars)`);

      // Register before sending so an immediate callback cannot beat waiter
      // creation. The same request owns its timer through send, bind, and
      // terminal settlement.
      const approval = opts.bot.awaitApproval({
        requestId,
        sessionId: ctx?.session.id ?? 'unknown-session',
        expectedChatId: chatId,
        expectedUserIds,
        allowGroup: isGroup && opts.getAllowGroupApprovals?.() === true,
        expiresAt: Date.now() + timeoutMs,
        signal: toolOpts?.signal,
      });

      let promptMessageId: number | undefined;
      try {
        const sent = await opts.bot.sendMessageWithKeyboard(
          chatId,
          text,
          [
            { text: '✅ Approve', callback_data: yesKey },
            { text: '❌ Deny', callback_data: noKey },
          ],
          toolOpts?.signal,
        );
        promptMessageId = sent.result?.message_id;
        if (promptMessageId === undefined) {
          throw new Error('Telegram approval prompt response did not include a message ID.');
        }
        if (!opts.bot.bindApprovalPrompt(requestId, promptMessageId)) {
          throw new Error('Telegram approval request ended before its prompt could be bound.');
        }
      } catch (err) {
        opts.bot.cancelApproval(requestId, 'send-failed');
        await approval;
        opts.log.debug(`telegram_approve send failed: ${(err as Error).message}`);
        throw err;
      }

      const result = await approval;
      return {
        approved: result.approved,
        user_id: result.fromUserId,
        display_name: result.fromUser,
        from: result.fromUser,
        prompt_message_id: promptMessageId,
      };
    },
  };
}
