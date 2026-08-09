import type { SlashCommand } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { persistTelegramConfig } from '../settings-menu.js';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import { classifyTelegramChatId } from './telegram-setup.js';

/**
 * Toggleable notification settings for the Telegram plugin.
 *
 * These map 1:1 to the boolean / numeric fields in
 * `TelegramPluginConfig` (packages/telegram/src/config.ts) and are
 * persisted to `extensions.telegram` in the global config via
 * `persistTelegramConfig`.
 *
 * Changes are reactive: the plugin listens to `api.onConfigChange` and picks up
 * new values on the next event — no restart needed.
 */
const HELP = [
  'Usage:',
  '  /telegram-settings                      Show current Telegram notification settings',
  '  /telegram-settings session-end on|off   Notify on session end',
  '  /telegram-settings delegate on|off      Notify when a delegated subagent finishes',
  '  /telegram-settings long-tool <ms|off>   Notify for tools slower than <ms> (0/off = disabled)',
  '  /telegram-settings poll <seconds>       Bot polling interval (1–60)',
  '  /telegram-settings chat <chatId>        Default chat for notifications',
  '  /telegram-settings all on|off           Toggle every event notification at once',
  '',
  'Aliases: /tg-settings',
  '',
  'Settings apply immediately — no restart needed.',
].join('\n');

