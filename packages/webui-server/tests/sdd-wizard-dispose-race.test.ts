import { describe, expect, it } from 'vitest';
import { SddWizardWebSocketHandler } from '../src/server/sdd-wizard-ws-handler.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SddWizardWebSocketHandler dispose race (F2716)', () => {
  it('aborts handleMessage after await ready if disposed while bootstrap is pending', async () => {
    const readyGate = deferred<void>();
    let startCalls = 0;

    const handler = new SddWizardWebSocketHandler({
      ensureReady: () => readyGate.promise,
      makeDriver: () =>
        ({
          loadExisting: async () => false,
          getLastAgentText: () => '',
          start: async () => {
            startCalls += 1;
          },
        }) as never,
    });

    const msgPromise = handler.handleMessage({
      type: 'sdd.spec.start',
      payload: { goal: 'build' },
    });
    handler.dispose();
    readyGate.resolve();
    await msgPromise;

    expect(startCalls).toBe(0);
  });

  it('aborts handleMessage after await resumeProbe if disposed during retry', async () => {
    const probeGate = deferred<boolean>();
    let attempt = 0;
    let startCalls = 0;

    const handler = new SddWizardWebSocketHandler({
      ensureReady: async () => {},
      makeDriver: () => {
        attempt += 1;
        const currentAttempt = attempt;
        return {
          loadExisting: async () => {
            if (currentAttempt === 1) throw new Error('transient ipc down');
            return probeGate.promise;
          },
          getLastAgentText: () => '',
          start: async () => {
            startCalls += 1;
          },
        } as never;
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    const msgPromise = handler.handleMessage({
      type: 'sdd.spec.start',
      payload: { goal: 'build' },
    });
    await Promise.resolve();
    await Promise.resolve();
    handler.dispose();
    probeGate.resolve(false);
    await msgPromise;

    expect(startCalls).toBe(0);
  });
});
