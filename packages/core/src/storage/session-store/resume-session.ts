import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ContentBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import type {
  ResumedSession,
  SessionData,
  SessionEvent,
  SessionSummary,
} from '@wrongstack/contracts/types/session';
import { toErrorMessage } from '../../utils/index.js';
import type { EventBus } from '../event-bus-port.js';
import { FileSessionWriter } from '../file-session-writer.js';
import type { SessionCheckpointCas } from '../session-checkpoint-cas.js';
import { sessionContentText } from '../session-helpers.js';
import { extractInterruptedTools, SessionRecovery } from '../session-recovery.js';
import {
  formatCrashRecoveryNotice,
  formatInterruptedToolNotice,
  formatResumeValidationNotice,
  isResumeNoticeMessage,
  validateResumeFileObservations,
} from '../session-resume-validation.js';
import { emitSessionStoreError, emitSessionStoreWrite } from './events.js';
import { summarizeSessionEvents, summarizeSessionFile } from './summary-builder.js';

export interface ResumeSessionParams {
  id: string;
  canonicalId: string;
  file: string;
  projectRoot?: string | undefined;
  events?: EventBus | undefined;
  secretScrubber: SecretScrubber;
  checkpointCas?: SessionCheckpointCas | undefined;
  onAppend?: ((event: SessionEvent) => void) | undefined;
  onAppendBatch?: ((events: SessionEvent[]) => void) | undefined;
  load: (id: string) => Promise<SessionData>;
  readSummaryManifest: (
    id: string,
    startTime?: number,
    strict?: boolean,
  ) => Promise<SessionSummary | null>;
  searchEvents: (
    id: string,
    predicate: (event: SessionEvent, index: number, ts: string) => boolean,
  ) => Promise<Array<{ event: SessionEvent }>>;
  persistCatalogSummary: (summary: SessionSummary) => Promise<void>;
  logWarn: (msg: string, ctx?: Record<string, unknown>) => void;
  /** Store root used to rescan the full transcript when load() dropped events. */
  sessionsDir?: string | undefined;
}

