import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/server/server-runtime.js', () => ({
  createSessionStartPayload: () => async (overrides?: Record<string, unknown>) => ({
    sessionId: 's1',
    model: 'm',
    ...overrides,
  }),
}));

const { createStartWebuiSessionPayloadHelper } = await import(
  '../src/server/start-webui-payload.js'
);

function helper(
  getAppUpdate?: () => {
    appVersion: string;
    latestVersion?: string;
    updateAvailable: boolean;
    updateCheckFailed: boolean;
  },
) {
  return createStartWebuiSessionPayloadHelper({
    getConfig: () => ({}) as never,
    getSessionId: () => 's1',
    getProjectRoot: () => '/p',
    getWorkingDir: () => '/p',
    getModeId: () => 'default',
    getContextMeta: () => ({}),
    needsSetup: false,
    stateGetter: () => ({}) as never,
    modelsRegistry: {} as never,
    getAppUpdate,
  });
}

describe('session.start update fields', () => {
  it('carries the host version and the newest release when the host checks for one', async () => {
    let latest = '1.5.2';
    const build = helper(() => ({
      appVersion: '1.5.2',
      latestVersion: latest,
      updateAvailable: latest !== '1.5.2',
      updateCheckFailed: false,
    }));
    expect(await build({ reset: true })).toEqual({
      sessionId: 's1',
      model: 'm',
      reset: true,
      appVersion: '1.5.2',
      latestVersion: '1.5.2',
      updateAvailable: false,
      updateCheckFailed: false,
    });
    // Read at each build: a check that finishes later shows on the next session.start.
    latest = '1.5.3';
    expect(await build()).toMatchObject({ latestVersion: '1.5.3', updateAvailable: true });
  });

  it('adds nothing for a host that does not check', async () => {
    expect(await helper()()).toEqual({ sessionId: 's1', model: 'm' });
  });
});
