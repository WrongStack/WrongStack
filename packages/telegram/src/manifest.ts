/**
 * Telegram plugin surface manifest — single source of truth for tools,
 * slash commands, and config fields.  The parity test in
 * `tests/unit/manifest-parity.test.ts` asserts that the runtime-registered
 * surface matches this manifest exactly, so CI fails on future drift.
 */

export const TELEGRAM_MANIFEST = {
  pluginName: 'telegram',

  tools: [
    {
      name: 'telegram_send',
      description:
        'Send a scrubbed message to the paired Telegram chat or an explicitly allowed outbound chat.',
    },
    {
      name: 'telegram_read',
      description: 'Read recent incoming Telegram messages the bot has received, newest first.',
    },
    {
      name: 'telegram_approve',
      description:
        'Post a scrubbed yes/no prompt to the paired Telegram chat, then wait for a button press.',
    },
  ],

  slashCommands: [
    {
      name: 'telegram-health',
      aliases: ['telegram', 'tgstat', 'tgs'],
      description: 'Show Telegram bot connection health and config',
    },
    {
      name: 'send',
      aliases: [],
      description: 'Send a message to a Telegram chat',
    },
    {
      name: 'chatid',
      aliases: [],
      description: 'Show the configured default chat ID',
    },
  ],

  configFields: [
    'botToken',
    'notifyChatId',
    'inboundMode',
    'allowedUsers',
    'allowedChats',
    'allowedOutboundChats',
    'pollIntervalSec',
    'notifyOnSessionEnd',
    'longToolThresholdMs',
    'notifyOnDelegate',
    'maxMessageLength',
    'offsetStoragePath',
    'singleInstanceLock',
    'outboundQueuePerChat',
    'outboundQueueConcurrency',
    'allowGroupApprovals',
    'rateLimitTokensPerSecond',
    'rateLimitBurst',
    'parseMode',
  ],
} as const;

export type TelegramManifest = typeof TELEGRAM_MANIFEST;
