import type { SlashCommand } from '@wrongstack/core';
import { color, noOpVault } from '@wrongstack/core';
import { persistTelegramConfig } from '../settings-menu.js';
import type { SlashCommandContext } from './index.js';

interface TelegramGetMeResponse {
  ok: boolean;
  result?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string | undefined;
  };
  description?: string | undefined;
}

const HELP = [
  'Usage:',
  '  /telegram-setup                     Show setup instructions',
  '  /telegram-setup <botToken>          Validate and save bot token',
  '  /telegram-setup <botToken> <chatId> Save token and default chat ID',
  '',
  'Aliases: /tg-setup',
  '',
  'Quick start:',
  '  1. Message @BotFather on Telegram → /newbot → copy the token',
  '  2. Message your new bot, then visit:',
  '     https://api.telegram.org/bot<TOKEN>/getUpdates',
  '     Copy the chat.id from the JSON response.',
  '  3. Run: /telegram-setup <botToken> <chatId>',
  '  4. Restart WrongStack to activate the plugin.',
].join('\n');

/**
 * `/telegram-setup` — configure the Telegram plugin in one command.
 *
 * Argument-driven (not interactive) so it works identically in the plain
 * REPL and the Ink TUI. The bot token is validated against the Telegram
 * API before being persisted.
 */
export function buildTelegramSetupCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'telegram-setup',
    category: 'Config',
    aliases: ['tg-setup'],
    description: 'Configure Telegram bot token and default chat. /telegram-setup <token> [chatId]',
    argsHint: '[botToken] [chatId]',
    help: HELP,

    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help' || sub === '-h') {
        return { message: HELP };
      }

      // ---- No args: show instructions ----
      if (!sub) {
        // Check if telegram plugin is even installed
        const config = opts.configStore.get();
        const hasTelegram = (config.plugins ?? []).some((p) => {
          const name = typeof p === 'string' ? p : p.name;
          return name === '@wrongstack/telegram' || name === 'telegram';
        });

        const lines = [`${color.bold('Telegram Setup')}`, ''];

        if (!hasTelegram) {
          lines.push(
            `${color.amber('⚠')} Telegram plugin is not installed.`,
            `   Run: ${color.cyan('/plugin install telegram')}`,
            `   Then run ${color.cyan('/telegram-setup <botToken>')} to configure it.`,
            '',
          );
        }

        lines.push(
          '1. Create a bot: message @BotFather → /newbot → copy the token',
          '2. Get your chat ID: message your bot, then open in browser:',
          `   ${color.dim('https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates')}`,
          '   Find chat.id in the JSON response.',
          '3. Configure: /telegram-setup <botToken> <chatId>',
          '4. Restart WrongStack.',
        );

        return { message: lines.join('\n') };
      }

      // ---- Validate args: first arg is botToken ----
      const botToken = parts[0] ?? '';
      const chatId = parts[1];

      // Basic token format check: numbers:alphanumeric
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
        return {
          message: [
            `${color.red('✗')} Invalid token format.`,
            `Expected: ${color.dim('123456789:ABCdefGHIjkl...')}`,
            `Got:      ${botToken.slice(0, 20)}...`,
            '',
            'Get a valid token from @BotFather on Telegram.',
          ].join('\n'),
        };
      }

      // ---- Validate token against Telegram API ----
      let botInfo: TelegramGetMeResponse;
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
          signal: AbortSignal.timeout(10_000),
        });
        botInfo = (await res.json()) as TelegramGetMeResponse;
      } catch (err) {
        return {
          message: [
            `${color.red('✗')} Could not reach Telegram API.`,
            `Error: ${(err as Error).message}`,
            '',
            'Check your network connection and try again.',
          ].join('\n'),
        };
      }

      if (!botInfo.ok || !botInfo.result) {
        return {
          message: [
            `${color.red('✗')} Invalid bot token.`,
            `Telegram says: ${botInfo.description ?? 'Unknown error'}`,
            '',
            'Get a valid token from @BotFather on Telegram.',
          ].join('\n'),
        };
      }

      const bot = botInfo.result;

      // ---- Persist to config ----
      const persistDeps = {
        configStore: opts.configStore,
        globalConfigPath: opts.paths?.globalConfig ?? '',
        vault: noOpVault as Parameters<typeof persistTelegramConfig>[0]['vault'],
      };

      if (!persistDeps.globalConfigPath) {
        return {
          message: `${color.red('✗')} Config path not available. Cannot persist settings.`,
        };
      }

      try {
        await persistTelegramConfig(persistDeps, (telegram) => {
          telegram.botToken = botToken;
          if (chatId) {
            // Store as number if it's numeric, string otherwise
            telegram.notifyChatId = /^\d+$/.test(chatId) ? Number(chatId) : chatId;
          }
          // Enable session end notifications by default
          if (telegram.notifyOnSessionEnd === undefined) {
            telegram.notifyOnSessionEnd = true;
          }
        });

        const chatLine = chatId
          ? `\nDefault chat:  ${color.green(chatId)}`
          : `\n${color.dim('No default chat set. You can add it later: /telegram-setup <token> <chatId>')}`;

        return {
          message: [
            `${color.green('✓')} Telegram configured successfully!`,
            '',
            `Bot:          ${color.bold(`@${bot.username ?? bot.first_name}`)} ${color.dim(`(id=${bot.id})`)}`,
            `Name:         ${bot.first_name}`,
            chatLine,
            '',
            `${color.amber('⚠')}  Restart WrongStack for the plugin to pick up the new config.`,
            '',
            'After restart, try:',
            `  ${color.cyan('/telegram')}          — check bot connection`,
            `  ${color.cyan('/telegram:send')}     — send a test message`,
          ].join('\n'),
        };
      } catch (err) {
        return {
          message: [
            `${color.red('✗')} Failed to save config.`,
            `Error: ${(err as Error).message}`,
          ].join('\n'),
        };
      }
    },
  };
}
