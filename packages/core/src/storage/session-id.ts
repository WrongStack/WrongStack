/**
 * Session ID generation — extracted from session-store.ts.
 *
 * Pure functions: no I/O, no class state, no side effects.
 * Safe to unit-test in isolation.
 */
import { ulid } from '../utils/ulid.js';

/**
 * @deprecated Legacy helper kept for callers that still need filename-safe
 * labels. New session ids are opaque and do not include model/provider names.
 */
export function sanitizeModel(model: string): string {
  return model
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Generate a session ID in the format:
 *   `YYYY-MM-DD/sess_<ULID>`
 *
 * Examples:
 *   `2026-06-06/sess_01JX2S9V7T5M6N7P8Q9R0STXVW`
 *
 * The date prefix becomes a subdirectory so sessions group naturally by day.
 * The leaf is an opaque sortable id; provider/model names belong in metadata,
 * not file paths. Older IDs that contain model/provider text remain readable.
 */
export function generateSessionId(startedAt: string, _model?: string): string {
  const parsedTime = Date.parse(startedAt);
  const isValidDate = !Number.isNaN(parsedTime) && /^\d{4}-\d{2}-\d{2}/.test(startedAt);
  const seedTime = isValidDate ? parsedTime : Date.now();
  const date = isValidDate ? startedAt.slice(0, 10) : new Date(seedTime).toISOString().slice(0, 10);
  return `${date}/sess_${ulid(seedTime)}`;
}
