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
  const date = startedAt.slice(0, 10); // "2026-06-06"
  const seedTime = Number.isNaN(Date.parse(startedAt)) ? Date.now() : Date.parse(startedAt);
  return `${date}/sess_${ulid(seedTime)}`;
}
