import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { SessionData, SessionEvent, SessionSummary } from '../types/session.js';
import { sessionContentText } from './session-helpers.js';

/**
 * Read-side migration boundary for transcripts written before write-time
 * secret scrubbing existed. Scrub the complete object graph before it enters
 * a cache, message projection, search result, export, or surface response.
 */
export function scrubPersistedSessionEvent(
  event: SessionEvent,
  scrubber: SecretScrubber,
): SessionEvent {
  // Copy-on-write where the scrubber offers it. Every caller hands in a
  // freshly-parsed journal line that nothing else holds a reference to, which
  // is exactly the ownership `scrubObjectShared` requires — and this is the
  // call that runs once per event of a resume, so the graph rebuild it avoids
  // is the difference between a 133 MB journal costing ~2.4 s of scrubbing and
  // ~0.6 s. Falls back for scrubbers that predate the method.
  return scrubber.scrubObjectShared
    ? scrubber.scrubObjectShared(event)
    : scrubber.scrubObject(event);
}

export function scrubPersistedSessionData(
  data: SessionData,
  scrubber: SecretScrubber,
): SessionData {
  return scrubber.scrubObject(data);
}

export function scrubPersistedSessionSummary(
  summary: SessionSummary,
  scrubber: SecretScrubber,
): SessionSummary {
  const scrubbed = scrubber.scrubObject(summary);
  const { name: _name, lastUserMessage: _lastUserMessage, ...rest } = scrubbed;
  const title = sessionContentText(scrubbed.title) || '(empty session)';
  const name = scrubbed.name === undefined ? '' : sessionContentText(scrubbed.name);
  const lastUserMessage =
    scrubbed.lastUserMessage === undefined ? '' : sessionContentText(scrubbed.lastUserMessage);
  return {
    ...rest,
    title,
    ...(name ? { name } : {}),
    ...(lastUserMessage ? { lastUserMessage } : {}),
  };
}
