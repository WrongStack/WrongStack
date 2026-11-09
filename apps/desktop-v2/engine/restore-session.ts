import { randomUUID } from 'node:crypto';

/** Private boot connection; never runs a model turn or exposes transport credentials. */
export async function restoreEngineSession(port: number, token: string, id: string): Promise<void> {
  const targetId = typeof id === 'string' ? id.trim() : '';
  const targetToken = typeof token === 'string' ? token.trim() : '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !targetToken || !targetId) {
    throw Error('Recorded conversation startup requires a valid port, token, and session id.');
  }
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${encodeURIComponent(targetToken)}`,
    );
    const requestId = randomUUID();
    let replayed = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(Error('Recorded conversation startup timed out.')),
      60000,
    );
    socket.onopen = () =>
      socket.send(JSON.stringify({ type: 'session.resume', payload: { id: targetId, requestId } }));
    socket.onerror = () => finish(Error('Recorded conversation startup connection failed.'));
    socket.onclose = () => finish(Error('Recorded conversation startup connection closed.'));
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (
          frame.type === 'session.start' &&
          typeof frame.payload?.sessionId === 'string' &&
          frame.payload.sessionId.trim() === targetId &&
          frame.payload?.reset === true
        )
          replayed = true;
        // Older shared resume handlers omit requestId. This private socket has
        // exactly one request; it is never shared with renderer operations.
        if (
          frame.type === 'key.operation_result' &&
          (frame.payload?.requestId === undefined || frame.payload.requestId === requestId)
        ) {
          if (frame.payload?.success !== true)
            finish(Error(frame.payload?.message || 'Could not reopen the recorded conversation.'));
          else if (replayed) finish();
          else finish(Error('Recorded conversation replay was not verified.'));
        }
        if (frame.type === 'error')
          finish(Error(frame.payload?.message || 'Recorded conversation startup failed.'));
      } catch (error) {
        finish(error instanceof Error ? error : Error(String(error)));
      }
    };
  });
}
