/**
 * `initialModeId`: a host that decides permissions itself starts the agent in
 * the mode where it asks (Claude's `default`), whatever mode the user runs
 * the agent in on their own.
 */
import { describe, expect, it, vi } from 'vitest';
import { type ACPSessionOpContext, executeCreateSession } from '../src/client/acp-session-ops.js';

function ctx(
  newSessionResult: unknown,
  initialModeId?: string,
  requireInitialMode = false,
  extra: { capabilities?: unknown; resumeSessionId?: string } = {},
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let id = 0;
  const c = {
    closed: false,
    sessionId: null,
    agentCapabilities: extra.capabilities ?? {},
    opts: {
      command: 'agent',
      projectRoot: '/p',
      ...(initialModeId ? { initialModeId } : {}),
      ...(requireInitialMode ? { requireInitialMode } : {}),
      ...(extra.resumeSessionId ? { resumeSessionId: extra.resumeSessionId } : {}),
    },
    allocId: () => ++id,
    sendRequest: vi.fn(async (_id: number, method: string, params: unknown) => {
      calls.push({ method, params });
      return method === 'session/new' ? newSessionResult : {};
    }),
    setSessionId: () => {},
    resetScratch: () => {},
    closeSession: async () => {},
  } as unknown as ACPSessionOpContext;
  return { c, calls };
}

const modes = (current: string) => ({
  sessionId: 's1',
  modes: {
    currentModeId: current,
    availableModes: [{ id: 'auto' }, { id: 'default' }, { id: 'acceptEdits' }],
  },
});

describe('executeCreateSession initialModeId', () => {
  it('switches to the requested mode when the agent offers it', async () => {
    const { c, calls } = ctx(modes('auto'), 'default');
    await expect(executeCreateSession(c)).resolves.toBe('s1');
    expect(calls.map((x) => x.method)).toEqual(['session/new', 'session/set_mode']);
    expect(calls[1]?.params).toEqual({ sessionId: 's1', modeId: 'default' });
  });

  it('sends nothing more when already in that mode, not offered, or not asked', async () => {
    for (const [result, want] of [
      [modes('default'), 'default'],
      [modes('auto'), 'plan-only'],
      [{ sessionId: 's1' }, 'default'],
      [modes('auto'), undefined],
    ] as const) {
      const { c, calls } = ctx(result, want);
      await executeCreateSession(c);
      expect(calls.map((x) => x.method)).toEqual(['session/new']);
    }
  });

  it('fails the session when the switch fails, rather than run in the wrong mode', async () => {
    const { c } = ctx(modes('auto'), 'default');
    (c.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: number, method: string) =>
        method === 'session/set_mode' ? { code: -32603, message: 'mode refused' } : modes('auto'),
    );
    await expect(executeCreateSession(c)).rejects.toThrow('session/set_mode failed: mode refused');
  });

  it('refuses an agent without the mode when the host requires it', async () => {
    for (const result of [modes('auto'), { sessionId: 's1' }]) {
      const { c, calls } = ctx(result, 'plan-only', true);
      await expect(executeCreateSession(c)).rejects.toThrow(
        'the agent does not offer the "plan-only" session mode this host requires',
      );
      expect(calls.map((x) => x.method)).toEqual(['session/new']);
    }
    const { c } = ctx(modes('auto'), 'default', true);
    await expect(executeCreateSession(c)).resolves.toBe('s1');
  });

  // A session the client creates and then refuses becomes unreachable: its id
  // is discarded, so leaving it open on the agent leaks one session per
  // refused attempt (fleet/leader run claude-code with requireInitialMode).
  it('closes the session it created when the host requires a mode the agent lacks', async () => {
    const { c, calls } = ctx({ sessionId: 's1' }, 'plan-only', true, {
      capabilities: { sessionCapabilities: { close: {} } },
    });
    await expect(executeCreateSession(c)).rejects.toThrow(
      'the agent does not offer the "plan-only" session mode this host requires',
    );
    expect(calls.map((x) => x.method)).toEqual(['session/new', 'session/close']);
    expect(calls[1]?.params).toEqual({ sessionId: 's1' });
  });

  it('closes the created session when the mode switch fails, keeping its error', async () => {
    const { c, calls } = ctx(modes('auto'), 'default', false, {
      capabilities: { sessionCapabilities: { close: {} } },
    });
    (c.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: number, method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'session/set_mode') return { code: -32603, message: 'mode refused' };
        return method === 'session/new' ? modes('auto') : {};
      },
    );
    await expect(executeCreateSession(c)).rejects.toThrow('session/set_mode failed: mode refused');
    expect(calls.map((x) => x.method)).toEqual(['session/new', 'session/set_mode', 'session/close']);
  });

  it('never closes a refused resume: that session already belongs to the agent', async () => {
    const { c, calls } = ctx({ sessionId: 's1' }, 'plan-only', true, {
      capabilities: { sessionCapabilities: { resume: {}, close: {} } },
      resumeSessionId: 'user-session',
    });
    (c.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: number, method: string, params: unknown) => {
        calls.push({ method, params });
        return method === 'session/resume'
          ? {
              sessionId: 'user-session',
              modes: { currentModeId: 'auto', availableModes: [{ id: 'auto' }] },
            }
          : {};
      },
    );
    await expect(executeCreateSession(c)).rejects.toThrow(
      'the agent does not offer the "plan-only" session mode this host requires',
    );
    expect(calls.map((x) => x.method)).toEqual(['session/resume']);
  });

  it('sends no close when the agent does not advertise session/close', async () => {
    const { c, calls } = ctx({ sessionId: 's1' }, 'plan-only', true);
    await expect(executeCreateSession(c)).rejects.toThrow('does not offer the "plan-only"');
    expect(calls.map((x) => x.method)).toEqual(['session/new']);
  });
});
