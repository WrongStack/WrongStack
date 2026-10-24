import type { SlashCommand } from '@wrongstack/contracts/types';
import type { PluginAPI } from '@wrongstack/core/plugin';
import { expectDefined } from '@wrongstack/core/utils';
import { type TelegramBot, truncateForTelegram } from '../bot.js';
import type { TelegramBotOutbound } from '../bot-queue.js';
import type { TelegramPluginConfig } from '../config.js';
import {
  resolveTelegramOutboundTarget,
  scrubTelegramOutboundText,
  type TelegramOutboundTargetPolicy,
} from '../security/outbound.js';

// ---------------------------------------------------------------------------
// /telegram-health
// ---------------------------------------------------------------------------

export function tgHealthCommand(bot: TelegramBot, cfg: TelegramPluginConfig): SlashCommand {
  return {
    name: 'telegram-health',
    aliases: ['telegram', 'tgstat', 'tgs'],
    description: 'Show Telegram bot connection health and config',
    help: `Usage: /telegram-health
Aliases: /telegram, /tgstat, /tgs

Shows whether the bot is connected, its username, polling interval,
allowlist health, and notification settings.`,
    async run(_args, _ctx) {
      const health = await bot.health();
      const lines = [
        '═══ Telegram Plugin Status ═══',
        '',
        `Bot:       ${health.ok ? `✅ @${health.username ?? 'connected'}` : `❌ ${health.error ?? 'offline'}`}`,
        `Running:   ${bot.running ? 'yes' : 'no'}`,
        `Started:   ${bot.startedAt ? new Date(bot.startedAt).toLocaleTimeString() : 'N/A'}`,
        `Poll:      every ${cfg.pollIntervalSec ?? 2}s`,
        `Allowed:   ${(cfg.allowedUsers?.length ?? 0) > 0 ? `${cfg.allowedUsers?.length} users` : 'everyone (users)'} / ${(cfg.allowedChats?.length ?? 0) > 0 ? `${cfg.allowedChats?.length} chats` : 'everyone (chats)'}`,
        `Notify:    sessionEnd=${cfg.notifyOnSessionEnd ?? false}, longTool=${cfg.longToolThresholdMs ? `${cfg.longToolThresholdMs}ms` : 'off'}`,
      ];

      return { message: lines.join('\n') };
    },
  };
}

// ---------------------------------------------------------------------------
// /telegram:send
// ---------------------------------------------------------------------------

interface TelegramSlashSendPolicy extends TelegramOutboundTargetPolicy {
  getMaxMessageLength?(): number;
}

export function tgSendCommand(
  bot: TelegramBot,
  policyOrDefault: TelegramSlashSendPolicy | string | number | undefined,
  outbound?: TelegramBotOutbound,
): SlashCommand {
  const policy: TelegramSlashSendPolicy =
    typeof policyOrDefault === 'object' && policyOrDefault !== null
      ? policyOrDefault
      : { getDefaultChatId: () => policyOrDefault };

  return {
    name: 'send',
    description: 'Send a message to a Telegram chat',
    help: `Usage: /telegram:send [chat_id] <message>

Send a message to a Telegram chat.
- First argument (optional): chat or user ID. Uses notifyChatId from config when omitted.
- Everything else: the message text.

Examples:
  /telegram:send 123456789 Build completed successfully ✓
  /telegram:send Deploy finished — check staging`,
    async run(args, _ctx) {
      if (!args.trim()) {
        return { message: 'Usage: /telegram:send [chat_id] <message>' };
      }

      let requestedChatId: string | number | undefined;
      let text: string;

      // First token might be a numeric chat_id. Telegram group/supergroup IDs
      // are negative, so accept an optional leading minus sign.
      const parts = args.trim().split(/\s+/);
      const maybeId = parts[0];
      if (/^-?\d+$/.test(expectDefined(maybeId)) && parts.length > 1) {
        requestedChatId = expectDefined(maybeId);
        text = parts.slice(1).join(' ');
      } else {
        text = args.trim();
      }

      try {
        const chatId = resolveTelegramOutboundTarget(requestedChatId, policy);
        const scrubbed = scrubTelegramOutboundText(text);
        const truncated = truncateForTelegram(scrubbed, policy.getMaxMessageLength?.() ?? 4000);
        if (outbound) {
          const res = await outbound.sendManual(chatId, truncated);
          return {
            message: `✅ Message sent to ${chatId} (msg_id=${res.result?.message_id ?? '?'})`,
          };
        }
        const res = await bot.sendMessage(chatId, truncated);
        return {
          message: `✅ Message sent to ${chatId} (msg_id=${res.result?.message_id ?? '?'})`,
        };
      } catch (err) {
        return { message: `❌ Failed to send: ${(err as Error).message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /telegram:chatid
// ---------------------------------------------------------------------------

export function tgChatIdCommand(defaultChatId?: string | number): SlashCommand {
  const chatIdStr = defaultChatId ? String(defaultChatId) : null;
  return {
    name: 'chatid',
    description: 'Show the configured default chat ID',
    help: `Usage: /telegram:chatid

Shows the current default notifyChatId used for notifications
and the \`telegram_send\` tool when no chat_id is specified.`,
    async run(_args, _ctx) {
      if (chatIdStr) {
        return { message: `Configured notifyChatId: ${chatIdStr}` };
      }
      return {
        message:
          'No notifyChatId configured. Set it in the plugin config or pass chat_id explicitly to telegram_send.',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Register all
// ---------------------------------------------------------------------------

export function registerSlashCommands(
  api: PluginAPI,
  bot: TelegramBot,
  cfg: TelegramPluginConfig,
): string[] {
  const cmds = [
    tgHealthCommand(bot, cfg),
    tgSendCommand(bot, {
      getDefaultChatId: () => cfg.notifyChatId,
      getAllowedOutboundChatIds: () => cfg.allowedOutboundChats ?? [],
      getMaxMessageLength: () => cfg.maxMessageLength ?? 4000,
    }),
    tgChatIdCommand(cfg.notifyChatId),
  ];
  for (const cmd of cmds) api.slashCommands.register(cmd);
  return cmds.map((c) => c.name);
}
