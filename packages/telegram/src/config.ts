import { type PluginAPI, resolvePluginConfig } from '@wrongstack/core/plugin';
import type { Config, PluginConfigFields } from '@wrongstack/core/types';

export const PLUGIN_NAME = 'telegram';
export const PLUGIN_CONFIG_ALIASES = ['@wrongstack/telegram'] as const;

export type TelegramInboundMode = 'disabled' | 'paired' | 'allowlist' | 'public';

const INBOUND_MODES = ['disabled', 'paired', 'allowlist', 'public'] as const;

export interface TelegramPluginConfig {
  /** Telegram Bot API token (from @BotFather). */
  botToken: string;
  /**
   * Default chat ID for outgoing notifications.
   * The agent's `telegram_send` tool can override per-call.
   */
  notifyChatId?: string | number | undefined;
  /**
   * Controls who may send inbound messages to the bot. Defaults to `disabled`
   * for new/unpaired configurations. Legacy configurations are migrated to
   * `allowlist` when IDs exist, or `paired` when `notifyChatId` exists.
   */
  inboundMode?: TelegramInboundMode | undefined;
  /** List of user IDs accepted when `inboundMode` is `allowlist`. */
  allowedUsers?: Array<string | number> | undefined;
  /** List of chat IDs accepted when `inboundMode` is `allowlist`. */
  allowedChats?: Array<string | number> | undefined;
  /** Additional trusted targets for outbound sends beyond `notifyChatId`. */
  allowedOutboundChats?: Array<string | number> | undefined;
  /** Polling interval in seconds (default: 2). */
  pollIntervalSec?: number | undefined;
  /** Notify on Telegram when a session ends. */
  notifyOnSessionEnd?: boolean | undefined;
  /** Notify when a tool runs longer than this threshold (ms). Set 0 to disable. */
  longToolThresholdMs?: number | undefined;
  /** Notify (humanized) when a `delegate` subagent finishes. Default: true. */
  notifyOnDelegate?: boolean | undefined;
  /** Maximum message length for Telegram (Telegram caps at 4096). */
  maxMessageLength?: number | undefined;
  /**
   * Path to a file that stores the Telegram polling offset. When set,
   * the offset is persisted on every successful poll and restored on startup,
   * preventing message replay after crashes or restarts.
   * The directory must already exist and be writable.
   */
  offsetStoragePath?: string | undefined;
  /**
   * Elect a single poller per bot token across wstack instances (default:
   * true). Telegram allows one `getUpdates` consumer per token; without this,
   * two instances sharing a token fight and get HTTP 409 on every poll.
   * Extra instances stand by and take over when the active poller stops.
   * Set false only if this is guaranteed to be the sole consumer.
   */
  singleInstanceLock?: boolean | undefined;
  /**
   * Per-chat pending-message cap for the outbound queue. Older pending
   * notification entries are dropped when this is exceeded; manual
   * telegram_send entries surface the overflow as an error. Default: 32.
   */
  outboundQueuePerChat?: number | undefined;
  /** Maximum concurrent outbound sends across all chats. Default: 4. */
  outboundQueueConcurrency?: number | undefined;
  /** Permit group-chat approvals only when an explicit user allowlist also matches. */
  allowGroupApprovals?: boolean | undefined;
  /** Per-chat rate limit (tokens per second). Default: 0.33 (≈20 msg/min). */
  rateLimitTokensPerSecond?: number | undefined;
  /** Per-chat rate limit burst size. Default: 4. */
  rateLimitBurst?: number | undefined;
  /**
   * Telegram parse mode for message text formatting. Supports:
   * - `'HTML'` — `<b>bold</b>`, `<i>italic</i>`, `<a href="...">link</a>`, `<code>mono</code>`, `<pre>code block</pre>`
   * - `'MarkdownV2'` — `*bold*`, `_italic_`, `[link](url)`, `` `code` ``, ```pre```
   * - unset / `''` — plain text (no formatting)
   */
  parseMode?: '' | 'HTML' | 'MarkdownV2' | undefined;
}

