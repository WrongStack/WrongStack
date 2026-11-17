import * as fsp from 'node:fs/promises';
import {
  deleteKanbanWorkflowState,
  kanbanWorkflowId,
  readKanbanWorkflowState,
  writeKanbanWorkflowState,
} from '@wrongstack/kanban';
import {
  type AISpecSession,
  type AISpecSessionPersistence,
  isAISpecSession,
} from './sdd-session-types.js';

const SDD_SESSION_WORKFLOW_ID = kanbanWorkflowId('sdd', 'session');

/**
 * Project-scoped SDD interview persistence. The Kanban daemon is authoritative;
 * an old session JSON file is imported and removed on the first successful read.
 */
export function createKanbanSddSessionPersistence(
  projectRoot: string,
  legacySessionPath?: string,
): AISpecSessionPersistence {
  let revision: number | undefined;
  let writeChain: Promise<void> = Promise.resolve();

  return {
    async load(): Promise<AISpecSession | null> {
      // Loading can import legacy state and updates the tracked revision, so it
      // must reserve its place alongside saves and deletes before yielding.
      const pending = writeChain.then(async () => {
        const state = await readKanbanWorkflowState(projectRoot, SDD_SESSION_WORKFLOW_ID);
        if (state) {
          revision = state.revision;
          return isAISpecSession(state.value) ? structuredClone(state.value) : null;
        }

        const legacy = await readLegacySession(legacySessionPath);
        if (!legacy) {
          revision = 0;
          return null;
        }

        const imported = await writeKanbanWorkflowState(
          projectRoot,
          SDD_SESSION_WORKFLOW_ID,
          legacy,
          0,
        );
        revision = imported.revision;
        if (legacySessionPath) await fsp.unlink(legacySessionPath).catch(() => undefined);
        return structuredClone(legacy);
      });
      writeChain = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },

    async save(session: AISpecSession): Promise<void> {
      const pending = writeChain.then(async () => {
        if (revision === undefined) {
          const current = await readKanbanWorkflowState(projectRoot, SDD_SESSION_WORKFLOW_ID);
          revision = current?.revision ?? 0;
        }
        const saved = await writeKanbanWorkflowState(
          projectRoot,
          SDD_SESSION_WORKFLOW_ID,
          session,
          revision,
        );
        revision = saved.revision;
      });
      writeChain = pending.catch(() => undefined);
      await pending;
    },

    async delete(): Promise<void> {
      const pending = writeChain.then(async () => {
        await deleteKanbanWorkflowState(projectRoot, SDD_SESSION_WORKFLOW_ID);
        revision = 0;
        if (legacySessionPath) await fsp.unlink(legacySessionPath).catch(() => undefined);
      });
      // Make deletion part of the same mutation chain as save(). A save that
      // starts after delete() must run after the state has been removed, not
      // race the delete and get erased by whichever transport call finishes last.
      writeChain = pending.catch(() => undefined);
      await pending;
    },
  };
}

async function readLegacySession(sessionPath?: string): Promise<AISpecSession | null> {
  if (!sessionPath) return null;
  try {
    const value = JSON.parse(await fsp.readFile(sessionPath, 'utf8')) as unknown;
    return isAISpecSession(value) ? value : null;
  } catch {
    return null;
  }
}
