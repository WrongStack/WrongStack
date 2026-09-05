import type { PluginAPI } from '@wrongstack/core/plugin';
import type { Config, Logger, Plugin, SlashCommand } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import type { TelegramIncomingMessage } from './bot.js';
import { TelegramBot } from './bot.js';
import {
  DEFAULT_CONFIG,
  PLUGIN_CONFIG_ALIASES,
  PLUGIN_NAME,
  readTelegramConfig,
  readTelegramConfigFromConfig,
  TELEGRAM_CONFIG_FIELDS,
  telegramConfigSchema,
  type TelegramPluginConfig,
} from './config.js';
import type { SessionEndedLike, ToolExecutedLike } from './format.js';
import { formatDelegateCompleted, formatSessionEnded, formatToolExecuted } from './format.js';
import { lockPathForToken, PollLock } from './poll-lock.js';
import { OffsetStore } from './offset-store.js';
import { fenceTelegramInboundText } from './security/inbound.js';
import { scrubTelegramOutboundText } from './security/outbound.js';
import { tgChatIdCommand, tgHealthCommand, tgSendCommand } from './slash-commands/index.js';
import { makeTelegramApproveTool } from './tools/telegram-approve.js';
import { TelegramBotOutbound } from './bot-queue.js';
import { TelegramNotificationChannel } from './notification-channel.js';
import { makeTelegramReadTool } from './tools/telegram-read.js';
import { makeTelegramSendTool } from './tools/telegram-send.js';
import { diffConfigKeys } from './config-classifier.js';

// ---------------------------------------------------------------------------
// Teardown state
// ---------------------------------------------------------------------------

/** Mutable runtime config — updated via api.onConfigChange so changes take
 * effect without restarting the plugin. */
