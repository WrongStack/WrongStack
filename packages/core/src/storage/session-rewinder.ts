import { expectDefined } from '../utils/expect-defined.js';
import { toErrorMessage } from '../utils/error.js';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { CheckpointInfo, RewindResult, RewindResultExtended, SessionRewinder } from '../types/session-rewinder.js';
import type { SessionEvent, FileSnapshot } from '../types/session.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { SessionError, ERROR_CODES } from '../types/errors.js';
import { sessionScopedPath } from '../utils/session-scoped-path.js';

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
  constructor(private readonly sessionsDir: string, private readonly projectRoot: string) {}

  private sessionFile(sessionId: string): string {
    return sessionScopedPath(this.sessionsDir, sessionId, '.jsonl');
  }

  async listCheckpoints(sessionId: string): Promise<CheckpointInfo[]> {
    const file = this.sessionFile(sessionId);
    const raw = await fsp.readFile(file, 'utf8');
    const events = parseEvents(raw);

    // Build a map of promptIndex -> file snapshot count
    const fileCountMap = new Map<number, number>();
    for (const event of events) {
      if (event.type === 'file_snapshot') {
        const e = event as { promptIndex: number; files: FileSnapshot[] };
        fileCountMap.set(e.promptIndex, (fileCountMap.get(e.promptIndex) ?? 0) + e.files.length);
      }
    }

    const checkpoints: CheckpointInfo[] = [];
    for (const event of events) {
      if (event.type === 'checkpoint') {
        const e = event as { promptIndex: number; promptPreview: string; ts: string };
        checkpoints.push({
          promptIndex: e.promptIndex,
          promptPreview: e.promptPreview,
          ts: e.ts,
          fileCount: fileCountMap.get(e.promptIndex) ?? 0,
        });
      }
    }

    return checkpoints;
  }

  async rewindToCheckpoint(
    sessionId: string,
    checkpointIndex: number,
  ): Promise<RewindResultExtended> {
    const file = this.sessionFile(sessionId);
    const raw = await fsp.readFile(file, 'utf8');
    const events = parseEvents(raw);

    let targetIdx = -1;
    for (let i = 0; i < events.length; i++) {
      const event = expectDefined(events[i]);
      if (event.type === 'checkpoint') {
        const checkpointEvent = event as { promptIndex: number };
        if (checkpointEvent.promptIndex === checkpointIndex) {
          targetIdx = i;
          break;
        }
      }
    }

    if (targetIdx === -1) {
      throw new SessionError({
        message: `Checkpoint ${checkpointIndex} not found`,
        code: ERROR_CODES.SESSION_NOT_FOUND,
        context: { checkpointIndex },
      });
    }

    const snapshotsToRevert: Array<{ promptIndex: number; files: FileSnapshot[] }> = [];
    for (let i = targetIdx + 1; i < events.length; i++) {
      const event = expectDefined(events[i]);
      if (event.type === 'checkpoint') {
        break;
      }
      if (event.type === 'file_snapshot') {
        const snapshotEvent = event as { promptIndex: number; files: FileSnapshot[] };
        if (snapshotEvent.promptIndex >= checkpointIndex) {
          snapshotsToRevert.push({ promptIndex: snapshotEvent.promptIndex, files: snapshotEvent.files });
        }
      }
    }

    const result = await revertSnapshots(snapshotsToRevert, this.projectRoot);
    const removedEvents = events.length - targetIdx - 1;
    return { ...result, toPromptIndex: checkpointIndex, removedEvents };
  }

  async rewindLastN(sessionId: string, n: number): Promise<RewindResultExtended> {
    const file = this.sessionFile(sessionId);
    const raw = await fsp.readFile(file, 'utf8');
    const events = parseEvents(raw);

    const checkpoints: Array<{ promptIndex: number; ts: string }> = [];
    for (const event of events) {
      if (event.type === 'checkpoint') {
        checkpoints.push({ promptIndex: event.promptIndex, ts: event.ts });
      }
    }

    if (checkpoints.length === 0) {
      return { revertedFiles: [], errors: [], toPromptIndex: 0, removedEvents: 0 };
    }

    checkpoints.sort((a, b) => b.promptIndex - a.promptIndex);
    const targetIndex = checkpoints[n]?.promptIndex ?? 0;

    const snapshotsToRevert: Array<{ promptIndex: number; files: FileSnapshot[] }> = [];
    let shouldRevert = false;

    for (const event of events) {
      if (event.type === 'checkpoint' && event.promptIndex === targetIndex) {
        shouldRevert = true;
        continue;
      }
      if (shouldRevert && event.type === 'file_snapshot') {
        snapshotsToRevert.push({ promptIndex: event.promptIndex, files: event.files });
      }
    }

    const result = await revertSnapshots(snapshotsToRevert.reverse(), this.projectRoot);
    return { ...result, toPromptIndex: targetIndex, removedEvents: snapshotsToRevert.length };
  }

  async rewindToStart(sessionId: string): Promise<RewindResultExtended> {
    const file = this.sessionFile(sessionId);
    const raw = await fsp.readFile(file, 'utf8');
    const events = parseEvents(raw);

    const allSnapshots: Array<{ promptIndex: number; files: FileSnapshot[] }> = [];
    for (const event of events) {
      if (event.type === 'file_snapshot') {
        allSnapshots.push({ promptIndex: event.promptIndex, files: event.files });
      }
    }

    if (allSnapshots.length === 0) {
      return { revertedFiles: [], errors: [], toPromptIndex: 0, removedEvents: 0 };
    }

    const result = await revertSnapshots(allSnapshots.reverse(), this.projectRoot);
    return { ...result, toPromptIndex: 0, removedEvents: allSnapshots.length };
  }
}

function parseEvents(raw: string): SessionEvent[] {
  const lines = raw.split('\n').filter((l) => l.trim());
  const events: SessionEvent[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { type?: unknown | undefined }).type === 'string' &&
        typeof (parsed as { ts?: unknown | undefined }).ts === 'string'
      ) {
        events.push(parsed as SessionEvent);
      }
    } catch {
      // skip malformed
    }
  }

  return events;
}

async function revertSnapshots(
  snapshots: Array<{ promptIndex: number; files: FileSnapshot[] }>,
  projectRoot: string,
): Promise<RewindResult> {
  const revertedFiles: string[] = [];
  const errors: string[] = [];

  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      try {
        // Guard: ensure the target path resolves inside the project root.
        // Without this, a maliciously recorded path (e.g., via path traversal
        // in a tool call that wasn't caught) could cause rewind to write
        // to arbitrary locations.
        const absPath = path.resolve(file.path);
        const root = path.resolve(projectRoot);
        const rel = path.relative(root, absPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
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

  return { revertedFiles, errors };
}
