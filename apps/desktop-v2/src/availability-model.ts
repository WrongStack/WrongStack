import type { ModelBlackoutRule } from '@wrongstack/contracts/types/model-availability';
export const scheduleDays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
export function scheduleMinute(value: string): number | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [h, m] = value.split(':').map(Number);
  return h! * 60 + m!;
}
/** The wording of availability issues; the settings pass the display language's. */
export interface AvailabilityWords {
  window: (index: number) => string;
  uniqueId: string;
  target: string;
  times: string;
  days: string;
  timezone: string;
}

const ENGLISH_ISSUES: AvailabilityWords = {
  window: (index) => 'Window ' + index,
  uniqueId: 'use a unique window identifier.',
  target: 'choose a provider or model target.',
  times: 'enter times in HH:mm format.',
  days: 'choose valid weekdays.',
  timezone: 'use an IANA timezone such as Europe/Kyiv or UTC.',
};

export function availabilityIssue(
  value: unknown,
  words: AvailabilityWords = ENGLISH_ISSUES,
): string | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const rule = item as ModelBlackoutRule,
      label = rule.label?.trim() || words.window(index + 1);
    if (!rule.id || ids.has(rule.id)) return `${label}: ${words.uniqueId}`;
    ids.add(rule.id);
    if (!rule.provider?.trim() && !rule.model?.trim()) return `${label}: ${words.target}`;
    if (scheduleMinute(rule.start) === null || scheduleMinute(rule.end) === null)
      return `${label}: ${words.times}`;
    if (
      rule.days?.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(rule.days).size !== (rule.days?.length ?? 0)
    )
      return `${label}: ${words.days}`;
    if (rule.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: rule.timezone }).format(new Date());
      } catch {
        return `${label}: ${words.timezone}`;
      }
    }
  }
  return null;
}
/** Local wall-clock preview only. Runtime eligibility remains owned by the engine. */
export function scheduleSegments(rule: ModelBlackoutRule, day: number): [number, number][] {
  const start = scheduleMinute(rule.start),
    end = scheduleMinute(rule.end);
  if (start === null || end === null) return [];
  const selected = (value: number) => !rule.days?.length || rule.days.includes(value);
  if (start === end) return selected(day) ? [[0, 1440]] : [];
  if (start < end) return selected(day) ? [[start, end]] : [];
  return [
    ...(selected(day) ? [[start, 1440] as [number, number]] : []),
    ...(selected((day + 6) % 7) && end > 0 ? [[0, end] as [number, number]] : []),
  ];
}
