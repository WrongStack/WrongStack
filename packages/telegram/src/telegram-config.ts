import type { Config } from '@wrongstack/contracts/types';
import { expectDefined } from '@wrongstack/core/utils';
import {
  DEFAULT_CONFIG,
  readTelegramConfigFromConfig,
  type TelegramPluginConfig,
} from './config.js';

// ---------------------------------------------------------------------------
// Teardown state
// ---------------------------------------------------------------------------

/** Mutable runtime config — updated via api.onConfigChange so changes take
 * effect without restarting the plugin. */
export interface RuntimeConfig {
  notifyChatId: string | number | undefined;
  allowedOutboundChats: Array<string | number>;
  allowedUserIds: Array<string | number>;
  allowGroupApprovals: boolean;
  notifyOnSessionEnd: boolean;
  notifyOnDelegate: boolean;
  longToolThresholdMs: number;
  maxMessageLength: number;
  outboundQueuePerChat: number;
  outboundQueueConcurrency: number;
  /** Per-chat rate-limit pacing for outbound sends (live via getter). */
  rateLimitTokensPerSecond: number;
  /** Per-chat rate-limit burst size for outbound sends (live via getter). */
  rateLimitBurst: number;
  /** Telegram parse mode resolved per-send so hot-reload takes effect live. */
  parseMode: '' | 'HTML' | 'MarkdownV2';
}

export const DENY_ALL_INBOUND = '__wrongstack_telegram_inbound_disabled__';

export function inboundAllowlist(cfg: {
  inboundMode?: TelegramPluginConfig['inboundMode'];
  allowedUsers?: TelegramPluginConfig['allowedUsers'];
  allowedChats?: TelegramPluginConfig['allowedChats'];
  notifyChatId?: TelegramPluginConfig['notifyChatId'];
}): {
  allowedUsers: Set<string>;
  allowedChats: Set<string>;
} {
  if (cfg.inboundMode === 'public') {
    return { allowedUsers: new Set(), allowedChats: new Set() };
  }
  if (cfg.inboundMode === 'paired') {
    const pairedUsers = new Set((cfg.allowedUsers ?? []).map(String));
    return {
      allowedUsers:
        pairedUsers.size > 0 ? pairedUsers : new Set([String(expectDefined(cfg.notifyChatId))]),
      allowedChats: new Set([String(expectDefined(cfg.notifyChatId))]),
    };
  }
  if (cfg.inboundMode === 'allowlist') {
    return {
      allowedUsers: new Set((cfg.allowedUsers ?? []).map(String)),
      allowedChats: new Set((cfg.allowedChats ?? []).map(String)),
    };
  }
  return {
    allowedUsers: new Set([DENY_ALL_INBOUND]),
    allowedChats: new Set([DENY_ALL_INBOUND]),
  };
}

/**
 * Build the plugin's `defaultConfig` from `DEFAULT_CONFIG` with defensive
 * deep copies of every field (arrays and any future nested values).
 * Using `structuredClone` ensures any key added to `DEFAULT_CONFIG` is
 * automatically copied rather than shared by reference, preventing silent
 * drift from the documented defaults. Scalar (immutable) values are
 * unaffected by deep copy.
 *
 * Return type widens to `Record<string, unknown>` to align with the
 * `Plugin.defaultConfig` interface (see `packages/contracts/src/types/plugin.ts`).
 * The narrower `DEFAULT_CONFIG` shape is still enforced by
 * `telegramConfigSchema` validation downstream.
 */
export function telegramDefaultConfig(): Record<string, unknown> {
  return structuredClone(DEFAULT_CONFIG) as Record<string, unknown>;
}

/** Read the Telegram section from a full Config object.
 * Delegates to {@link readTelegramConfigFromConfig} for the canonical
 * extension-slice extraction + default merge, then applies the runtime
 * coercions that `RuntimeConfig` requires (String chatId, array copies). */
export function telegramFromConfig(cfg: Config): {
  notifyChatId: string | number | undefined;
  allowedOutboundChats: Array<string | number>;
  allowedUserIds: Array<string | number>;
  allowGroupApprovals: boolean;
  pollIntervalSec: number;
  notifyOnSessionEnd: boolean;
  notifyOnDelegate: boolean;
  longToolThresholdMs: number;
  maxMessageLength: number;
  outboundQueuePerChat: number;
  outboundQueueConcurrency: number;
  rateLimitTokensPerSecond: number;
  rateLimitBurst: number;
  parseMode: '' | 'HTML' | 'MarkdownV2';
} {
  const tg = readTelegramConfigFromConfig(cfg);
  return {
    notifyChatId: tg.notifyChatId !== undefined ? String(tg.notifyChatId) : undefined,
    allowedOutboundChats: [...(tg.allowedOutboundChats ?? [])],
    allowedUserIds: [...(tg.allowedUsers ?? [])],
    allowGroupApprovals: tg.allowGroupApprovals ?? false,
    pollIntervalSec: tg.pollIntervalSec ?? 2,
    notifyOnSessionEnd: tg.notifyOnSessionEnd ?? false,
    notifyOnDelegate: tg.notifyOnDelegate ?? true,
    longToolThresholdMs: tg.longToolThresholdMs ?? 30_000,
    maxMessageLength: tg.maxMessageLength ?? 4000,
    outboundQueuePerChat: tg.outboundQueuePerChat ?? 32,
    outboundQueueConcurrency: tg.outboundQueueConcurrency ?? 4,
    rateLimitTokensPerSecond: tg.rateLimitTokensPerSecond ?? 0.33,
    rateLimitBurst: tg.rateLimitBurst ?? 4,
    parseMode: tg.parseMode ?? '',
  };
}