export function buildTelegramSettingsCommand(opts: SlashCommandContext): SlashCommand {
  function currentView(): string {
    const config = opts.configStore.get() as {
      extensions?: { telegram?: Record<string, unknown> } | undefined;
    };
    const tg = config.extensions?.telegram ?? {};
    const sessionEnd = tg.notifyOnSessionEnd === true;
    const delegate = tg.notifyOnDelegate !== false; // default true
    const longToolMs = typeof tg.longToolThresholdMs === 'number' ? tg.longToolThresholdMs : 30_000;
    const longTool = longToolMs > 0 ? `${longToolMs}ms` : 'off';
    const poll = typeof tg.pollIntervalSec === 'number' ? `${tg.pollIntervalSec}s` : '2s';
    const chat =
      tg.notifyChatId !== undefined && tg.notifyChatId !== null
        ? String(tg.notifyChatId)
        : 'not set';
    const hasToken = typeof tg.botToken === 'string' && tg.botToken.length > 0;

    return [
      `${color.bold('Telegram')} ${color.dim('— Notification Settings')}`,
      '',
      `  session end:     ${sessionEnd ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /telegram-settings session-end on|off')}`,
      `  delegate done:   ${delegate ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /telegram-settings delegate on|off')}`,
      `  long tool:       ${color.cyan(longTool)}   ${color.dim('change: /telegram-settings long-tool <ms|off>')}`,
      `  poll interval:   ${color.cyan(poll)}   ${color.dim('change: /telegram-settings poll <seconds>')}`,
      `  notify chat:     ${color.cyan(chat)}   ${color.dim('change: /telegram-settings chat <chatId>')}`,
      '',
      hasToken
        ? color.dim('  Bot token configured. Changes apply immediately.')
        : `${color.amber('⚠')}  No bot token configured. Run: /telegram-setup <botToken> [chatId]`,
    ].join('\n');
  }

  return {
    name: 'telegram-settings',
    category: 'Config',
    aliases: ['tg-settings'],
    description: 'Toggle which agent events are reported to Telegram.',
    argsHint: '[session-end|delegate|long-tool|poll|chat <value>]',
    help: HELP,

    async run(args) {
      const { cmd: sub, rest } = parseSubcommand(args);

      if (sub === 'help' || sub === '--help' || sub === '-h') {
        return { message: HELP };
      }

      if (!opts.configStore || !opts.paths?.globalConfig || !opts.vault) {
        return { message: `${color.red('Error')} secure config persistence not available.` };
      }

      if (!sub) {
        return { message: currentView() };
      }

      const persistDeps = {
        configStore: opts.configStore,
        profileConfigPath: activeProfileConfigPath(opts.paths, opts.configStore.get()),
        vault: opts.vault,
      };

      try {
        if (sub === 'all') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /telegram-settings all on|off` };
          }
          const on = raw === 'on';
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.notifyOnSessionEnd = on;
            tg.notifyOnDelegate = on;
          });
          return {
            message: `${color.green('✓')} all event notifications → ${on ? color.cyan('on') : color.dim('off')} ${color.dim('(session-end, delegate)')}`,
          };
        }

        if (sub === 'session-end') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /telegram-settings session-end on|off` };
          }
          const on = raw === 'on';
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.notifyOnSessionEnd = on;
          });
          return {
            message: `${color.green('✓')} session-end → ${on ? color.cyan('on') : color.dim('off')}`,
          };
        }

        if (sub === 'delegate') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /telegram-settings delegate on|off` };
          }
          const on = raw === 'on';
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.notifyOnDelegate = on;
          });
          return {
            message: `${color.green('✓')} delegate → ${on ? color.cyan('on') : color.dim('off')}`,
          };
        }

        if (sub === 'long-tool') {
          const raw = rest[0];
          if (raw === undefined) {
            return {
              message: `${color.amber('Usage:')} /telegram-settings long-tool <ms|off>   ${color.dim('(0 or off disables)')}`,
            };
          }
          if (raw === 'off') {
            await persistTelegramConfig(persistDeps, (tg) => {
              tg.longToolThresholdMs = 0;
            });
            return {
              message: `${color.green('✓')} long-tool → ${color.dim('off')}`,
            };
          }
          const ms = Number.parseInt(raw, 10);
          if (Number.isNaN(ms) || ms < 0) {
            return {
              message: `${color.red('Invalid number')}: "${raw}". Enter milliseconds, e.g. /telegram-settings long-tool 15000`,
            };
          }
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.longToolThresholdMs = ms;
          });
          return {
            message: `${color.green('✓')} long-tool → ${color.cyan(`${ms}ms`)}`,
          };
        }

        if (sub === 'poll') {
          const raw = rest[0];
          if (raw === undefined) {
            return {
              message: `${color.amber('Usage:')} /telegram-settings poll <seconds>   ${color.dim('(1–60)')}`,
            };
          }
          const sec = Number.parseInt(raw, 10);
          if (Number.isNaN(sec) || sec < 1 || sec > 60) {
            return {
              message: `${color.red('Invalid value')}: "${raw}". Enter seconds between 1 and 60.`,
            };
          }
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.pollIntervalSec = sec;
          });
          return {
            message: `${color.green('✓')} poll → ${color.cyan(`${sec}s`)}`,
          };
        }

        if (sub === 'chat') {
          const raw = rest[0];
          if (!raw) {
            return { message: `${color.amber('Usage:')} /telegram-settings chat <chatId>` };
          }
          const classification = classifyTelegramChatId(raw);
          if (classification.kind === 'invalid') {
            return { message: `${color.red('Invalid chat ID')}: expected a non-zero integer.` };
          }

          const current = opts.configStore.get() as {
            extensions?: { telegram?: { allowGroupChats?: unknown } | undefined } | undefined;
          };
          const allowGroupChats = current.extensions?.telegram?.allowGroupChats === true;
          if (classification.kind === 'group' && !allowGroupChats) {
            return {
              message: [
                `${color.amber('⚠')} Group, supergroup, and channel targets require explicit allowGroupChats=true.`,
                'No configuration was changed.',
              ].join('\n'),
            };
          }

          await persistTelegramConfig(persistDeps, (tg) => {
            tg.notifyChatId = classification.chatId;
            const allowedOutboundChats = Array.isArray(tg.allowedOutboundChats)
              ? tg.allowedOutboundChats.filter(
                  (value): value is string | number =>
                    typeof value === 'string' || typeof value === 'number',
                )
              : [];
            if (!allowedOutboundChats.map(String).includes(String(classification.chatId))) {
              tg.allowedOutboundChats = [...allowedOutboundChats, classification.chatId];
            }
            if (classification.kind === 'private') {
              tg.inboundMode = 'paired';
              tg.allowedUsers = [classification.chatId];
              tg.allowedChats = [classification.chatId];
            } else {
              const hasInboundAllowlist =
                (Array.isArray(tg.allowedUsers) && tg.allowedUsers.length > 0) ||
                (Array.isArray(tg.allowedChats) && tg.allowedChats.length > 0);
              tg.inboundMode = hasInboundAllowlist ? 'allowlist' : 'disabled';
            }
          });
          return {
            message: `${color.green('✓')} notify chat → ${color.cyan(raw)}`,
          };
        }

        return {
          message: `${color.red('Unknown setting')} "${sub}". ${unknownSubcommand(sub, ['session-end', 'delegate', 'long-tool', 'poll', 'chat', 'all'], 'telegram-settings')}`,
        };
      } catch (err) {
        return {
          message: `${color.red('Settings error')}: ${toErrorMessage(err)}`,
        };
      }
    },
  };
}
