import { truncMid } from './basic-format.js';

export const OUT_BUDGET = 80;
export const GENERIC_BUDGET = 240;

export function summarizeJsonObject(obj: Record<string, unknown>): string | null {
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;
  const priority = [
    'ok',
    'status',
    'timedOut',
    'stopReason',
    'reason',
    'error',
    'message',
    'result',
    'summary',
    'iterations',
    'toolCalls',
    'durationMs',
    'subagentId',
    'taskId',
  ];
  const ordered = [
    ...priority.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !priority.includes(key)),
  ];
  const parts: string[] = [];
  let used = 0;
  for (const key of ordered) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    const rendered =
      typeof value === 'string'
        ? `${key}="${truncMid(value.replace(/\s+/g, ' '), 80)}"`
        : typeof value === 'number' || typeof value === 'boolean'
          ? `${key}=${value}`
          : Array.isArray(value)
            ? `${key}=[${value.length}]`
            : `${key}={…}`;
    if (used + rendered.length > GENERIC_BUDGET) {
      parts.push('…');
      break;
    }
    parts.push(rendered);
    used += rendered.length + 3;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