export async function executeResumeSession(params: ResumeSessionParams): Promise<ResumedSession> {
  const {
    canonicalId,
    file,
    projectRoot,
    events,
    secretScrubber,
    checkpointCas,
    onAppend,
    onAppendBatch,
    load,
    readSummaryManifest,
    searchEvents,
    persistCatalogSummary,
    logWarn,
    sessionsDir,
  } = params;

  const t0 = Date.now();
  const data = await load(canonicalId);
  const persistedSummary = await readSummaryManifest(canonicalId);
  const fileStat = await fsp.stat(file);
  const eventsDropped = data.eventsDropped ?? 0;
  const derivedSummary =
    eventsDropped > 0
      ? await summarizeSessionFile({
          id: canonicalId,
          file,
          mtime: fileStat.mtime.toISOString(),
          secretScrubber,
        })
      : await summarizeSessionEvents({
          id: canonicalId,
          events: data.events,
          mtime: fileStat.mtime.toISOString(),
        });
  const initialSummary: SessionSummary = {
    ...derivedSummary,
    ...(persistedSummary?.name !== undefined ? { name: persistedSummary.name } : {}),
  };

  // Crash-aware resume (P2): heal a dangling in_flight boundary over the
  // already-loaded events. Synthesized error results pair with the dangling
  // tool_use ids; the resumed writer appends them plus an
  // in_flight_end(reason='recovered') marker so detectStale()/listResumable()
  // report a clean file afterward.
  // load() may drop the oldest events under a byte budget. Stale detection
  // that only looks at the retained tail can miss an in_flight_start that
  // still sits on disk, leaving detectStale() stuck after a "successful"
  // resume. Rescan the file when events were dropped.
  let recoveryPlan = SessionRecovery.buildRecoveryPlan(data.events, canonicalId);
  if (eventsDropped > 0 && sessionsDir) {
    const fromDisk = await new SessionRecovery(sessionsDir).recover(canonicalId);
    if (fromDisk) recoveryPlan = fromDisk;
  }
  const interruptedTools = recoveryPlan.stale ? extractInterruptedTools(recoveryPlan) : [];
  const synthesizedResults: SessionEvent[] = interruptedTools.flatMap((tool) =>
    typeof tool.id === 'string'
      ? [
          {
            type: 'tool_result',
            ts: new Date().toISOString(),
            id: tool.id,
            content:
              '[interrupted] No result was recorded — the previous process stopped before this call completed. Re-run it if still needed.',
            isError: true,
          } as SessionEvent,
        ]
      : [],
  );
  if (synthesizedResults.length > 0) data.events.push(...synthesizedResults);

  const noticeMessages: Message[] = [];
  let resumeValidation: import('@wrongstack/contracts/types/session').ResumeValidation | undefined;
  if (projectRoot) {
    try {
      const validationEvents =
        eventsDropped > 0
          ? (
              await searchEvents(canonicalId, (ev: SessionEvent) => ev.type === 'file_observation')
            ).map((h) => h.event)
          : data.events;
      resumeValidation = await validateResumeFileObservations(validationEvents, projectRoot);
      const notice = formatResumeValidationNotice(resumeValidation, projectRoot);
      if (notice) {
        noticeMessages.push({
          role: 'system',
          content: notice,
          ts: resumeValidation.checkedAt,
        });
      }
    } catch (err) {
      emitSessionStoreError(
        events,
        canonicalId,
        file,
        'resume_validation',
        toErrorMessage(err),
        true,
      );
    }
  }

  // When the run crashed mid-iteration the dedicated crash-recovery notice
  // below lists every interrupted call explicitly; the generic count notice
  // would only duplicate it.
  const interruptedNotice = recoveryPlan.stale
    ? null
    : formatInterruptedToolNotice(data.pendingToolUseCount ?? 0);
  if (interruptedNotice) {
    noticeMessages.push({
      role: 'system',
      content: interruptedNotice,
      ts: new Date().toISOString(),
    });
  }
  const crashNotice = formatCrashRecoveryNotice(interruptedTools, recoveryPlan.context);
  if (crashNotice) {
    noticeMessages.push({
      role: 'system',
      content: crashNotice,
      ts: new Date().toISOString(),
    });
  }

  const carriedMessages = data.messages.filter((message) => !isResumeNoticeMessage(message));
  const recoveredMessages = appendSyntheticRecoveryMessages(
    carriedMessages,
    recoveryPlan.pendingEvents,
    synthesizedResults,
  );
  const { pendingToolUseCount: _healedPendingToolUseCount, ...dataWithoutPendingToolUseCount } =
    data;
  const resumedBase = synthesizedResults.length > 0 ? dataWithoutPendingToolUseCount : data;
  const resumedData: SessionData = {
    ...resumedBase,
    ...(resumeValidation ? { resumeValidation } : {}),
    messages: [...recoveredMessages, ...noticeMessages],
  };

  let handle: fsp.FileHandle;
  try {
    handle = await openSessionForAppend(file);
  } catch (err) {
    emitSessionStoreError(events, canonicalId, file, 'resume', toErrorMessage(err), false);
    throw new Error(`Failed to open session "${canonicalId}" for append: ${toErrorMessage(err)}`, {
      cause: err,
    });
  }

  try {
    const writer = new FileSessionWriter(
      canonicalId,
      handle,
      data.metadata.startedAt,
      {
        id: canonicalId,
        model: data.metadata.model,
        provider: data.metadata.provider,
        ...(projectRoot ? { checkout: projectRoot } : {}),
      },
      events,
      {
        resumed: true,
        initialSummary,
        dir: path.dirname(file),
        filePath: file,
        secretScrubber,
        checkpointCas,
        onAppend,
        onAppendBatch,
        resolveName: async () => {
          // Strict: an unreadable manifest must not read as "no name" (see finalize).
          const current = await readSummaryManifest(canonicalId, undefined, true);
          if (!current) return null;
          return current.name === undefined
            ? {}
            : { name: sessionContentText(secretScrubber.scrub(current.name)) };
        },
        onClose: (s) => persistCatalogSummary(s),
        // Resumed sessions checkpoint their index/catalog metadata mid-flight
        // too, so a kill during a resumed session still leaves fresh listing
        // state behind.
        onMetadataCheckpoint: (s) => persistCatalogSummary(s),
      },
    );
    // Heal the journal BEFORE announcing success: synthesized results land
    // durably and the stale in_flight boundary gets its closing marker.
    // appendBatch/append swallow flush errors (buffer retained); flush()
    // surfaces them so resume cannot report success against a still-stale file.
    if (synthesizedResults.length > 0) {
      await writer.appendBatch(synthesizedResults);
      await writer.flush();
    }
    if (recoveryPlan.stale) {
      await writer.clearInFlightMarker('recovered');
      await writer.flush();
    }
    emitSessionStoreWrite(events, canonicalId, file, 'resume', 'success', Date.now() - t0);
    return { writer, data: resumedData };
  } catch (err) {
    await handle.close().catch((e) =>
      logWarn('Session handle close failed', {
        event: 'session_store.handle_close_failed',
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    emitSessionStoreError(events, canonicalId, file, 'resume', toErrorMessage(err), true);
    throw err;
  }
}

function appendSyntheticRecoveryMessages(
  messages: Message[],
  pendingEvents: readonly SessionEvent[],
  synthesizedResults: readonly SessionEvent[],
): Message[] {
  if (synthesizedResults.length === 0) return messages;
  const next = [...messages];
  for (const result of synthesizedResults) {
    if (result.type !== 'tool_result') continue;
    const toolUse =
      findToolUseBlock(next, result.id) ?? findToolUseBlockInEvents(pendingEvents, result.id);
    if (!toolUse) continue;
    const resultBlock: ContentBlock = {
      type: 'tool_result',
      tool_use_id: result.id,
      content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
      is_error: result.isError,
    };
    // Parallel calls interrupted together share one assistant turn, so their
    // results belong in the ONE user turn that answers it. Treating each
    // result on its own pushed `user[res a]` after `assistant[a, b]`, then
    // re-emitted `assistant[b]` for the second — a duplicated tool_use id and
    // an unanswered `b` in the original turn, which providers reject outright.
    if (isToolResultTurnAnswering(next, result.id)) {
      const last = next[next.length - 1] as Message;
      // A fresh message, not a push: message objects are shared with the
      // load cache, so mutating one would rewrite the next load's history.
      next[next.length - 1] = {
        ...last,
        content: [...(last.content as ContentBlock[]), resultBlock],
      };
      continue;
    }
    if (!isLastMessageToolUseFor(next, result.id)) {
      next.push({
        role: 'assistant',
        content: [toolUse],
        ts: result.ts,
      });
    }
    next.push({ role: 'user', content: [resultBlock], ts: result.ts });
  }
  return next;
}

/**
 * True when the conversation ends in a tool-result-only user turn that answers
 * the assistant turn holding `id` — the slot a further result for that turn
 * must join.
 */
function isToolResultTurnAnswering(messages: readonly Message[], id: string): boolean {
  const last = messages[messages.length - 1];
  if (
    last?.role !== 'user' ||
    !Array.isArray(last.content) ||
    last.content.length === 0 ||
    !last.content.every((block) => block.type === 'tool_result')
  ) {
    return false;
  }
  if (last.content.some((block) => block.type === 'tool_result' && block.tool_use_id === id)) {
    return false;
  }
  return isLastMessageToolUseFor(messages.slice(0, -1), id);
}

function findToolUseBlock(messages: readonly Message[], id: string): ContentBlock | null {
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id === id) return block;
    }
  }
  return null;
}

