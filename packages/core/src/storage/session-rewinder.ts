import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { ERROR_CODES, SessionError } from '@wrongstack/contracts/types/errors';
import type { FileSnapshot, SessionEvent } from '@wrongstack/contracts/types/session';
import type {
  CheckpointInfo,
  RewindResult,
  RewindResultExtended,
  SessionRewinder,
} from '@wrongstack/contracts/types/session-rewinder';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import { sessionScopedPath } from '../utils/session-scoped-path.js';

/** Journal events that record the session tree itself rather than a branch's turn. */
const BRANCH_STRUCTURE_EVENTS: ReadonlySet<string> = new Set([
  'branch_created',
  'branch_switched',
  'branch_folded',
  'branch_status_changed',
]);

/** The text of a recorded prompt; image and document blocks carry none. */
function userInputText(content: Extract<SessionEvent, { type: 'user_input' }>['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

/** Whether a recorded prompt carried blocks its text leaves out. */
function userInputHasAttachments(
  content: Extract<SessionEvent, { type: 'user_input' }>['content'],
): boolean {
  return typeof content !== 'string' && content.some((block) => block.type !== 'text');
}

export interface SessionRewinderOptions {
  sessionsDir: string;
  /** The project root directory; used to validate rewind targets stay inside it. */
  projectRoot: string;
}

/**
 * Rewind engine that reads session JSONL files and reverts file system
 * changes to any previous checkpoint.
 */
export class DefaultSessionRewinder implements SessionRewinder {
  constructor(
    private readonly sessionsDir: string,
    private readonly projectRoot: string,
  ) {}

  private sessionFile(sessionId: string): string {
    return sessionScopedPath(this.sessionsDir, sessionId, '.jsonl');
  }

  private async *readEvents(file: string): AsyncGenerator<SessionEvent> {
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
            typeof (parsed as { type?: unknown }).type === 'string' &&
            typeof (parsed as { ts?: unknown }).ts === 'string'
          ) {
            yield parsed as SessionEvent;
          }
        } catch {
          // Skip malformed lines without materializing the complete file.
        }
      }
    } finally {
      lines.close();
      stream.close();
    }
  }

  async listCheckpoints(sessionId: string): Promise<CheckpointInfo[]> {
    const file = this.sessionFile(sessionId);

    // Build a map of promptIndex -> file snapshot count
    const fileCountMap = new Map<number, number>();
    const checkpointMap = new Map<number, Omit<CheckpointInfo, 'fileCount'>>();
    for await (const event of this.readEvents(file)) {
      if (event.type === 'rewound') {
        const to = (event as { toPromptIndex: number }).toPromptIndex;
        for (const key of checkpointMap.keys()) {
          if (key > to) checkpointMap.delete(key);
        }
        for (const key of fileCountMap.keys()) {
          if (key >= to) fileCountMap.delete(key);
        }
      }
      if (event.type === 'file_snapshot') {
        const e = event as { promptIndex: number; files: FileSnapshot[] };
        fileCountMap.set(e.promptIndex, (fileCountMap.get(e.promptIndex) ?? 0) + e.files.length);
      }
      if (event.type === 'checkpoint') {
        const e = event as { promptIndex: number; promptPreview: string; ts: string };
        checkpointMap.set(e.promptIndex, {
          promptIndex: e.promptIndex,
          promptPreview: e.promptPreview,
          ts: e.ts,
        });
      }
    }

    return [...checkpointMap.values()].map((checkpoint) => ({
      ...checkpoint,
      fileCount: fileCountMap.get(checkpoint.promptIndex) ?? 0,
    }));
  }

  /**
   * The session-tree branch the journal leaves active: the target of its last
   * `branch_switched`, `main` for an unbranched journal.
   */
  private async activeBranchOf(file: string): Promise<string> {
    let active = 'main';
    for await (const event of this.readEvents(file)) {
      if (event.type === 'branch_switched' && event.toBranchId) active = event.toBranchId;
    }
    return active;
  }

  async rewindToCheckpoint(
    sessionId: string,
    checkpointIndex: number,
  ): Promise<RewindResultExtended> {
    const file = this.sessionFile(sessionId);
    // In a branched journal only the active branch's own checkpoints are cut
    // points (prompt indices restart per lineage), and the writer refuses a
    // cut that would also remove other branches' events. Apply the same rule
    // here, before any file is reverted, so a refused rewind changes nothing.
    const branchId = await this.activeBranchOf(file);
    let foreignBranchEvents = 0;
    let foundTarget = false;
    let removedEvents = 0;
    // Only the rewound branch's own input: with interleaved branches the
    // journal line just before this branch's checkpoint can be another
    // branch's prompt, which must never come back into this branch's composer.
    let lastInput: { text: string; hasAttachments: boolean } | undefined;
    let promptText: string | undefined;
    let promptHasAttachments = false;
    const snapshotsToRevert: Array<{ promptIndex: number; files: FileSnapshot[] }> = [];
    for await (const event of this.readEvents(file)) {
      if (event.type === 'user_input' && (event.branchId ?? 'main') === branchId) {
        lastInput = {
          text: userInputText(event.content),
          hasAttachments: userInputHasAttachments(event.content),
        };
      }
      if (event.type === 'checkpoint' && (event.branchId ?? 'main') === branchId) {
        const checkpointEvent = event as { promptIndex: number };
        if (checkpointEvent.promptIndex === checkpointIndex) {
          // After an earlier rewind to this index the journal holds it twice
          // (the kept one and the next prompt's). The cut is at the first,
          // which takes the later prompt back too, so that later prompt is
          // the one handed back.
          promptText = lastInput?.text;
          promptHasAttachments = lastInput?.hasAttachments ?? false;
          if (!foundTarget) {
            foundTarget = true;
            continue;
          }
        }
      }
      if (!foundTarget) continue;
      removedEvents++;
      if (BRANCH_STRUCTURE_EVENTS.has(event.type) || (event.branchId ?? 'main') !== branchId) {
        foreignBranchEvents++;
      }
      if (event.type === 'file_snapshot' && event.promptIndex >= checkpointIndex) {
        snapshotsToRevert.push({ promptIndex: event.promptIndex, files: event.files });
      }
    }

    if (!foundTarget) {
      throw new SessionError({
        message: `Checkpoint ${checkpointIndex} not found`,
        code: ERROR_CODES.SESSION_NOT_FOUND,
        context: { checkpointIndex },
      });
    }
    if (foreignBranchEvents > 0) {
      throw new SessionError({
        message:
          `Cannot rewind to checkpoint ${checkpointIndex}: the session journal records ` +
          `${foreignBranchEvents} event(s) from other session branches after it, and a rewind ` +
          'would delete them. Fork from that prompt instead (/tree branch <name> --at <prompt>).',
        code: ERROR_CODES.SESSION_WRITE_FAILED,
        context: { checkpointIndex, branchId, foreignBranchEvents },
      });
    }

    // Collect EVERY snapshot from the target checkpoint onwards. The writer
    // emits checkpoint(N) first and then labels that prompt's snapshots with
    // promptIndex N (file-session-writer.ts:652-659, :194-199), so later
    // prompts contribute further checkpoint/snapshot pairs. Stopping at the
    // next checkpoint would revert only the target prompt's files while the
    // caller truncates the journal all the way back, leaving the working tree
    // and the conversation in different eras.
    const result = await revertSnapshots(snapshotsToRevert, this.projectRoot);
    return {
      ...result,
      toPromptIndex: checkpointIndex,
      removedEvents,
      ...(promptText !== undefined ? { promptText, promptHasAttachments } : {}),
    };
  }

  /**
   * The prompt checkpoint `checkpointIndex` was taken for: the `user_input`
   * the agent recorded just before writing it, for the newest checkpoint with
   * that index (a rewind leaves an older one behind). Undefined when the
   * checkpoint or its input is not in the journal.
   *
   * In a branched journal the checkpoint and its input are the active
   * branch's own (the branch `rewindToCheckpoint` would cut): prompt indices
   * restart per lineage, and an interleaved branch's prompt is never handed
   * back for this branch's checkpoint.
   */
  async promptAt(sessionId: string, checkpointIndex: number): Promise<string | undefined> {
    // One pass, per branch, resolved against the branch the journal leaves active.
    let active = 'main';
    const lastInput = new Map<string, string>();
    const promptText = new Map<string, string | undefined>();
    for await (const event of this.readEvents(this.sessionFile(sessionId))) {
      const branch = event.branchId ?? 'main';
      if (event.type === 'branch_switched' && event.toBranchId) active = event.toBranchId;
      else if (event.type === 'user_input') lastInput.set(branch, userInputText(event.content));
      else if (event.type === 'checkpoint' && event.promptIndex === checkpointIndex) {
        promptText.set(branch, lastInput.get(branch));
      }
    }
    return promptText.get(active);
  }

  async rewindLastN(sessionId: string, n: number): Promise<RewindResultExtended> {
    const file = this.sessionFile(sessionId);
    // Same branched-journal rule as rewindToCheckpoint: only the active
    // branch's own checkpoints are cut points (prompt indices restart per
    // lineage, so another branch's checkpoint shares the index), and a rewind
    // the writer would refuse must revert nothing — the CLI pairs this method
    // with truncateToCheckpoint(result.toPromptIndex) under --resume.
    const branchId = await this.activeBranchOf(file);

    const checkpointMap = new Map<number, { promptIndex: number; ts: string }>();
    for await (const event of this.readEvents(file)) {
      if (event.type === 'rewound' && (event.branchId ?? 'main') === branchId) {
        const to = (event as { toPromptIndex: number }).toPromptIndex;
        for (const key of checkpointMap.keys()) {
          if (key > to) checkpointMap.delete(key);
        }
      }
      if (event.type === 'checkpoint' && (event.branchId ?? 'main') === branchId) {
        checkpointMap.set(event.promptIndex, { promptIndex: event.promptIndex, ts: event.ts });
      }
    }
    const checkpoints = [...checkpointMap.values()];

    if (checkpoints.length === 0 || n <= 0) {
      return { revertedFiles: [], errors: [], toPromptIndex: 0, removedEvents: 0 };
    }

    // Undoing the last N prompts means rewinding TO the Nth-newest checkpoint,
    // because rewinding to checkpoint K reverts prompt K and everything after
    // it. So n=1 targets the newest checkpoint — index n-1, not n. Falling back
    // to the earliest checkpoint when n exceeds the checkpoint count rewinds
    // the whole session even when prompt indices start above 0.
    checkpoints.sort((a, b) => b.promptIndex - a.promptIndex);
    const targetIndex =
      checkpoints[n - 1]?.promptIndex ?? checkpoints[checkpoints.length - 1]!.promptIndex;

    const snapshotsToRevert: Array<{ promptIndex: number; files: FileSnapshot[] }> = [];
    let shouldRevert = false;
    // Counted the same way `rewindToCheckpoint` counts it — every event past
    // the target checkpoint. Reporting the file-snapshot count here instead
    // made the same rewind report two different numbers depending on which
    // entry point the caller used.
    let removedEvents = 0;
    let foreignBranchEvents = 0;

    for await (const event of this.readEvents(file)) {
      if (
        event.type === 'checkpoint' &&
        event.promptIndex === targetIndex &&
        (event.branchId ?? 'main') === branchId
      ) {
        shouldRevert = true;
        continue;
      }
      if (!shouldRevert) continue;
      removedEvents++;
      if (BRANCH_STRUCTURE_EVENTS.has(event.type) || (event.branchId ?? 'main') !== branchId) {
        foreignBranchEvents++;
      }
      if (event.type === 'file_snapshot') {
        snapshotsToRevert.push({ promptIndex: event.promptIndex, files: event.files });
      }
    }

    if (foreignBranchEvents > 0) {
      throw new SessionError({
        message:
          `Cannot rewind the last ${n} prompt(s) to checkpoint ${targetIndex}: the session journal ` +
          `records ${foreignBranchEvents} event(s) from other session branches after it, and a rewind ` +
          'would delete them. Fork from that prompt instead (/tree branch <name> --at <prompt>).',
        code: ERROR_CODES.SESSION_WRITE_FAILED,
        context: { checkpointIndex: targetIndex, branchId, foreignBranchEvents, lastN: n },
      });
    }

    const result = await revertSnapshots(snapshotsToRevert, this.projectRoot);
    return { ...result, toPromptIndex: targetIndex, removedEvents };
  }

  async rewindToStart(sessionId: string): Promise<RewindResultExtended> {
    const file = this.sessionFile(sessionId);
    // Same rule as the checkpoint rewinds: a rewind to the start of a branched
    // journal would revert files other branches still claim and cut their
    // events (the writer refuses that cut), so refuse it before any file is
    // touched. Every branch shares the prefix before its fork point, so on a
    // branched journal no branch can be rewound to the start on its own.
    const branchId = await this.activeBranchOf(file);
    let foreignBranchEvents = 0;
    const allSnapshots: Array<{ promptIndex: number; files: FileSnapshot[] }> = [];
    for await (const event of this.readEvents(file)) {
      if (BRANCH_STRUCTURE_EVENTS.has(event.type) || (event.branchId ?? 'main') !== branchId) {
        foreignBranchEvents++;
      }
      if (event.type === 'file_snapshot') {
        allSnapshots.push({ promptIndex: event.promptIndex, files: event.files });
      }
    }

    if (foreignBranchEvents > 0) {
      throw new SessionError({
        message:
          'Cannot rewind to the session start: the session journal records ' +
          `${foreignBranchEvents} event(s) from other session branches, and a rewind would revert ` +
          'and delete them. Rewind to a checkpoint of this branch, or fork from a prompt instead ' +
          '(/tree branch <name> --at <prompt>).',
        code: ERROR_CODES.SESSION_WRITE_FAILED,
        context: { branchId, foreignBranchEvents },
      });
    }

    if (allSnapshots.length === 0) {
      return { revertedFiles: [], errors: [], toPromptIndex: 0, removedEvents: 0 };
    }

    const result = await revertSnapshots(allSnapshots, this.projectRoot);
    return { ...result, toPromptIndex: 0, removedEvents: allSnapshots.length };
  }
}

