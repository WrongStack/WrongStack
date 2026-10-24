/**
 * Notification contracts now live in `types/notification.ts` so low layers
 * (the plugin API) can name them; re-exported here for existing importers.
 *
 * @module notifications
 */

export type {
  NotificationChannel,
  NotificationLevel,
  NotificationMessage,
  NotificationResult,
} from '@wrongstack/contracts/types/notification';