export const DEFAULT_CONFIG: Required<
  Omit<TelegramPluginConfig, 'botToken' | 'notifyChatId' | 'offsetStoragePath'>
> = {
  inboundMode: 'disabled',
  allowedUsers: [],
  allowedChats: [],
  allowedOutboundChats: [],
  pollIntervalSec: 2,
  notifyOnSessionEnd: false,
  longToolThresholdMs: 30_000,
  notifyOnDelegate: true,
  maxMessageLength: 4000,
  singleInstanceLock: true,
  outboundQueuePerChat: 32,
  outboundQueueConcurrency: 4,
  allowGroupApprovals: false,
  rateLimitTokensPerSecond: 0.33,
  rateLimitBurst: 4,
  parseMode: '',
};

export const TELEGRAM_CONFIG_FIELDS = {
  botToken: { lifecycle: 'restart', secret: true },
  notifyChatId: { lifecycle: 'restart' },
  inboundMode: { lifecycle: 'hot' },
  allowedUsers: { lifecycle: 'hot' },
  allowedChats: { lifecycle: 'hot' },
  allowedOutboundChats: { lifecycle: 'hot' },
  allowGroupApprovals: { lifecycle: 'hot' },
  pollIntervalSec: { lifecycle: 'hot' },
  notifyOnSessionEnd: { lifecycle: 'hot' },
  longToolThresholdMs: { lifecycle: 'hot' },
  notifyOnDelegate: { lifecycle: 'hot' },
  maxMessageLength: { lifecycle: 'hot' },
  offsetStoragePath: { lifecycle: 'immutable' },
  singleInstanceLock: { lifecycle: 'restart' },
  outboundQueuePerChat: { lifecycle: 'restart' },
  outboundQueueConcurrency: { lifecycle: 'restart' },
  rateLimitTokensPerSecond: { lifecycle: 'hot', description: 'Per-chat rate limit (tokens/sec)' },
  rateLimitBurst: { lifecycle: 'hot', description: 'Per-chat rate limit burst size' },
  parseMode: {
    lifecycle: 'hot',
    description: 'Telegram parse mode: HTML, MarkdownV2, or empty for plain text',
  },
} as const satisfies PluginConfigFields<TelegramPluginConfig>;

export const telegramConfigSchema = {
  type: 'object',
  properties: {
    botToken: { type: 'string', description: 'Telegram Bot API token from @BotFather' },
    notifyChatId: {
      oneOf: [{ type: 'string' }, { type: 'integer' }],
      description: 'Default chat ID for outgoing notifications',
    },
    inboundMode: {
      type: 'string',
      enum: [...INBOUND_MODES],
      default: 'disabled',
      description:
        'Inbound access: disabled, paired to notifyChatId, restricted by allowlists, or explicitly public',
    },
    allowedUsers: {
      type: 'array',
      items: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      description: 'User IDs accepted when inboundMode is allowlist',
    },
    allowedChats: {
      type: 'array',
      items: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      description: 'Chat IDs accepted when inboundMode is allowlist',
    },
    allowedOutboundChats: {
      type: 'array',
      items: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      description: 'Additional trusted targets for outbound Telegram sends',
    },
    pollIntervalSec: {
      type: 'integer',
      minimum: 1,
      maximum: 60,
      description: 'Polling interval in seconds',
    },
    notifyOnSessionEnd: { type: 'boolean' },
    longToolThresholdMs: { type: 'integer', minimum: 0 },
    notifyOnDelegate: { type: 'boolean' },
    maxMessageLength: { type: 'integer', minimum: 100, maximum: 4096 },
    offsetStoragePath: { type: 'string' },
    singleInstanceLock: {
      type: 'boolean',
      description:
        'Elect a single getUpdates poller per bot token across wstack instances (default true)',
    },
    outboundQueuePerChat: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'Per-chat pending outbound-message cap (default 32)',
    },
    outboundQueueConcurrency: {
      type: 'integer',
      minimum: 1,
      maximum: 64,
      description: 'Maximum concurrent outbound sends across all chats (default 4)',
    },
    allowGroupApprovals: { type: 'boolean' },
    rateLimitTokensPerSecond: {
      type: 'number',
      minimum: 0.1,
      maximum: 100,
      description: 'Per-chat rate limit in tokens per second (default: 0.33 ≈20 msg/min)',
    },
    rateLimitBurst: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Per-chat burst size (default: 1)',
    },
    parseMode: {
      type: 'string',
      enum: ['', 'HTML', 'MarkdownV2'],
      description: 'Telegram parse mode: HTML, MarkdownV2, or empty for plain text',
    },
  },
  required: ['botToken'],
};

