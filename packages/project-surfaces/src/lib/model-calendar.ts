import type { ModelBlackoutRule } from '@wrongstack/contracts/types/model-availability';

export const CALENDAR_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function minuteOfDay(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : undefined;
}

export function isCalendarRuleActive(rule: ModelBlackoutRule, at = new Date()): boolean {
  if (rule.enabled === false) return false;
  const start = minuteOfDay(rule.start);
  const end = minuteOfDay(rule.end);
  if (start === undefined || end === undefined) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: rule.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const day = CALENDAR_DAYS.indexOf(parts.find((part) => part.type === 'weekday')?.value ?? '');
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (day < 0 || !Number.isFinite(hour + minute)) return false;
    const current = hour * 60 + minute;
    const days = rule.days?.length ? new Set(rule.days) : undefined;
    if (start === end) return !days || days.has(day);
    if (start < end) return (!days || days.has(day)) && current >= start && current < end;
    if (current >= start) return !days || days.has(day);
    return current < end && (!days || days.has((day + 6) % 7));
  } catch {
    return false;
  }
}

export function isCalendarRuleValid(rule: ModelBlackoutRule): boolean {
  if (minuteOfDay(rule.start) === undefined || minuteOfDay(rule.end) === undefined) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: rule.timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function ruleTarget(rule: ModelBlackoutRule): string {
  return `${rule.provider ?? '*'}/${rule.model ?? '*'}`;
}

export function isCalendarRuleBlocking(rule: ModelBlackoutRule, at = new Date()): boolean {
  const inside = isCalendarRuleActive(rule, at);
  return rule.mode === 'allow_only' ? !inside : inside;
}

export function blockingCalendarRules(
  rules: readonly ModelBlackoutRule[],
  at = new Date(),
): ModelBlackoutRule[] {
  const groups = new Map<string, ModelBlackoutRule[]>();
  for (const rule of rules) {
    if (rule.enabled === false || !isCalendarRuleValid(rule)) continue;
    const key = ruleTarget(rule);
    groups.set(key, [...(groups.get(key) ?? []), rule]);
  }
  const blocked: ModelBlackoutRule[] = [];
  for (const group of groups.values()) {
    const blackout = group.find(
      (rule) => rule.mode !== 'allow_only' && isCalendarRuleActive(rule, at),
    );
    if (blackout) {
      blocked.push(blackout);
      continue;
    }
    const allowRules = group.filter((rule) => rule.mode === 'allow_only');
    if (allowRules.length > 0 && !allowRules.some((rule) => isCalendarRuleActive(rule, at))) {
      blocked.push(allowRules[0]!);
    }
  }
  return blocked;
}
