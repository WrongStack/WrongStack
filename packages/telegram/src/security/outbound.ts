import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { ToolValidationError } from '@wrongstack/core/types';
import { redactSecrets } from '../redact.js';

export type TelegramChatId = string | number;

/**
 * Narrow capability for creating a Telegram approval request. Unlike the
 * generic `net.outbound` capability, this must be granted explicitly to a
 * subagent before its auto-permission approval tool becomes available.
 */
export const TELEGRAM_APPROVAL_CAPABILITY = 'net.outbound.telegram.approval' as const;

export interface TelegramOutboundTargetPolicy {
  /** Paired/default chat. It is always an allowed outbound target when set. */
  getDefaultChatId(): TelegramChatId | undefined;
  /** Additional explicitly trusted outbound targets, resolved at call time. */
  getAllowedOutboundChatIds?(): readonly TelegramChatId[];
}

const secretScrubber = new DefaultSecretScrubber();
const RAW_TELEGRAM_BOT_TOKEN = /(?<![A-Za-z0-9])\d{5,15}:[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g;

function normalizeChatId(value: TelegramChatId): string {
  return String(value).trim();
}

/**
 * Resolve an outbound target against the paired chat plus the explicit
 * outbound allowlist. This must run before any Telegram API call.
 */
export function resolveTelegramOutboundTarget(
  requestedChatId: TelegramChatId | undefined,
  policy: TelegramOutboundTargetPolicy,
): TelegramChatId {
  const defaultChatId = policy.getDefaultChatId();
  const target = requestedChatId ?? defaultChatId;
  if (target === undefined || normalizeChatId(target) === '') {
    throw new ToolValidationError({
      field: 'chat_id',
      message:
        'No chat_id provided and no allowed Telegram target is configured. Pair notifyChatId or configure allowedOutboundChats.',
    });
  }

  const allowed = new Set<string>();
  if (defaultChatId !== undefined && normalizeChatId(defaultChatId) !== '') {
    allowed.add(normalizeChatId(defaultChatId));
  }
  for (const chatId of policy.getAllowedOutboundChatIds?.() ?? []) {
    const normalized = normalizeChatId(chatId);
    if (normalized !== '') allowed.add(normalized);
  }

  if (!allowed.has(normalizeChatId(target))) {
    throw new ToolValidationError({
      field: 'chat_id',
      message: 'Telegram outbound target is not paired or included in allowedOutboundChats.',
    });
  }

  return typeof target === 'string' ? target.trim() : target;
}

/**
 * Scrub outbound text with the shared core credential detector, then retain
 * Telegram's legacy flag/env redaction for labelled secrets the core patterns
 * intentionally do not classify by value alone.
 */
export function scrubTelegramOutboundText(text: string): string {
  const shared = secretScrubber.scrub(text);
  const withoutBareBotTokens = shared.replace(
    RAW_TELEGRAM_BOT_TOKEN,
    '[REDACTED:telegram_bot_token]',
  );
  return redactSecrets(withoutBareBotTokens);
}