async function revertSnapshots(
  snapshots: Array<{ promptIndex: number; files: FileSnapshot[] }>,
  projectRoot: string,
): Promise<RewindResult> {
  const revertedFiles: string[] = [];
  const errors: string[] = [];

  // Undo is the inverse of execution order. Reverse both event order and the
  // per-event file list so repeated edits of the same path restore the oldest
  // `before` content rather than stopping at an intermediate version.
  for (const snapshot of [...snapshots].reverse()) {
    for (const file of [...snapshot.files].reverse()) {
      try {
        // Guard: ensure the target path resolves inside the project root.
        // Without this, a maliciously recorded path (e.g., via path traversal
        // in a tool call that wasn't caught) could cause rewind to write
        // to arbitrary locations.
        const absPath = path.resolve(file.path);
        const root = path.resolve(projectRoot);
        const rel = path.relative(root, absPath);
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
          errors.push(`${file.path}: path resolves outside project root — skipping`);
          continue;
        }

        if (file.action === 'deleted') {
          // File was deleted — restore it from before
          if (file.before !== null) {
            // atomicWrite: torn restore would leave the user with a frankenstein file.
            await atomicWrite(file.path, file.before, { mode: 0o644 });
            revertedFiles.push(file.path);
          }
        } else if (file.action === 'created') {
          // File was created — delete it
          await fsp.unlink(file.path);
          revertedFiles.push(file.path);
        } else if (file.action === 'modified') {
          // File was modified — restore before content
          if (file.before !== null) {
            // atomicWrite: torn restore would leave the user with a frankenstein file.
            await atomicWrite(file.path, file.before, { mode: 0o644 });
            revertedFiles.push(file.path);
          }
        }
      } catch (err) {
        errors.push(`${file.path}: ${toErrorMessage(err)}`);
      }
    }
  }

  return { revertedFiles: Array.from(new Set(revertedFiles)), errors };
}

