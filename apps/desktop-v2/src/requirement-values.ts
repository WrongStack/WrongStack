/** A requirement field as text; anything else reads as empty. */
export const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** The strings of a list field. */
export const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** An enum value as words (`bug_fix` → `bug fix`). */
export const readable = (value: unknown) => text(value).replaceAll('_', ' ') || 'Not reported';

/** Whether the request runs under the three-stage VIBE verification protocol. */
export const isVibeIntake = (detail: Record<string, unknown>) => detail['isVibeMode'] === true;
