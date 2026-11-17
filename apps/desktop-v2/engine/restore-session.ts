import { randomUUID } from 'node:crypto';

/** How long each step of a recorded conversation's restore took, from the restore's start. */
export interface RestoreTiming {
  sessionId: string;
  ok: boolean;
  /** Milliseconds since this engine process started, when the restore began. */
  startedAfterMs: number;
  /** Milliseconds from the restore's start: connected, each server stage, the replay, the answer. */
  marks: Record<string, number>;
}
/** One JSON line in the engine log, which the desktop keeps per conversation. */
function logTiming(timing: RestoreTiming): void {
  process.stdout.write(
    `${JSON.stringify({ level: 'info', event: 'desktop.restore.timing', ...timing })}\n`,
  );
}

/**
 * The recorded conversation the server replayed for a requested id. A bare `sess_…` id names the
 * conversation the server stores under its day folder, so it answers with the dated `day/sess_…` id.
 */
function replayedFor(requested: string, replayed: string): boolean {
  return replayed === requested || (!requested.includes('/') && replayed.endsWith(`/${requested}`));
}

/**
 * Private boot connection; never runs a model turn or exposes transport credentials. Resolves with
 * the id the server replayed, the dated one for a bare request.
 */
export async function restoreEngineSession(
  port: number,
  token: string,
  id: string,
  report: (timing: RestoreTiming) => void = logTiming,
): Promise<string> {
  const targetId = typeof id === 'string' ? id.trim() : '';
  const targetToken = typeof token === 'string' ? token.trim() : '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !targetToken || !targetId) {
    throw Error('Recorded conversation startup requires a valid port, token, and session id.');
  }
  const started = performance.now();
  const marks: Record<string, number> = {};
  // The first time each step is seen; the server repeats a stage while it reports progress.
  const mark = (name: string) => {
    if (!(name in marks)) marks[name] = Math.round(performance.now() - started);
  };
  const timing = (ok: boolean): RestoreTiming => ({
    sessionId: targetId,
    ok,
    startedAfterMs: Math.round(started),
    marks,
  });
  let replayedId = targetId;
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
      try {
        report(timing(!error));
      } catch {
        // A timing line is diagnostics; it never decides the restore.
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(Error('Recorded conversation startup timed out.')),
      60000,
    );
    socket.onopen = () => {
      mark('connected');
      socket.send(JSON.stringify({ type: 'session.resume', payload: { id: targetId, requestId } }));
    };
    socket.onerror = () => finish(Error('Recorded conversation startup connection failed.'));
    socket.onclose = () => finish(Error('Recorded conversation startup connection closed.'));
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'session.resume_progress' && typeof frame.payload?.stage === 'string')
          mark(frame.payload.stage);
        if (frame.type === 'session.start') mark('session.start');
        if (
          frame.type === 'session.start' &&
          typeof frame.payload?.sessionId === 'string' &&
          replayedFor(targetId, frame.payload.sessionId.trim()) &&
          frame.payload?.reset === true
        ) {
          replayed = true;
          replayedId = frame.payload.sessionId.trim();
        }
        // Older shared resume handlers omit requestId. This private socket has
        // exactly one request; it is never shared with renderer operations.
        if (
          frame.type === 'key.operation_result' &&
          (frame.payload?.requestId === undefined || frame.payload.requestId === requestId)
        ) {
          mark('answered');
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
  return replayedId;
}