export function readTelegramConfig(
  api: Pick<PluginAPI, 'config'> & Partial<Pick<PluginAPI, 'log'>>,
): Required<Omit<TelegramPluginConfig, 'notifyChatId' | 'offsetStoragePath'>> &
  Pick<TelegramPluginConfig, 'notifyChatId' | 'offsetStoragePath'> {
  const resolution = resolvePluginConfig({
    name: PLUGIN_NAME,
    aliases: PLUGIN_CONFIG_ALIASES,
    config: api.config,
  });
  const opts = resolution.options as unknown as TelegramPluginConfig;
  const inboundMode = resolveInboundMode(opts, {
    configured: resolution.configured,
    warn: api.log?.warn.bind(api.log),
  });

  return {
    ...DEFAULT_CONFIG,
    ...opts,
    inboundMode,
  };
}

/**
 * Read the Telegram config section from a raw `Config` snapshot.
 * Used by `api.onConfigChange` callbacks that receive `(next: Config, prev: Config)`
 * rather than a `PluginAPI`.  Delegates to {@link readTelegramConfig} so the
 * merge logic (legacy plugins, extension opts, inbound-mode resolution,
 * defaults) stays in one place.
 */
export function readTelegramConfigFromConfig(cfg: Config): TelegramPluginConfig {
  return readTelegramConfig({ config: cfg });
}

function resolveInboundMode(
  opts: TelegramPluginConfig,
  migration: { configured: boolean; warn?: ((message: string) => void) | undefined },
): TelegramInboundMode {
  if (opts.inboundMode !== undefined) {
    if (!INBOUND_MODES.includes(opts.inboundMode)) {
      throw new Error(
        `Invalid telegram inboundMode "${String(opts.inboundMode)}". Expected one of: ${INBOUND_MODES.join(', ')}.`,
      );
    }
    if (
      opts.inboundMode === 'allowlist' &&
      !hasEntries(opts.allowedUsers) &&
      !hasEntries(opts.allowedChats)
    ) {
      throw new Error(
        'Telegram inboundMode "allowlist" requires at least one allowedUsers or allowedChats entry.',
      );
    }
    if (opts.inboundMode === 'paired' && opts.notifyChatId === undefined) {
      throw new Error('Telegram inboundMode "paired" requires notifyChatId.');
    }
    return opts.inboundMode;
  }

  if (hasEntries(opts.allowedUsers) || hasEntries(opts.allowedChats)) return 'allowlist';

  const inferredMode: TelegramInboundMode = opts.notifyChatId === undefined ? 'disabled' : 'paired';
  if (migration.configured) {
    migration.warn?.(
      `Telegram inbound access no longer defaults to public when allowedUsers and allowedChats are empty; inferred inboundMode "${inferredMode}". Set inboundMode "public" explicitly to preserve legacy allow-all behavior.`,
    );
  }
  return inferredMode;
}

function hasEntries(values: Array<string | number> | undefined): boolean {
  return Array.isArray(values) && values.length > 0;
}
