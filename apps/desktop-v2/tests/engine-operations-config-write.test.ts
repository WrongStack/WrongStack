/**
 * #448: "The engine did not acknowledge this request" on "Use model". The
 * engine waits up to 15 s for the profile config lock before it answers a
 * `model.switch`, and the desktop gave up at 15 s, so a held lock surfaced as
 * a missing answer instead of the engine's own error, which came 10 ms later.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { EngineOperations } from '../src/engine-operations.js';

afterEach(() => {
  vi.useRealTimers();
});

/** The engine's lock wait (persistence withFileLock default) plus its own reply time. */
const ENGINE_LOCK_WAIT_MS = 15_000;

it('waits past the engine config lock for a model switch answer', async () => {
  vi.useFakeTimers();
  let requestId = '';
  const ops = new EngineOperations(async (_type, payload) => {
    requestId = String(payload?.['requestId']);
  });

  const reply = ops.request('model.switch', { provider: 'p', model: 'm' }, ['model.switch_result']);
  const settled = reply.then(
    (value) => ({ value }),
    (error: Error) => ({ error: error.message }),
  );
  await vi.advanceTimersByTimeAsync(ENGINE_LOCK_WAIT_MS + 10);
  ops.receive({
    type: 'model.switch_result',
    payload: {
      requestId,
      success: false,
      message: 'Switch failed: Timed out waiting for file lock',
    },
  });

  // The engine's own answer reaches the caller, not "did not acknowledge".
  expect(await settled).toEqual({ error: 'Switch failed: Timed out waiting for file lock' });
});

it('control: other requests keep the default timeout', async () => {
  vi.useFakeTimers();
  const ops = new EngineOperations(async () => undefined);
  const settled = ops
    .request('sessions.list', {}, ['sessions.list'])
    .catch((e: Error) => e.message);

  await vi.advanceTimersByTimeAsync(15_001);

  expect(await settled).toMatch(/did not acknowledge/);
});
