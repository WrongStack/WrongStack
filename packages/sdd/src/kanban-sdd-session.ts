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
      await writeChain;
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
      await writeChain;
      await deleteKanbanWorkflowState(projectRoot, SDD_SESSION_WORKFLOW_ID);
      revision = 0;
      if (legacySessionPath) await fsp.unlink(legacySessionPath).catch(() => undefined);
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
