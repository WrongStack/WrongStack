import type { AvailabilityWords } from './availability-model';
import type { useDesktopText } from './desktop-i18n';

type Translate = ReturnType<typeof useDesktopText>['t'];

/** The availability issue wording in the display language, for the editor and the save check. */
export const availabilityWords = (t: Translate): AvailabilityWords => ({
  window: (index) => t('availability.window', { number: index }),
  uniqueId: t('availability.issue.uniqueId'),
  target: t('availability.issue.target'),
  times: t('availability.issue.times'),
  days: t('availability.issue.days'),
  timezone: t('availability.issue.timezone'),
});