interface RuntimeConfig {
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

interface RuntimeState {
  bot: TelegramBot;
  outbound: TelegramBotOutbound;
  cleanups: Array<() => void>;
}

let teardownState: RuntimeState | null = null;

const DENY_ALL_INBOUND = '__wrongstack_telegram_inbound_disabled__';

function inboundAllowlist(cfg: {
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

function runCleanups(cleanups: Array<() => void>, log: Logger): void {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    try {
      cleanup?.();
    } catch (err) {
      log.debug(`Telegram cleanup failed: ${(err as Error).message}`);
    }
  }
}

function disposeRuntime(log: Logger): void {
  const state = teardownState;
  teardownState = null;
  if (state) runCleanups(state.cleanups, log);
}

function registerCommand(api: PluginAPI, command: SlashCommand, cleanups: Array<() => void>): void {
  api.slashCommands.register(command);
  cleanups.push(() => {
    api.slashCommands.unregister(`${PLUGIN_NAME}:${command.name}`);
  });
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
 * `Plugin.defaultConfig` interface (see `packages/core/src/types/plugin.ts`).
 * The narrower `DEFAULT_CONFIG` shape is still enforced by
 * `telegramConfigSchema` validation downstream.
 */
function telegramDefaultConfig(): Record<string, unknown> {
  return structuredClone(DEFAULT_CONFIG) as Record<string, unknown>;
}

/** Read the Telegram section from a full Config object.
 * Delegates to {@link readTelegramConfigFromConfig} for the canonical
 * extension-slice extraction + default merge, then applies the runtime
 * coercions that `RuntimeConfig` requires (String chatId, array copies). */
function telegramFromConfig(cfg: Config): {
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
    notifyOnSessionEnd: tg.notifyOnSessionEnd ?? false,
    notifyOnDelegate: tg.notifyOnDelegate ?? true,
    longToolThresholdMs: tg.longToolThresholdMs ?? 30_000,
    maxMessageLength: tg.maxMessageLength ?? 4000,
    outboundQueuePerChat: tg.outboundQueuePerChat ?? 32,
    outboundQueueConcurrency: tg.outboundQueueConcurrency ?? 4,
    rateLimitTokensPerSecond: tg.rateLimitTokensPerSecond ?? 0.33,
    rateLimitBurst: tg.rateLimitBurst ?? 1,
    parseMode: tg.parseMode ?? '',
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: PLUGIN_NAME,
  version: '0.3.4',
  description: 'Telegram bridge — send/receive messages, get agent notifications.',
  apiVersion: '^0.1.10',
  capabilities: {
    tools: true,
    slashCommands: true,
    pipelines: [],
  },
  configAliases: [...PLUGIN_CONFIG_ALIASES],
  configFields: TELEGRAM_CONFIG_FIELDS,
  configSchema: telegramConfigSchema,
  defaultConfig: telegramDefaultConfig(),

  async setup(api) {
    const log = api.log;
    disposeRuntime(log);
    const cfg = readTelegramConfig(api);

    log.info('Starting Telegram plugin...');

    // ---- Mutable runtime config (updated via onConfigChange) ----
    const runtimeCfg: RuntimeConfig = {
      notifyChatId: cfg.notifyChatId,
      allowedOutboundChats: [...(cfg.allowedOutboundChats ?? [])],
      allowedUserIds: [...(cfg.allowedUsers ?? [])],
      allowGroupApprovals: cfg.allowGroupApprovals ?? false,
      notifyOnSessionEnd: cfg.notifyOnSessionEnd ?? false,
      notifyOnDelegate: cfg.notifyOnDelegate ?? true,
      longToolThresholdMs: cfg.longToolThresholdMs ?? 30_000,
      maxMessageLength: cfg.maxMessageLength ?? 4000,
      outboundQueuePerChat: cfg.outboundQueuePerChat ?? 32,
      outboundQueueConcurrency: cfg.outboundQueueConcurrency ?? 4,
      rateLimitTokensPerSecond: cfg.rateLimitTokensPerSecond ?? 0.33,
      rateLimitBurst: cfg.rateLimitBurst ?? 1,
      parseMode: cfg.parseMode ?? '',
    };

    // ---- Bot ----
    // Telegram allows one getUpdates consumer per token: elect a single
    // poller across wstack instances so concurrent TUI/WebUI/projects don't
    // fight over the token (HTTP 409 on every poll).
    const lock =
      cfg.singleInstanceLock === false
        ? undefined
        : new PollLock(lockPathForToken(cfg.botToken), { log });
    // Persist the polling cursor so a crash/restart doesn't replay messages.
    // Default to a token-scoped store under ~/.wrongstack/telegram; an explicit
    // offsetStoragePath overrides the location. Persistence is disabled only
    // when offsetStoragePath is set to an empty string.
    const offsetStore =
      cfg.offsetStoragePath === ''
        ? undefined
        : new OffsetStore({ token: cfg.botToken, path: cfg.offsetStoragePath });
    const bot = new TelegramBot({
      token: cfg.botToken,
      pollIntervalSec: cfg.pollIntervalSec ?? 2,
      ...inboundAllowlist(cfg),
      bufferSize: 50,
      log,
      offsetStore,
      lock,
      getParseMode: () => runtimeCfg.parseMode,
      onMessage(msg: TelegramIncomingMessage) {
        // Emit custom event so other plugins or the host can react.
        // The TUI can subscribe and surface it (future hook).
        api.emitCustom('telegram:message_received', msg);

        // Bridge to the inter-agent mailbox so other agents (leader,
        // background watchers) can discover Telegram messages without
        // polling the bot buffer. Broadcast as a low-priority note so
        // it informs without interrupting. Mailbox delivery is
        // best-effort — failure must never disrupt the bot's polling
        // loop, but surface it for debugging.
        const mailbox = api.mailbox;
        if (mailbox) {
          mailbox
            .send({
              from: 'telegram',
              to: 'leader',
              type: 'note',
              subject: scrubTelegramOutboundText(
                `📨 Telegram from ${msg.userName ?? `user_${msg.userId ?? 'unknown'}`}`,
              ),
              // Scrub credentials first, then fence: the scrubber redacts
              // secrets but does nothing against prompt injection — inbound
              // text is untrusted and must arrive inside a delimiter that
              // says so (see security/inbound.ts).
              body: fenceTelegramInboundText(scrubTelegramOutboundText(msg.text)),
              priority: 'low',
            })
            .catch((err: unknown) => {
              log.debug(`Telegram→mailbox bridge delivery failed: ${(err as Error).message}`);
            });
        }

        // Keep untrusted inbound content in the bot buffer only. Logs expose
        // bounded metadata so message text, sender, and chat IDs cannot leak.
        log.info(`📨 Telegram message received (${Math.min(bot.bufferCount, 50)} unread)`);
      },
    });

    // Validate the token before mutating host registries or acquiring the poll
    // lock. A failed preflight must leave setup observationally atomic.
    const probe = await bot.health();
    if (!probe.ok) {
      bot.stop();
      throw new Error(
        `Telegram plugin startup failed: ${probe.error ?? 'unknown error'}. ` +
          `Verify botToken in extensions.telegram (token from @BotFather, format "<id>:<35+ chars>").`,
      );
    }
    log.info(`Telegram self-test ok: @${probe.username ?? 'unknown'} (api.telegram.org reachable)`);

    const cleanups: Array<() => void> = [];
    try {
      // Bot cleanup is registered first so it runs last, after every host-side
      // listener and registry entry has been detached.
      cleanups.push(() => bot.stop());

      // Bounded outbound queue with per-chat backpressure. Notification events
      // and the /telegram:send slash command both enqueue through it; manual
      // telegram_send tool sends go through bot.sendMessage directly so user
      // errors surface immediately. The queue is drained on teardown.
      // Rate-limit fields are passed as getter callbacks so hot-reload
      // (via api.onConfigChange) takes effect on the next send without
      // rebuilding the queue.
      const outbound = new TelegramBotOutbound({
        bot,
        log,
        maxPerChat: runtimeCfg.outboundQueuePerChat,
        maxConcurrency: runtimeCfg.outboundQueueConcurrency,
        getRateLimitTokensPerSecond: () => runtimeCfg.rateLimitTokensPerSecond,
        getRateLimitBurst: () => runtimeCfg.rateLimitBurst,
      });
      cleanups.push(() => {
        void outbound.stop();
      });

      // ---- Register tools ----
      const sendTool = makeTelegramSendTool({
        bot,
        outbound,
        getDefaultChatId: () => runtimeCfg.notifyChatId,
        getAllowedOutboundChatIds: () => runtimeCfg.allowedOutboundChats,
        maxMessageLength: runtimeCfg.maxMessageLength,
        log,
      });
      const readTool = makeTelegramReadTool({ bot });
      const approveTool = makeTelegramApproveTool({
        bot,
        getDefaultChatId: () => runtimeCfg.notifyChatId,
        getAllowedOutboundChatIds: () => runtimeCfg.allowedOutboundChats,
        getAllowedUserIds: () => runtimeCfg.allowedUserIds,
        getAllowGroupApprovals: () => runtimeCfg.allowGroupApprovals,
        maxMessageLength: runtimeCfg.maxMessageLength,
        log,
      });
      for (const tool of [sendTool, readTool, approveTool]) {
        api.tools.register(tool);
        cleanups.push(() => {
          api.tools.unregister(tool.name);
        });
      }

      // ---- Event subscriptions ----

      // System prompts receive metadata only. Message text and identity stay
      // behind the explicit telegram_read tool boundary.
      const unregisterPrompt = api.registerSystemPromptContributor(async () => {
        const unreadCount = Math.min(bot.bufferCount, 50);
        if (unreadCount === 0) return [];
        return [
          {
            type: 'text' as const,
            text: [
              '## Telegram Inbox',
              `You have ${unreadCount} unread Telegram message(s).`,
              'Use `telegram_read` to retrieve them when needed.',
            ].join('\n'),
          },
        ];
      });
      cleanups.push(unregisterPrompt);

      // Register commands one at a time so a later collision can roll back the
      // commands already installed by this setup attempt.
      for (const command of [
        tgHealthCommand(bot, cfg),
        tgSendCommand(
          bot,
          {
            getDefaultChatId: () => runtimeCfg.notifyChatId,
            getAllowedOutboundChatIds: () => runtimeCfg.allowedOutboundChats,
            getMaxMessageLength: () => runtimeCfg.maxMessageLength,
          },
          outbound,
        ),
        tgChatIdCommand(cfg.notifyChatId),
      ]) {
        registerCommand(api, command, cleanups);
      }

      // ---- Notification channel ----
      // The `TelegramNotificationChannel` is registered with the host's
      // `Notifier` (api.notifier) when available, so the central router can
      // route `"telegram"`-channel notifications directly. The in-plugin
      // event handlers below still handle the "when to notify" logic; they
      // send through the channel directly. Once the central Notifier router
      // is fully built, these handlers move to the router entirely.
      let notifyChannel: TelegramNotificationChannel | undefined;
      if (runtimeCfg.notifyChatId !== undefined) {
        notifyChannel = new TelegramNotificationChannel({
          bot,
          chatId: runtimeCfg.notifyChatId,
          maxMessageLength: () => runtimeCfg.maxMessageLength,
          enqueueNotification: (chatId, text) => outbound.enqueueNotification(chatId, text),
          log,
        });
        // Register with the host's Notifier so other subsystems can send
        // notifications to the "telegram" channel without knowing Telegram.
        api.notifier?.registerChannel(notifyChannel);
      }

      // ---- Notification event handlers ----
      // Always subscribed; guard at event time against runtime flags so changes
      // take effect immediately without needing to restart the plugin.
      // Delivery goes through `notifyChannel` for rendering/scrubbing and then
      // through the shared outbound queue for ordering and backpressure.

      cleanups.push(
        api.events.on('session.ended', (event) => {
          if (!runtimeCfg.notifyOnSessionEnd || !runtimeCfg.notifyChatId || !notifyChannel) return;
          const payload: SessionEndedLike = {
            id: scrubTelegramOutboundText(event.id),
            inputTokens: event.usage.input,
            outputTokens: event.usage.output,
            cacheRead: event.usage.cacheRead,
            cacheWrite: event.usage.cacheWrite,
          };
          notifyChannel
            .deliver({
              title: 'Session ended',
              body: formatSessionEnded(payload),
              level: 'info',
              source: 'session.end',
            })
            .then((r) => {
              if (!r.ok)
                log.warn(`session.ended notification delivery failed: ${r.error ?? 'unknown'}`);
            })
            .catch((err: unknown) => {
              log.debug(`session.ended notification delivery threw: ${(err as Error).message}`);
            });
        }),
      );

      cleanups.push(
        api.events.on('tool.executed', (event) => {
          if (!runtimeCfg.notifyChatId || !notifyChannel || runtimeCfg.longToolThresholdMs <= 0)
            return;
          if (event.durationMs < runtimeCfg.longToolThresholdMs) return;
          const payload: ToolExecutedLike = {
            name: event.name,
            ok: event.ok,
            durationMs: event.durationMs,
            output:
              event.output === undefined ? undefined : scrubTelegramOutboundText(event.output),
          };
          notifyChannel
            .deliver({
              title: event.ok ? 'Tool completed' : 'Tool failed',
              body: formatToolExecuted(payload),
              level: event.ok ? 'info' : 'warning',
              source: 'tool.exec',
            })
            .then((r) => {
              if (!r.ok)
                log.warn(`tool.executed notification delivery failed: ${r.error ?? 'unknown'}`);
            })
            .catch((err: unknown) => {
              log.debug(`tool.executed notification delivery threw: ${(err as Error).message}`);
            });
        }),
      );

      cleanups.push(
        api.events.on('delegate.completed', (event) => {
          if (!runtimeCfg.notifyOnDelegate || !runtimeCfg.notifyChatId || !notifyChannel) return;
          const safeEvent = {
            ...event,
            target: scrubTelegramOutboundText(event.target),
            task: scrubTelegramOutboundText(event.task),
            status:
              event.status === undefined ? undefined : scrubTelegramOutboundText(event.status),
            summary: scrubTelegramOutboundText(event.summary),
          };
          notifyChannel
            .deliver({
              title: `Delegate: ${safeEvent.target}`,
              body: formatDelegateCompleted(safeEvent),
              level: event.ok ? 'info' : 'warning',
              source: 'delegate.completed',
            })
            .then((r) => {
              if (!r.ok)
                log.warn(
                  `delegate.completed notification delivery failed: ${r.error ?? 'unknown'}`,
                );
            })
            .catch((err: unknown) => {
              log.debug(
                `delegate.completed notification delivery threw: ${(err as Error).message}`,
              );
            });
        }),
      );

      // ---- Live config updates (P2.3 — atomic reconfiguration) ----
      // api.config is frozen at setup, but onConfigChange fires whenever the
      // ConfigStore is updated (from CLI /settings, WebUI prefSync, /telegram-settings).
      //
      // P2.2 classifies each changed key as HOT (apply live) or RESTART
      // (requires bot rebuild).  HOT keys mutate the shared runtimeCfg so
      // every handler picks up the new value on the next event.  RESTART
      // keys are logged with a restart hint — the operator must restart the
      // plugin for those to take effect.  A future iteration will attempt
      // an atomic bot rebuild for restart keys (build → health-check →
      // swap → rollback on failure).
      const unlistenConfig = api.onConfigChange((next, prev) => {
        // Build full TelegramPluginConfig snapshots for the P2.2 classifier.
        const nextTg = readTelegramConfigFromConfig(next);
        const prevTg = readTelegramConfigFromConfig(prev);
        const changedKeys = diffConfigKeys(prevTg, nextTg);
        const hotKeys = changedKeys.filter((c) => c.classification === 'hot').map((c) => c.key);
        const restartKeys = changedKeys
          .filter((c) => c.classification === 'restart-required')
          .map((c) => c.key);

        // Phase 1: Apply hot keys to the shared runtime config.
        // Only keys classified as hot-reload-safe are applied live.
        // Restart-required keys (notifyChatId, outboundQueue*, singleInstanceLock,
        // botToken, offsetStoragePath) keep their previous values until
        // the operator restarts the plugin.
        const fresh = telegramFromConfig(next);
        const hotSet = new Set<string>(hotKeys);

        // Table-driven hot-apply. Each entry maps a Telegram config key
        // to the runtime mutation to perform when that key changed.
        // Adding a new hot key here is a one-line change instead of a
        // duplicated `if (hotSet.has(...))` arm.
        type HotApplier = (
          runtimeCfg: RuntimeConfig,
          fresh: ReturnType<typeof telegramFromConfig>,
        ) => void;
        const HOT_APPLIERS: ReadonlyMap<string, HotApplier> = new Map<string, HotApplier>([
          [
            'allowedOutboundChats',
            (r, f) => {
              r.allowedOutboundChats = f.allowedOutboundChats;
            },
          ],
          [
            'allowedUsers',
            (r, f) => {
              r.allowedUserIds = f.allowedUserIds;
            },
          ],
          [
            'notifyOnSessionEnd',
            (r, f) => {
              r.notifyOnSessionEnd = f.notifyOnSessionEnd;
            },
          ],
          [
            'notifyOnDelegate',
            (r, f) => {
              r.notifyOnDelegate = f.notifyOnDelegate;
            },
          ],
          [
            'longToolThresholdMs',
            (r, f) => {
              r.longToolThresholdMs = f.longToolThresholdMs;
            },
          ],
          [
            'maxMessageLength',
            (r, f) => {
              r.maxMessageLength = f.maxMessageLength;
            },
          ],
          [
            'allowGroupApprovals',
            (r, f) => {
              r.allowGroupApprovals = f.allowGroupApprovals;
            },
          ],
          [
            'rateLimitTokensPerSecond',
            (r, f) => {
              r.rateLimitTokensPerSecond = f.rateLimitTokensPerSecond;
            },
          ],
          [
            'rateLimitBurst',
            (r, f) => {
              r.rateLimitBurst = f.rateLimitBurst;
            },
          ],
          [
            'parseMode',
            (r, f) => {
              r.parseMode = f.parseMode;
            },
          ],
        ]);
        for (const [key, apply] of HOT_APPLIERS) {
          if (hotSet.has(key)) apply(runtimeCfg, fresh);
        }

        // Inbound identity keys are hot: rebuild the live gate's sets so a
        // user/chat removal or an inboundMode change takes effect
        // immediately. Without this, the classifier reports the change as
        // hotApplied while the inbox gate (built once at setup) keeps
        // admitting removed senders until a plugin restart.
        if (
          hotSet.has('inboundMode') ||
          hotSet.has('allowedUsers') ||
          hotSet.has('allowedChats')
        ) {
          const sets = inboundAllowlist(nextTg);
          bot.inbox.updateAllowlist(sets.allowedUsers, sets.allowedChats);
        }
        // notifyChatId is RESTART-REQUIRED: the inbound allowlist
        // (built at setup) still uses the old value.  Applying the new
        // one here would make outbound notifications target a chat the
        // inbound allowlist does not yet recognise.  Deferred to restart.

        // maxMessageLength is hot-applied via the getter callback passed to
        // TelegramNotificationChannel at setup time, keeping api.notifier
        // and local event handlers fully synchronised without split-brain.

        // Phase 2: Surface restart-required keys.
        if (restartKeys.length > 0) {
          log.warn(
            'Telegram config changed restart-required keys — restart the plugin for these to take effect',
            { restartKeys, hotKeys },
          );
          api.emitCustom('telegram:restart_required', {
            keys: restartKeys,
            message: `Restart required for: ${restartKeys.join(', ')}`,
          });
        }

        log.debug('Telegram config updated', {
          hotApplied: hotKeys,
          restartRequired: restartKeys,
          notifyOnSessionEnd: runtimeCfg.notifyOnSessionEnd,
          notifyOnDelegate: runtimeCfg.notifyOnDelegate,
          longToolThresholdMs: runtimeCfg.longToolThresholdMs,
          parseMode: runtimeCfg.parseMode,
          notifyChatId: runtimeCfg.notifyChatId ?? 'not set',
        });
      });
      cleanups.push(unlistenConfig);

      // Polling is the final side effect: it may acquire the cross-process
      // lock and create timers, and bot.stop() releases all of them.
      bot.start();
      teardownState = { bot, outbound, cleanups };
      log.info('Telegram plugin ready');
    } catch (err) {
      teardownState = null;
      runCleanups(cleanups, log);
      throw err;
    }
  },

  async teardown(api) {
    const hadRuntime = teardownState !== null;
    disposeRuntime(api.log);
    if (hadRuntime) api.log.info('Telegram plugin torn down');
  },

  async health() {
    const state = teardownState;
    if (!state?.bot) return { ok: false, message: 'Plugin not initialized' };
    const h = await state.bot.health();
    return h;
  },
};

export default plugin;

// Exposed for tests to inspect the queue without going through the API surface.
export { teardownState };

// Re-export the types and classes consumers may want
export type { TelegramIncomingMessage } from './bot.js';
export type { TelegramPluginConfig } from './config.js';
export { TelegramNotificationChannel } from './notification-channel.js';
export type { TelegramNotificationChannelOptions } from './notification-channel.js';
