import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { persistTelegramConfig } from '../settings-menu.js';
import type { SlashCommandContext } from './command-context.js';
import {
  discoverTelegramPairingCandidates,
  formatTelegramPairingCandidates,
  parseTelegramPairingChoice,
  type TelegramPairingCandidate,
} from './telegram-pairing.js';

interface TelegramGetMeResponse {
  ok: boolean;
  result?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string | undefined;
  };
}

const HELP = [
  'Usage:',
  '  /telegram-setup          Prompt securely for the bot token',
  '  /telegram-setup <chatId> Prompt securely and save a default chat ID',
  '',
  'Aliases: /tg-setup',
  '',
  'The bot token is entered in a masked prompt and never appears in slash history.',
  'With no chat ID, setup discovers recent Bot API identities and requires an explicit choice.',
].join('\n');

const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

type TelegramChatIdClassification =
  | { kind: 'private'; chatId: number }
  | { kind: 'group'; chatId: number }
  | { kind: 'invalid' };

/** Classify a numeric Telegram ID without making the ID an authorization credential. */
export function classifyTelegramChatId(value: string): TelegramChatIdClassification {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return { kind: 'invalid' };
  const chatId = Number(normalized);
  if (!Number.isSafeInteger(chatId) || chatId === 0) return { kind: 'invalid' };
  return chatId < 0 ? { kind: 'group', chatId } : { kind: 'private', chatId };
}

/**
 * `/telegram-setup` — configure the Telegram plugin without putting its token
 * in the command line, terminal history, TUI transcript, or plaintext config.
 */
