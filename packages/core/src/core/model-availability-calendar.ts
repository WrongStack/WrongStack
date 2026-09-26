export interface ModelBlackoutRule {
  id: string;
  enabled?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  /** JavaScript weekday numbers: Sunday=0 … Saturday=6. Empty means every day. */
  days?: number[] | undefined;
  /** Inclusive local start, HH:mm. */
  start: string;
  /** Exclusive local end, HH:mm. Equal to start means all day. */
  end: string;
  /** IANA timezone. Defaults to the host timezone. */
  timezone?: string | undefined;
  label?: string | undefined;
  /** `blackout`: deny inside. `allow_only`: deny outside all matching allow windows. */
  mode?: 'blackout' | 'allow_only' | undefined;
}

export interface ModelCalendarDecision {
  allowed: boolean;
  rule?: ModelBlackoutRule | undefined;
}

export function logicalCalendarTarget(
  providerId: string,
  model: string,
): {
  providerId: string;
  model: string;
} {
  if (providerId !== 'omniroute') return { providerId, model };
  const slash = model.indexOf('/');
  return slash > 0 && slash < model.length - 1
    ? { providerId: model.slice(0, slash), model: model.slice(slash + 1) }
    : { providerId, model };
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function minuteOfDay(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

function clockAt(date: Date, timezone?: string): { day: number; minute: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const weekday = parts.find((part) => part.type === 'weekday')?.value;
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (!weekday || WEEKDAYS[weekday] === undefined || !Number.isFinite(hour + minute))
      return undefined;
    return { day: WEEKDAYS[weekday], minute: hour * 60 + minute };
  } catch {
    return undefined;
  }
}

function targetMatches(
  rule: ModelBlackoutRule,
  providerIds: readonly string[],
  model: string,
): boolean {
  if (rule.provider && !providerIds.includes(rule.provider)) return false;
  if (rule.model && rule.model !== model) return false;
  return Boolean(rule.provider || rule.model);
}

function timeMatches(rule: ModelBlackoutRule, day: number, minute: number): boolean {
  const start = minuteOfDay(rule.start);
  const end = minuteOfDay(rule.end);
  if (start === undefined || end === undefined) return false;
  const days = rule.days?.length ? new Set(rule.days) : undefined;
  if (start === end) return !days || days.has(day);
  if (start < end) return (!days || days.has(day)) && minute >= start && minute < end;
  // Overnight: Monday 22:00–07:00 includes early Tuesday morning.
  if (minute >= start) return !days || days.has(day);
  const previousDay = (day + 6) % 7;
  return minute < end && (!days || days.has(previousDay));
}

/**
 * `provider` may be one id or all of a provider's identities — its config key
 * and the catalog entry it is built from — so a rule naming the vendor
 * (`anthropic`) also covers a second account `work` built from it.
 */
export function evaluateModelCalendar(
  rules: readonly ModelBlackoutRule[] | undefined,
  provider: string | readonly string[],
  requestedModel: string,
  at = new Date(),
): ModelCalendarDecision {
  let model = requestedModel;
  const providerIds: string[] = [];
  for (const id of typeof provider === 'string' ? [provider] : provider) {
    const target = logicalCalendarTarget(id, requestedModel);
    providerIds.push(target.providerId);
    if (target.providerId !== id) model = target.model;
  }
  const allowRules: ModelBlackoutRule[] = [];
  let allowMatched = false;
  for (const rule of rules ?? []) {
    if (rule.enabled === false || !targetMatches(rule, providerIds, model)) continue;
    const clock = clockAt(at, rule.timezone);
    if (!clock || minuteOfDay(rule.start) === undefined || minuteOfDay(rule.end) === undefined)
      continue;
    if (rule.mode === 'allow_only') {
      allowRules.push(rule);
      if (timeMatches(rule, clock.day, clock.minute)) allowMatched = true;
    } else if (timeMatches(rule, clock.day, clock.minute)) {
      return { allowed: false, rule };
    }
  }
  if (allowRules.length > 0 && !allowMatched) return { allowed: false, rule: allowRules[0] };
  return { allowed: true };
}
