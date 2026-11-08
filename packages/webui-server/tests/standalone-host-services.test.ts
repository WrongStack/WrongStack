import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  depWatcher: vi.fn(),
  hqPresence: vi.fn(),
  stopDepWatcher: vi.fn(),
  hq: { switchProject: vi.fn(), dispose: vi.fn() },
}));
vi.mock('../src/server/standalone-dep-watcher.js', () => ({
  startStandaloneDepWatcher: mocks.depWatcher,
}));
vi.mock('../src/server/standalone-hq-presence.js', () => ({
  startStandaloneHqPresence: mocks.hqPresence,
}));

import { startStandaloneHostServices } from '../src/server/standalone-host-services.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.depWatcher.mockReturnValue(mocks.stopDepWatcher);
  mocks.hqPresence.mockReturnValue(mocks.hq);
});

function start(withFleet: boolean) {
  const director = { id: 'director' };
  const host = { spawn: vi.fn(), getDirector: () => director };
  const bindHqPublisher = vi.fn();
  const abortRunLock = vi.fn();
  const services = startStandaloneHostServices({
    state: {
      getConfig: () => ({ extensions: {} }),
      getProjectRoot: () => '/repo',
      getSession: () => ({ id: 'front' }),
      getClients: () => new Map(),
    } as never,
    deps: {
      logger: { info: vi.fn() },
      hasSession: (id: string) => id === 'shown',
      peekAgent: (id: string) => ({ ctx: { session: { id } } }),
    } as never,
    preContext: {
      session: { id: 'boot' },
      events: { id: 'bus' },
      sessionIdentity: { bindHqPublisher },
    } as never,
    agentServices: {
      isSessionLive: (id: string) => id === 'live',
      ...(withFleet ? { delegation: { host } } : {}),
    } as never,
    runLockControl: { has: (id: string) => id === 'live', abortRunLock } as never,
    paths: { globalRoot: '/g', projectSlug: 'slug' },
  });
  return { services, host, director, bindHqPublisher, abortRunLock };
}

describe('standalone host services', () => {
  it('starts the dependency watcher on the boot session through the fleet host', () => {
    const { host } = start(true);
    expect(mocks.depWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/repo',
        sessionId: 'boot',
        host,
        paths: { globalRoot: '/g', projectSlug: 'slug' },
      }),
    );
  });

  it('binds HQ presence to the engine’s runs, conversations, fleet and session identity', () => {
    const { director, bindHqPublisher, abortRunLock } = start(true);
    const input = mocks.hqPresence.mock.calls[0]![0];
    expect(input).toMatchObject({ projectRoot: '/repo', bootSessionId: 'boot' });
    expect(input.getSessionId()).toBe('front');
    expect(input.isRunning('live')).toBe(true);
    input.abortRun('live');
    expect(abortRunLock).toHaveBeenCalledWith('live');
    expect([input.ownsSession('live'), input.ownsSession('shown'), input.ownsSession('x')]).toEqual(
      [true, true, false],
    );
    expect(input.getSessionWriter('t')).toEqual({ id: 't' });
    expect(input.getDirector()).toBe(director);
    input.onPublisher('publisher');
    expect(bindHqPublisher).toHaveBeenCalledWith('publisher');
  });

  it('offers no fleet control without a fleet host, and disposes both services', () => {
    const { services } = start(false);
    expect(mocks.hqPresence.mock.calls[0]![0].getDirector).toBeUndefined();
    expect(mocks.depWatcher.mock.calls[0]![0].host).toBeUndefined();
    services.switchProject('/other');
    expect(mocks.hq.switchProject).toHaveBeenCalledWith('/other');
    services.dispose();
    expect(mocks.hq.dispose).toHaveBeenCalledOnce();
    expect(mocks.stopDepWatcher).toHaveBeenCalledOnce();
  });
});
