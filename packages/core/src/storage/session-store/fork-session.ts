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
}

export async function forkSession(
  host: SessionForkHost,
  id: string,
  opts: SessionForkOptions = {},
): Promise<ForkedSession> {
  const parent = await host.load(id);
  let boundary = parent.events.length - 1;
  let targetCheckpoint: Extract<SessionEvent, { type: 'checkpoint' }> | undefined;
  if (opts.checkpointPromptIndex !== undefined) {
    boundary = -1;
    for (let i = 0; i < parent.events.length; i++) {
      const event = parent.events[i];
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

  const parentPrefix = parent.events.slice(0, boundary + 1);
  const workspaceCheckpoint = targetCheckpoint?.workspaceCheckpoint;
  const checkpointHash = createHash('sha256')
    .update(parentPrefix.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    .digest('hex');
  const inherited = parentPrefix.filter(inheritsIntoFork);
  const writer = await host.create({
    id: '',
    title: parent.metadata.title,
    model: parent.metadata.model,
    provider: parent.metadata.provider,
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
