import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginCopilotLogin } from '../src/oauth/copilot.js';
import { exercise } from './helpers/copilot-cancellation-scenario.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Copilot login session ownership', () => {
  it.each(['poll', 'exchange', 'models'] as const)(
    'discards late %s completion after close or cancellation',
    async (stage) => {
      expect((await exercise(stage, 'none')).published).toBe(true);
      for (const cancel of ['close', 'begin'] as const) {
        const result = await exercise(stage, cancel);
        expect(result.published).toBe(false);
        expect(result.calls.at(-1)).toBe(stage);
      }
    },
  );

  it('does not poll when completion is requested after close', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        device_code: 'fixture',
        user_code: 'FIXTURE',
        verification_uri: 'https://github.com/login/device',
        interval: 1,
        expires_in: 900,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const session = await beginCopilotLogin(undefined);
    session.close();
    session.close();
    expect(await session.waitForCompletion()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
