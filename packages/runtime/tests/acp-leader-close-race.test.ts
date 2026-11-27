import { describe, expect, it } from 'vitest';
import { AcpLeaderProvider } from '../src/acp-leader/acp-leader-provider.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('AcpLeaderProvider closeAll() vs in-flight model switch and stream()', () => {
  it('fences sessionFor after closeAll() so queued model switches do not spawn orphaned sessions', async () => {
    const provider = new AcpLeaderProvider({
      bootConfig: { model: 'acp/agent-a' } as never,
      buildProvider: () => undefined,
    });
    const gateA = deferred<void>();
    let started = 0;
    let closed = 0;
    let fleetClosed = 0;

    (
      provider as unknown as { startSession: (k: string, a: string) => Promise<unknown> }
    ).startSession = async (_key: string, agentId: string) => {
      started += 1;
      if (agentId === 'agent-a') await gateA.promise;
      return {
        agentId,
        session: {
          close: async () => {
            closed += 1;
          },
        },
        fleet: {
          close: async () => {
            fleetClosed += 1;
          },
        },
      };
    };

    const callSessionFor = (key: string, agentId: string) =>
      (
        provider as unknown as { sessionFor: (k: string, a: string) => Promise<unknown> }
      ).sessionFor(key, agentId);

    const pA = callSessionFor('s1', 'agent-a');
    const pB = callSessionFor('s1', 'agent-b');
    const closeP = provider.closeAll();
    gateA.resolve();

    const [, resB] = await Promise.allSettled([pA, pB, closeP]);
    expect(resB.status).toBe('rejected');
    expect(started).toBe(1);
    expect(closed).toBe(1);
    expect(fleetClosed).toBe(1);
    expect((provider as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });

  it('aborts startSession before openSession when closeAll() arrives during ACPSession.start()', async () => {
    const provider = new AcpLeaderProvider({
      bootConfig: { model: 'acp/agent-a' } as never,
      buildProvider: () => undefined,
    });
    const startEntered = deferred<void>();
    const startGate = deferred<{
      openSession: () => Promise<{ sessionId: string; resumed: boolean }>;
      close: () => Promise<void>;
      getSessionPlans: () => unknown[];
    }>();
    let openCalls = 0;
    let closeCalls = 0;

    (provider as unknown as { acp: unknown }).acp = {
      resolveAcpAgentCommand: () => ({ command: 'fake-agent', args: [] }),
      readCachedAcpRegistry: () => undefined,
      resolveAcpClientProfile: () => ({}),
      classifyAgentFailure: () => undefined,
      ACPSession: {
        start: () => {
          startEntered.resolve();
          return startGate.promise;
        },
      },
    };

    const sessionPromise = (
      provider as unknown as { sessionFor: (k: string, a: string) => Promise<unknown> }
    ).sessionFor('s-start-race', 'agent-a');

    await startEntered.promise;

    const closePromise = provider.closeAll();
    startGate.resolve({
      openSession: async () => {
        openCalls += 1;
        return { sessionId: 'late-sess', resumed: false };
      },
      close: async () => {
        closeCalls += 1;
      },
      getSessionPlans: () => [],
    });

    const [sessRes] = await Promise.allSettled([sessionPromise, closePromise]);
    expect(sessRes.status).toBe('rejected');
    expect(openCalls).toBe(0);
    expect(closeCalls).toBe(1);
  });
});
