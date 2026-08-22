import type { KanbanTaskStatus } from '../types.js';

export function statusForColumn(columnId: string): KanbanTaskStatus {
  const normalized = columnId.toLowerCase();
  if (normalized.includes('done') || normalized.includes('complete')) return 'completed';
  if (normalized.includes('progress') || normalized.includes('doing')) return 'in_progress';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('block')) return 'blocked';
  if (normalized.includes('ready')) return 'ready';
  return 'pending';
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty.`);
  return trimmed;
}

export function parseIsoTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isoFromTimestamp(value: number | undefined, fallback: string): string {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return new Date(value).toISOString();
}

export { nowIso } from '@wrongstack/primitives';

export function uniqueIdFromSet(usedIds: Set<string>, requested: string): string {
  const base = requested || 'item';
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
