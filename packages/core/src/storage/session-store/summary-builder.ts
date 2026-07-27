import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type { SessionEvent, SessionSummary } from '../../types/session.js';
import { scrubPersistedSessionEvent } from '../session-read-scrubber.js';
import { sessionContentPreview, userInputTitle } from '../session-helpers.js';

export async function summarizeSessionFile(opts: {
  id: string;
  file: string;
  mtime: string;
  secretScrubber: SecretScrubber;
}): Promise<SessionSummary> {
  return summarizeSessionEventSequence({
    id: opts.id,
    events: iterateSessionEvents(opts.file, opts.secretScrubber),
    mtime: opts.mtime,
  });
}

export async function summarizeSessionEvents(opts: {
  id: string;
  events: Iterable<SessionEvent>;
  mtime: string;
}): Promise<SessionSummary> {
  return summarizeSessionEventSequence(opts);
}

async function summarizeSessionEventSequence(opts: {
  id: string;
  events: Iterable<SessionEvent> | AsyncIterable<SessionEvent>;
  mtime: string;
}): Promise<SessionSummary> {
  const { id, events, mtime } = opts;
  try {
    let title = '(empty session)';
    let startedAt = new Date(0).toISOString();
    let endedAt: string | undefined;
    let model = 'unknown';
    let provider = 'unknown';
    let tokenIn = 0;
    let tokenOut = 0;
    let iterationCount = 0;
    let toolCallCount = 0;
    let toolErrorCount = 0;
    let fileChangeCount = 0;
    let messageCount = 0;
    let lastUserMessage: string | undefined;
    let lastUserMessageMs = Number.NEGATIVE_INFINITY;
    // Seed lastActivityAt from mtime when startedAt is still the epoch
    // default (empty session or no session_start event), so the summary
    // shows the file's real last-modified time instead of 1970-01-01.
    let lastActivityAt = startedAt;
    let lastActivityMs = Date.parse(startedAt);
    if (lastActivityMs === 0 || !Number.isFinite(lastActivityMs)) {
      const mtimeMs = Date.parse(mtime);
      if (Number.isFinite(mtimeMs) && mtimeMs > 0) {
        lastActivityAt = mtime;
        lastActivityMs = mtimeMs;
      }
    }
    const toolBreakdown: Record<string, number> = {};
    let outcome: SessionSummary['outcome'];
    let lastEventType: SessionEvent['type'] | undefined;
    let hasError = false;
    let sawStart = false;

    for await (const e of events) {
      lastEventType = e.type;
      const eventActivityMs = Date.parse(e.ts);
      if (Number.isFinite(eventActivityMs) && (!Number.isFinite(lastActivityMs) || eventActivityMs > lastActivityMs)) {
        lastActivityAt = e.ts;
        lastActivityMs = eventActivityMs;
      }
      if (e.type === 'session_start') {
        if (!sawStart) {
          sawStart = true;
          startedAt = e.ts;
          model = e.model ?? 'unknown';
          provider = e.provider ?? 'unknown';
        }
      } else if (e.type === 'session_end') {
        endedAt = e.ts;
      } else if (e.type === 'user_input') {
        if (title === '(empty session)') title = userInputTitle(e.content);
        const userMessageMs = Date.parse(e.ts);
        if (!Number.isFinite(userMessageMs) || userMessageMs >= lastUserMessageMs) {
          lastUserMessage = sessionContentPreview(e.content);
          if (Number.isFinite(userMessageMs)) lastUserMessageMs = userMessageMs;
        }
        messageCount++;
      } else if (e.type === 'llm_response') {
        messageCount++;
        tokenIn += e.usage.input ?? 0;
        tokenOut += e.usage.output ?? 0;
      } else if (e.type === 'in_flight_start') iterationCount++;
      else if (e.type === 'tool_call_start') {
        toolCallCount++;
        toolBreakdown[e.name] = (toolBreakdown[e.name] ?? 0) + 1;
      } else if (e.type === 'tool_result' && e.isError) toolErrorCount++;
      else if (e.type === 'file_snapshot') fileChangeCount += e.files.length;
      else if (e.type === 'error' || e.type === 'provider_error') hasError = true;
    }

    if (lastEventType === 'session_end') {
      outcome = 'completed';
    } else if (lastEventType === 'in_flight_start') {
      outcome = 'aborted';
    } else if (hasError) {
      outcome = 'error';
    }

    return {
      id,
      title,
      startedAt,
      endedAt,
      model,
      provider,
      tokenTotal: tokenIn + tokenOut,
      lastActivityAt,
      messageCount,
      ...(lastUserMessage !== undefined ? { lastUserMessage } : {}),
      iterationCount: iterationCount > 0 ? iterationCount : undefined,
      toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
      toolErrorCount: toolErrorCount > 0 ? toolErrorCount : undefined,
      fileChangeCount: fileChangeCount > 0 ? fileChangeCount : undefined,
      toolBreakdown: Object.keys(toolBreakdown).length > 0 ? toolBreakdown : {},
      outcome,
    };
  } catch {
    return {
      id,
      title: '(damaged)',
      startedAt: mtime,
      model: 'unknown',
      provider: 'unknown',
      tokenTotal: 0,
      lastActivityAt: mtime,
      messageCount: 0,
    };
  }
}

export async function* iterateSessionEvents(
  file: string,
  secretScrubber: SecretScrubber,
): AsyncGenerator<SessionEvent> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof (parsed as { type?: unknown | undefined }).type === 'string' &&
          typeof (parsed as { ts?: unknown | undefined }).ts === 'string'
        ) {
          yield scrubPersistedSessionEvent(parsed as SessionEvent, secretScrubber);
        }
      } catch {
        // skip malformed JSON
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
