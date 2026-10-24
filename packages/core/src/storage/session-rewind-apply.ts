import type { Message } from '@wrongstack/contracts/types/messages';
import type { SessionEvent, SessionWriter } from '@wrongstack/contracts/types/session';
import { restoreSessionPermissionOverrides } from '../security/session-permission-overrides.js';
import { reapplySnapshots } from './session-rewinder.js';
import { DefaultSessionStore } from './session-store.js';

/**
 * The slice of ConversationState this module needs. Kept structural so callers
 * can pass `ctx.state` without this module depending on the core layer.
 */
export interface RewindableConversation {
  replaceMessages(messages: Message[]): void;
}

export interface ApplyRewindOptions {
  /** The live writer for the session being rewound. */
  session: SessionWriter;
  /** The live conversation to cut back. */
  state: RewindableConversation;
  /** Directory holding the session JSONL files. */
  sessionsDir: string;
  /** Checkpoint promptIndex to rewind to. */
  promptIndex: number;
  /**
   * Files the SessionRewinder just reverted, recorded on the `rewound` event.
   * Only this caller knows them: the file_snapshot events that prove what
   * changed are truncated away by this very call.
   */
  revertedFiles?: readonly string[] | undefined;
  /**
   * The conversation's `ctx.meta`. Session settings the journal carries
   * (`/permissions allow|deny`) are re-read from what the rewind kept, so the
   * live rules match what a resume would restore.
   */
  meta?: Record<string, unknown> | undefined;
  /** Rebuild session-scoped derived state after the durable history changes. */
  onMessagesReplaced?: ((messages: readonly Message[]) => void) | undefined;
}

export interface ApplyRewindResult {
  /** Events dropped from the JSONL by the truncation. */
  removedEvents: number;
  /** Message count the live conversation was cut back to. */
  messageCount: number;
  /** The conversation as it now stands, for a surface to redraw its transcript from. */
  conversation: RewoundConversation;
}

/** The reloaded journal after a rewind or a redo: its messages and events. */
export interface RewoundConversation {
  messages: Message[];
  events: SessionEvent[];
}

/**
 * Truncate the session JSONL to a checkpoint AND cut the live conversation
 * back to match.
 *
 * Truncating the log alone is not a rewind: the model keeps the rewound turns
 * in its working set, so the next prompt is answered against a history the log
 * no longer contains. Worse, the conversation journal records `message_updated`
 * by absolute index, so once the log is shorter than the live array those
 * updates fail the `index < messages.length` guard on reload and are dropped as
 * damage — the file diverges from the session permanently.
 *
 * The truncated log is the source of truth for what survives, so this reloads
 * it and replays the result into the live state rather than trying to compute
 * the cut point twice. `replaceMessages` emits `messages_replaced`, which
 * re-anchors the journal at the new length and makes the cut explicit to any
 * later reader.
 *
 * The caller is responsible for reverting files (see `SessionRewinder`); this
 * only reconciles the log with the live conversation.
 */
export async function applyRewindToConversation(
  opts: ApplyRewindOptions,
): Promise<ApplyRewindResult> {
  const { session, state, sessionsDir, promptIndex, revertedFiles } = opts;
  const removedEvents = await session.truncateToCheckpoint(promptIndex, revertedFiles ?? []);

  // A fresh store avoids serving a pre-truncation cache entry; load() keys its
  // cache on mtime+size, both of which the rewrite changes, but a caller's
  // long-lived store may also hold a reference to the old data object.
  const store = new DefaultSessionStore({ dir: sessionsDir });
  const data = await store.load(session.id);
  state.replaceMessages(data.messages);
  opts.onMessagesReplaced?.(data.messages);
  restoreSessionPermissionOverrides(opts.meta, data);

  return {
    removedEvents,
    messageCount: data.messages.length,
    conversation: { messages: data.messages, events: data.events },
  };
}

export interface RedoRewindResult {
  /** Checkpoint the undone rewind had gone back to. */
  toPromptIndex: number;
  restoredEvents: number;
  reappliedFiles: string[];
  /** Non-empty: nothing was changed (files edited since the rewind, …). */
  conflicts: string[];
  messageCount: number;
  /** Checkpoints the redo brought back, for timeline UIs. */
  checkpoints: Array<{ promptIndex: number; promptPreview: string; ts: string; fileCount: number }>;
  /** The conversation after the redo; absent when nothing was changed. */
  conversation?: RewoundConversation | undefined;
}

/**
 * Undo the newest `/rewind`: re-apply its file changes, put the cut journal
 * back, and reload the live conversation from it. Returns null when there is
 * nothing to redo (no rewind, or a prompt was sent since). With conflicts,
 * nothing is changed.
 */
export async function redoLastRewind(opts: {
  session: SessionWriter;
  state: RewindableConversation;
  sessionsDir: string;
  projectRoot: string;
  /** See `ApplyRewindOptions.meta`. */
  meta?: Record<string, unknown> | undefined;
  /** See `ApplyRewindOptions.onMessagesReplaced`. */
  onMessagesReplaced?: ((messages: readonly Message[]) => void) | undefined;
}): Promise<RedoRewindResult | null> {
  const { session, state, sessionsDir, projectRoot } = opts;
  if (!session.peekRedo || !session.restoreRedo) return null;
  const peek = await session.peekRedo();
  if (!peek) return null;
  const snapshots = peek.events.filter(
    (e): e is Extract<SessionEvent, { type: 'file_snapshot' }> => e.type === 'file_snapshot',
  );
  const files = await reapplySnapshots(snapshots, projectRoot);
  if (files.conflicts.length > 0) {
    return {
      toPromptIndex: peek.toPromptIndex,
      restoredEvents: 0,
      reappliedFiles: [],
      conflicts: files.conflicts,
      messageCount: 0,
      checkpoints: [],
    };
  }
  const fileCounts = new Map<number, number>();
  for (const s of snapshots) {
    fileCounts.set(s.promptIndex, (fileCounts.get(s.promptIndex) ?? 0) + s.files.length);
  }
  const checkpoints = peek.events.flatMap((e) =>
    e.type === 'checkpoint'
      ? [
          {
            promptIndex: e.promptIndex,
            promptPreview: e.promptPreview,
            ts: e.ts,
            fileCount: fileCounts.get(e.promptIndex) ?? 0,
          },
        ]
      : [],
  );
  const restoredEvents = (await session.restoreRedo()) ?? 0;
  const data = await new DefaultSessionStore({ dir: sessionsDir }).load(session.id);
  state.replaceMessages(data.messages);
  opts.onMessagesReplaced?.(data.messages);
  restoreSessionPermissionOverrides(opts.meta, data);
  return {
    toPromptIndex: peek.toPromptIndex,
    restoredEvents,
    reappliedFiles: files.reappliedFiles,
    conflicts: [],
    messageCount: data.messages.length,
    checkpoints,
    conversation: { messages: data.messages, events: data.events },
  };
}
