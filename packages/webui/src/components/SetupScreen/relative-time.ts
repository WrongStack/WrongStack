export function formatSetupRelativeTime(
  date: Date,
  t: (key: string, values?: Record<string, number>) => string,
): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return t('setup:screen.time.justNow');
  if (diffSec < 60) return t('setup:screen.time.secondsAgo', { count: diffSec });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('setup:screen.time.minutesAgo', { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('setup:screen.time.hoursAgo', { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  return t('setup:screen.time.daysAgo', { count: diffDay });
}