function findToolUseBlockInEvents(
  events: readonly SessionEvent[],
  id: string,
): ContentBlock | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === 'llm_response') {
      const block = event.content.find((item) => item.type === 'tool_use' && item.id === id);
      if (block) return block;
    } else if (
      event.type === 'message_appended' &&
      event.message.role === 'assistant' &&
      Array.isArray(event.message.content)
    ) {
      const block = event.message.content.find(
        (item) => item.type === 'tool_use' && item.id === id,
      );
      if (block) return block;
    } else if (event.type === 'tool_use' && event.id === id) {
      return { type: 'tool_use', id: event.id, name: event.name, input: recordInput(event.input) };
    } else if (event.type === 'tool_call_start' && event.id === id) {
      return { type: 'tool_use', id: event.id, name: event.name, input: recordInput(event.input) };
    }
  }
  return null;
}

function recordInput(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function isLastMessageToolUseFor(messages: readonly Message[], id: string): boolean {
  const last = messages[messages.length - 1];
  return (
    last?.role === 'assistant' &&
    Array.isArray(last.content) &&
    last.content.some((block) => block.type === 'tool_use' && block.id === id)
  );
}

async function openSessionForAppend(file: string): Promise<fsp.FileHandle> {
  const handle = await fsp.open(file, 'a+', 0o600);
  try {
    const stat = await handle.stat();
    if (stat.size > 0) {
      const tail = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(tail, 0, 1, stat.size - 1);
      if (bytesRead === 1 && tail[0] !== 0x0a) {
        await handle.appendFile('\n', 'utf8');
      }
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}
