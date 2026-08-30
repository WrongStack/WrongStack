import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { effectiveInputTokens } from '../../types/provider.js';
import type { SecretScrubber } from '../../types/secret-scrubber.js';
import type { SessionEvent, SessionSummary } from '../../types/session.js';
import { sessionContentPreview, userInputTitle } from '../session-helpers.js';
import { isSessionErrorEvent, resolveSessionOutcome } from '../session-outcome.js';
import { scrubPersistedSessionEvent } from '../session-read-scrubber.js';

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

    let lastEventType: SessionEvent['type'] | undefined;
    let hasError = false;
    let sawStart = false;

    for await (const e of events) {
      lastEventType = e.type;
      const eventActivityMs = Date.parse(e.ts);
      if (
        Number.isFinite(eventActivityMs) &&
        (!Number.isFinite(lastActivityMs) || eventActivityMs > lastActivityMs)
      ) {
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
      } else if (e.type === 'session_resumed') {
        if (!sawStart) {
          sawStart = true;
          startedAt = e.ts;
        }
        if (e.model) model = e.model;
        if (e.provider) provider = e.provider;
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
      } else if (e.type === 'message_appended' && e.version === 1 && e.message) {
        messageCount++;
        if (e.message.role === 'user') {
          if (title === '(empty session)') title = userInputTitle(e.message.content);
          const userMessageMs = Date.parse(e.ts);
          if (!Number.isFinite(userMessageMs) || userMessageMs >= lastUserMessageMs) {
            lastUserMessage = sessionContentPreview(e.message.content);
            if (Number.isFinite(userMessageMs)) lastUserMessageMs = userMessageMs;
          }
        }
      } else if (e.type === 'llm_response') {
        messageCount++;
        // Cache buckets included — see totalUsageTokens for why tokenTotal
        // counts the whole prompt the model loaded, not just the fresh slice.
        // `usage` is required by the type, but a journal on disk is not a
        // type — and the catch below turns ANY throw into a whole-session
        // `(damaged)` summary, so one malformed event would cost the session
        // its title, its counts and its place in the picker. Guarded here
        // rather than inside `effectiveInputTokens`, whose non-null contract
        // three other call sites rely on.
        if (e.usage) {
          tokenIn += effectiveInputTokens(e.usage);
          tokenOut += e.usage.output ?? 0;
        }
        // A mid-session model switch or fallback rotation is only visible on
        // the response that used it; session_start/session_resumed record the
        // model the session OPENED with. Last writer wins, matching the live
        // tracker so a rebuilt summary equals the one the writer produced.
        if (e.model) model = e.model;
        if (e.provider) provider = e.provider;
      } else if (e.type === 'in_flight_start') iterationCount++;
      else if (e.type === 'tool_call_start') {
        toolCallCount++;
        toolBreakdown[e.name] = (toolBreakdown[e.name] ?? 0) + 1;
      } else if (e.type === 'tool_result' && e.isError) toolErrorCount++;
      else if (e.type === 'file_snapshot') fileChangeCount += e.files.length;
      else if (isSessionErrorEvent(e)) hasError = true;
    }

    const outcome = resolveSessionOutcome(lastEventType, hasError);

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
