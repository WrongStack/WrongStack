import { createTranscriptLineReader } from './transcript-io.js';

const EMPTY_SESSION_EVENT_TYPES = new Set(['session_start', 'session_resumed', 'session_end']);

/**
 * Return true only for a well-formed journal containing lifecycle envelope
 * events and nothing else. Parsing fails closed so a damaged or newer journal
 * can never be mistaken for an empty session and deleted.
 */
export async function isStrictlyEmptySessionFile(file: string): Promise<boolean> {
  const reader = createTranscriptLineReader(file);
  let sawSessionStart = false;

  try {
    for await (const line of reader.lines) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return false;
      }
      if (event === null || typeof event !== 'object' || Array.isArray(event)) return false;
      const type = (event as { type?: unknown }).type;
      if (typeof type !== 'string' || !EMPTY_SESSION_EVENT_TYPES.has(type)) return false;
      if (type === 'session_start') sawSessionStart = true;
    }
  } catch {
    return false;
  } finally {
    reader.close();
  }

  return sawSessionStart;
}
