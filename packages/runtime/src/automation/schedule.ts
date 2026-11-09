import { CronExpressionParser } from 'cron-parser';

export interface CronSchedule {
  type: 'cron';
  expression: string;
  timezone: string;
}

/** Five-field numeric cron only: no seconds, random fields or implicit local timezone. */
export function validateCronSchedule(schedule: CronSchedule): void {
  if (
    schedule?.type !== 'cron' ||
    Object.keys(schedule).some((key) => !['type', 'expression', 'timezone'].includes(key)) ||
    typeof schedule.expression !== 'string' ||
    schedule.expression.length > 128 ||
    schedule.expression.trim().split(/\s+/).length !== 5 ||
    !/^[\d*,/\-\s]+$/.test(schedule.expression) ||
    typeof schedule.timezone !== 'string' ||
    schedule.timezone.length > 128
  )
    throw new Error('Use a five-field cron expression and an IANA timezone');
  new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format(0);
  nextCronTime(schedule, Date.UTC(2026, 0, 1));
}

export function nextCronTime(schedule: CronSchedule, after: number): number {
  if (!Number.isFinite(after)) throw new Error('Invalid schedule timestamp');
  const end = new Date(after);
  end.setUTCFullYear(end.getUTCFullYear() + 8);
  return CronExpressionParser.parse(schedule.expression, {
    currentDate: new Date(after),
    endDate: end,
    tz: schedule.timezone,
  })
    .next()
    .getTime();
}

export function previewSchedule(
  job: { intervalMs?: number | undefined; schedule?: CronSchedule | undefined },
  now = Date.now(),
  count = 5,
): number[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10)
    throw new Error('Invalid preview count');
  if (!Number.isFinite(now)) throw new Error('Invalid schedule timestamp');
  if (
    !job.schedule &&
    job.intervalMs !== undefined &&
    (typeof job.intervalMs !== 'number' || !Number.isFinite(job.intervalMs) || job.intervalMs <= 0)
  ) {
    throw new Error('Invalid schedule interval');
  }
  const times: number[] = [];
  let cursor = now;
  for (let i = 0; i < count; i++) {
    if (job.schedule) cursor = nextCronTime(job.schedule, cursor);
    else if (job.intervalMs) cursor += job.intervalMs;
    else break;
    times.push(cursor);
  }
  return times;
}
