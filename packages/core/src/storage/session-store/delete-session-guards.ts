export async function assertSessionCanBeDeleted(
  sessionId: string,
  isSessionInUse?: ((sessionId: string) => Promise<string | null>) | undefined,
): Promise<void> {
  if (!isSessionInUse) return;
  const reason = await isSessionInUse(sessionId);
  if (reason) {
    throw new Error(`Session ${sessionId} is in use (${reason}) and cannot be deleted.`);
  }
}
