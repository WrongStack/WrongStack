import { readActiveSessionId } from './prune-helpers.js';

export async function assertSessionCanBeDeleted(
  storeDir: string,
  sessionId: string,
  isSessionInUse?: ((sessionId: string) => Promise<string | null>) | undefined,
): Promise<void> {
  const activeId = await readActiveSessionId(storeDir);
  if (activeId && sessionId === activeId) {
    throw new Error(
      `Session ${sessionId} is currently active in this project and cannot be deleted. Resume or start another session first.`,
    );
  }

  if (!isSessionInUse) return;
  const reason = await isSessionInUse(sessionId);
  if (reason) {
    throw new Error(`Session ${sessionId} is in use (${reason}) and cannot be deleted.`);
  }
}
