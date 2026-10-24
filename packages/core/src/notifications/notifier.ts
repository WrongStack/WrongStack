/**
 * Notifier — central dispatch for one-way notification delivery.
 *
 * The `Notifier` is the entry point for all notification traffic. It maps
 * channel names to `NotificationChannel` instances and handles dispatch,
 * result aggregation, and channel health reporting.
 *
 * A host (CLI, TUI, WebUI) creates one `Notifier` instance at startup,
 * registers channels from plugins and config, and makes it available via
 * the container or context. Plugins and the agent loop call
 * `notifier.notify()` to deliver messages.
 *
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
} from '@wrongstack/contracts/types/notification';