export function buildTelegramSetupCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'telegram-setup',
    category: 'Config',
    aliases: ['tg-setup'],
    description: 'Configure Telegram bot token securely and optionally set a default chat.',
    argsHint: '[chatId]',
    help: HELP,

    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const first = parts[0] ?? '';
      const sub = first.toLowerCase();

      if (sub === 'help' || sub === '--help' || sub === '-h') {
        return { message: HELP };
      }

      // Legacy versions accepted the token here and therefore leaked it into
      // both readline and TUI history. Refuse that shape without echoing any
      // part of the supplied credential.
      if (BOT_TOKEN_RE.test(first)) {
        return {
          message: [
            `${color.red('✗')} Bot tokens are no longer accepted as slash-command arguments.`,
            `Run ${color.cyan('/telegram-setup [chatId]')} and enter it at the masked prompt.`,
          ].join('\n'),
        };
      }
      if (parts.length > 1) {
        return { message: `${color.amber('Usage:')} /telegram-setup [chatId]` };
      }

      if (!opts.readSecret || !opts.vault || !opts.paths?.globalConfig) {
        return {
          message: `${color.red('✗')} Secure Telegram setup is unavailable in this session.`,
        };
      }

      let botToken: string;
      try {
        botToken = (
          await opts.readSecret(`Telegram bot token ${color.dim('(hidden, paste OK)')}: `)
        ).trim();
      } catch {
        return { message: color.dim('Telegram setup cancelled.') };
      }
      if (!botToken) return { message: color.dim('Telegram setup cancelled.') };

      if (!BOT_TOKEN_RE.test(botToken)) {
        return {
          message: [
            `${color.red('✗')} Invalid token format.`,
            `Expected: ${color.dim('123456789:ABCdefGHIjkl...')}`,
            '',
            'Get a valid token from @BotFather on Telegram.',
          ].join('\n'),
        };
      }

      let botInfo: TelegramGetMeResponse;
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
          signal: AbortSignal.timeout(10_000),
        });
        botInfo = (await response.json()) as TelegramGetMeResponse;
      } catch {
        return {
          message: [
            `${color.red('✗')} Could not reach Telegram API.`,
            '',
            'Check your network connection and try again.',
          ].join('\n'),
        };
      }

      if (!botInfo.ok || !botInfo.result) {
        return {
          message: [
            `${color.red('✗')} Invalid bot token.`,
            '',
            'Get a valid token from @BotFather on Telegram.',
          ].join('\n'),
        };
      }

      const chatId = first || undefined;
      const classifiedChatId = chatId ? classifyTelegramChatId(chatId) : undefined;
      if (classifiedChatId?.kind === 'invalid') {
        return {
          message: `${color.red('✗')} Invalid Telegram chat ID. Expected a positive private chat ID.`,
        };
      }
      if (classifiedChatId?.kind === 'group') {
        return {
          message: [
            `${color.amber('⚠')} Shared group, supergroup, and channel IDs cannot be paired by manual ID.`,
            'Run /telegram-setup without a chat ID and select a discovered private identity.',
            'No configuration was changed.',
          ].join('\n'),
        };
      }

      let pairedCandidate: TelegramPairingCandidate | undefined;
      if (!chatId) {
        let candidates: TelegramPairingCandidate[];
        try {
          candidates = await discoverTelegramPairingCandidates(botToken);
        } catch {
          return {
            message: [
              `${color.red('✗')} Could not discover recent Telegram chats.`,
              'Message the bot once, then run /telegram-setup again.',
              'No configuration was changed.',
            ].join('\n'),
          };
        }

        if (candidates.length === 0) {
          return {
            message: [
              `${color.amber('No recent chats found.')}`,
              'Message the bot from the private account you want to pair, then run setup again.',
              'No configuration was changed.',
            ].join('\n'),
          };
        }

        opts.renderer.write(
          [
            color.bold('Recent Telegram identities'),
            formatTelegramPairingCandidates(candidates),
            '',
            color.dim('Choose a private candidate number, or press Enter to cancel.'),
          ].join('\n'),
        );

        let choiceInput: string;
        try {
          choiceInput = opts.readText
            ? await opts.readText('Pair candidate › ')
            : await opts.reader.readLine('Pair candidate › ');
        } catch {
          return { message: color.dim('Telegram setup cancelled. No configuration was changed.') };
        }
        const choice = parseTelegramPairingChoice(choiceInput, candidates);
        if (choice.kind === 'cancel') {
          return { message: color.dim('Telegram setup cancelled. No configuration was changed.') };
        }
        if (choice.kind === 'invalid') {
          return {
            message: `${color.red('✗')} Invalid pairing choice. No configuration was changed.`,
          };
        }
        if (!choice.candidate.eligible) {
          return {
            message: [
              `${color.amber('⚠')} Shared, group, or ambiguous identities are not paired automatically.`,
              'Use a private chat where chat_id and user_id identify the same account.',
              'No configuration was changed.',
            ].join('\n'),
          };
        }
        pairedCandidate = choice.candidate;
      }

      try {
        await persistTelegramConfig(
          {
            configStore: opts.configStore,
            profileConfigPath: activeProfileConfigPath(opts.paths, opts.configStore.get()),
            vault: opts.vault,
          },
          (telegram) => {
            telegram.botToken = botToken;
            const selectedChatId = pairedCandidate?.chatId ?? classifiedChatId?.chatId;
            if (selectedChatId !== undefined) {
              telegram.notifyChatId = selectedChatId;
              const allowedOutboundChats = Array.isArray(telegram.allowedOutboundChats)
                ? telegram.allowedOutboundChats.filter(
                    (value): value is string | number =>
                      typeof value === 'string' || typeof value === 'number',
                  )
                : [];
              if (!allowedOutboundChats.map(String).includes(String(selectedChatId))) {
                telegram.allowedOutboundChats = [...allowedOutboundChats, selectedChatId];
              }
            }
            if (pairedCandidate) {
              telegram.inboundMode = 'paired';
              telegram.allowedUsers = [pairedCandidate.userId];
              telegram.allowedChats = [pairedCandidate.chatId];
            } else if (classifiedChatId?.kind === 'private') {
              telegram.inboundMode = 'paired';
              telegram.allowedUsers = [classifiedChatId.chatId];
              telegram.allowedChats = [classifiedChatId.chatId];
            }
            if (telegram.notifyOnSessionEnd === undefined) telegram.notifyOnSessionEnd = true;
          },
        );
      } catch {
        return {
          message: [
            `${color.red('✗')} Failed to save Telegram configuration.`,
            'The token was not printed. Check the config path and vault, then try again.',
          ].join('\n'),
        };
      }

      const bot = botInfo.result;
      return {
        message: [
          `${color.green('✓')} Telegram configured successfully.`,
          '',
          `Bot: ${color.bold(`@${bot.username ?? bot.first_name}`)}`,
          ...(pairedCandidate
            ? [
                `Paired private chat: ${color.green(String(pairedCandidate.chatId))}`,
                `Paired user: ${color.green(String(pairedCandidate.userId))}`,
              ]
            : chatId
              ? [`Default chat: ${color.green(chatId)}`]
              : []),
          '',
          `${color.amber('⚠')} Restart WrongStack for the plugin to load the new token.`,
        ].join('\n'),
      };
    },
  };
}
