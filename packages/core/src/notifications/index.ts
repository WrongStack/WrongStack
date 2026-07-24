/**
 * Notifications subsystem — one-way channel-agnostic delivery.
 *
 * This module defines the contracts and interfaces for sending notifications
 * from the agent to the user through any registered channel (Telegram,
 * Slack webhook, generic webhook, email, ntfy, etc.). The system is built
 * around three core abstractions:
 *
 *  - `NotificationMessage` — a channel-agnostic payload with title, body,
 *    severity level, and optional metadata.
 *  - `NotificationChannel` — an interface each provider implements to
 *    handle delivery to its specific medium.
 *  - `Notifier` — the central dispatch that routes messages to channels
 *    by name and aggregates results.
 *
 * Usage (conceptual):
 *
 * ```ts
 * import { Notifier } from '@wrongstack/core';
 *
 * // The host registers channels at startup:
 * notifier.registerChannel(new SlackWebhookChannel({ webhookUrl }));
 * notifier.registerChannel(new TelegramChannel({ bot, chatId }));
 *
 * // Any caller sends a notification:
 * await notifier.notify(['slack', 'telegram'], {
 *   title: 'Deploy complete',
 *   body: 'v2.1.0 deployed to production — 12/12 tests passed.',
 *   level: 'info',
 *   source: 'ci:pipeline',
 * });
 * ```
 *
 * @packageDocumentation
 * @module notifications
 * @public
 */

export type {
  NotificationChannel,
  NotificationChannelStatus,
  NotificationLevel,
  NotificationMessage,
  NotificationResult,
  Notifier,
  NotifierCounters,
} from './notifier.js';
export { NotifierImpl } from './notifier-impl.js';
