import { vi } from 'vitest';
import { beginCopilotLogin } from '../../src/oauth/copilot.js';

export async function exercise(
  stage: 'poll' | 'exchange' | 'models',
  cancel: 'none' | 'close' | 'begin',
) {
  vi.useFakeTimers();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const begin = new AbortController();
  const wait = new AbortController();
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    let current: string;
    let body: unknown;
    if (url.endsWith('/login/device/code')) {
      current = 'device';
      body = {
        device_code: 'fixture',
        user_code: 'FIXTURE',
        verification_uri: 'https://github.com/login/device',
        interval: 1,
        expires_in: 900,
      };
    } else if (url.endsWith('/login/oauth/access_token')) {
      current = 'poll';
      body = { access_token: 'fixture-github' };
    } else if (url.endsWith('/copilot_internal/v2/token')) {
      current = 'exchange';
      body = { token: 'fixture-copilot', expires_at: 2_000_000_000 };
    } else if (url.endsWith('/models')) {
      current = 'models';
      body = { data: [] };
    } else throw new Error('Unexpected fixture endpoint');
    calls.push(current);
    if (current === stage) {
      entered.resolve();
      await gate.promise;
    }
    // Deliberately finish after cancellation: the wire can already have completed.
    return Response.json(body);
  });
  let session: Awaited<ReturnType<typeof beginCopilotLogin>> | undefined;
  try {
    session = await beginCopilotLogin(undefined, begin.signal);
    const pending = session.waitForCompletion(wait.signal);
    await vi.advanceTimersByTimeAsync(1000);
    await entered.promise;
    if (cancel === 'close') session.close();
    if (cancel === 'begin') begin.abort();
    gate.resolve();
    const result = await pending;
    return { published: result !== null, calls };
  } finally {
    gate.resolve();
    session?.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
}
