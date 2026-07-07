import { expectDefined } from '@wrongstack/core';
import type { PluginAPI, SlashCommand } from '@wrongstack/core';
import type { TelegramBot } from '../bot.js';
import type { TelegramPluginConfig } from '../config.js';

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

export function tgSendCommand(
  bot: TelegramBot,
  defaultChatId: string | number | undefined,
): SlashCommand {
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

      let chatId: string | number;
      let text: string;

      // First token might be a numeric chat_id
      const parts = args.trim().split(/\s+/);
      const maybeId = parts[0];
      if (/^\d+$/.test(expectDefined(maybeId)) && parts.length > 1) {
        chatId = expectDefined(maybeId);
        text = parts.slice(1).join(' ');
      } else if (defaultChatId) {
        chatId = defaultChatId;
        text = args.trim();
      } else {
        return {
          message:
            'No chat_id provided and no default notifyChatId configured.\nUsage: /telegram:send <chat_id> <message>',
        };
      }

      try {
        const res = await bot.sendMessage(chatId, text);
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
      return { message: 'No notifyChatId configured. Set it in the plugin config or pass chat_id explicitly to telegram_send.' };
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
    tgSendCommand(bot, cfg.notifyChatId),
    tgChatIdCommand(cfg.notifyChatId),
  ];
  for (const cmd of cmds) api.slashCommands.register(cmd);
  return cmds.map((c) => c.name);
}