/**
 * Re-apply rewound file changes (for `/redo`), in execution order. All or
 * nothing: every touched path must still hold what the rewind left there
 * (its first recorded `before`, absent for a created file), and every change
 * must be reproducible (content recorded). Otherwise nothing is written and
 * the offending paths come back as conflicts, so a redo never clobbers edits
 * made after the rewind.
 */
export async function reapplySnapshots(
  snapshots: ReadonlyArray<{ files: readonly FileSnapshot[] }>,
  projectRoot: string,
): Promise<{ reappliedFiles: string[]; conflicts: string[] }> {
  const expected = new Map<string, string | null>();
  const final = new Map<string, string | null>();
  const conflicts: string[] = [];
  const root = path.resolve(projectRoot);
  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      const abs = path.resolve(file.path);
      const rel = path.relative(root, abs);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        conflicts.push(`${file.path}: outside the project root`);
        continue;
      }
      if (!expected.has(abs)) expected.set(abs, file.action === 'created' ? null : file.before);
      if (file.action !== 'deleted' && file.after === null) {
        conflicts.push(`${file.path}: content was not recorded`);
        continue;
      }
      final.set(abs, file.action === 'deleted' ? null : file.after);
    }
  }
  for (const [abs, before] of expected) {
    const current = await fsp.readFile(abs, 'utf8').catch(() => null);
    if (current !== before) conflicts.push(`${abs}: changed since the rewind`);
  }
  if (conflicts.length > 0) return { reappliedFiles: [], conflicts };

  const reappliedFiles: string[] = [];
  for (const [abs, content] of final) {
    if (content === null) await fsp.rm(abs, { force: true });
    else {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await atomicWrite(abs, content, { mode: 0o644 });
    }
    reappliedFiles.push(abs);
  }
  return { reappliedFiles, conflicts: [] };
}
