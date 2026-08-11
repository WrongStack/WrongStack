import { createHash } from 'node:crypto';
import type {
  ForkedSession,
  SessionData,
  SessionEvent,
  SessionForkOptions,
  SessionMetadata,
  SessionWriter,
} from '../../types/session.js';
import { inheritsIntoFork } from './replay.js';

export interface SessionForkHost {
  load(id: string): Promise<SessionData>;
  create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter>;
  delete(id: string): Promise<void>;
  /**
   * Every persisted event of `id`, exactly as it sits on disk.
   *
   * `load()` is NOT a substitute. Its loader strips the payload out of every
   * superseded `messages_replaced` / `context_snapshot` to bound heap, in
   * place, on the array it returns. Forking from that array copies the
   * emptied snapshots into the child journal, where replay reads them as
   * "the conversation is now zero messages" and the child loses every turn
   * that preceded the newest snapshot inside the fork boundary. A fork is a
   * byte-level inheritance of the parent prefix, so it has to read the bytes.
   */
  readRawEvents(id: string): Promise<SessionEvent[]>;
}

export async function forkSession(
  host: SessionForkHost,
  id: string,
  opts: SessionForkOptions = {},
): Promise<ForkedSession> {
  const parentEvents = await host.readRawEvents(id);
  let boundary = parentEvents.length - 1;
  let targetCheckpoint: Extract<SessionEvent, { type: 'checkpoint' }> | undefined;
  if (opts.checkpointPromptIndex !== undefined) {
    boundary = -1;
    for (let i = 0; i < parentEvents.length; i++) {
      const event = parentEvents[i];
      if (event?.type === 'checkpoint' && event.promptIndex === opts.checkpointPromptIndex) {
        // Prefer the latest matching checkpoint if a legacy/non-truncated
        // journal reused prompt indices after a rewind.
        boundary = i;
        targetCheckpoint = event;
      }
    }
    if (boundary === -1) {
      throw new Error(`Checkpoint ${opts.checkpointPromptIndex} not found in session "${id}"`);
    }
  }

  const parentPrefix = parentEvents.slice(0, boundary + 1);
  const workspaceCheckpoint = targetCheckpoint?.workspaceCheckpoint;
  const checkpointHash = createHash('sha256')
    .update(parentPrefix.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    .digest('hex');
  const inherited = parentPrefix.filter(inheritsIntoFork);
  // Identity comes from the raw stream for the same reason the prefix does:
  // this must describe the parent as persisted, not as reconstructed.
  const start = parentEvents.find(
    (event): event is Extract<SessionEvent, { type: 'session_start' }> =>
      event.type === 'session_start',
  );
  const writer = await host.create({
    id: '',
    title: '',
    model: start?.model,
    provider: start?.provider,
  });

  try {
    await writer.append({
      type: 'session_forked',
      ts: new Date().toISOString(),
      parentSessionId: id,
      parentCheckpointPromptIndex: opts.checkpointPromptIndex,
      parentCheckpointHash: checkpointHash,
      workspace: 'shared-current',
      workspaceCheckpointHash: workspaceCheckpoint?.manifestHash,
    });
    const batchSize = 250;
    for (let offset = 0; offset < inherited.length; offset += batchSize) {
      await writer.appendBatch(inherited.slice(offset, offset + batchSize));
    }
    await writer.flush();
    await writer.close();
    const data = await host.load(writer.id);
    return {
      id: writer.id,
      data,
      parentSessionId: id,
      checkpointPromptIndex: opts.checkpointPromptIndex,
      checkpointHash,
      workspace: 'shared-current',
      workspaceCheckpoint,
    };
  } catch (err) {
    await writer.close().catch(() => undefined);
    await host.delete(writer.id).catch(() => undefined);
    throw err;
  }
}
