import { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it } from 'vitest';
import { MultiAgentHost } from '../src/host.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('MultiAgentHost.ensureDirector concurrency', () => {
  it('coalesces concurrent callers so no caller receives an un-wired Director', async () => {
    const runnerGate = deferred<{ run: () => Promise<never> }>();
    const host = new MultiAgentHost(
      {
        events: new EventBus(),
        configStore: { get: () => ({}) } as never,
        session: { id: 's1' } as never,
        projectRoot: '/tmp',
        toolRegistry: { list: () => [], register: () => {}, unregister: () => {} } as never,
      },
      {},
    );
    (host as unknown as { buildSubagentRunner: () => Promise<unknown> }).buildSubagentRunner =
      async () => runnerGate.promise;

    let gateReleased = false;
    const p1 = host.ensureDirector();
    await Promise.resolve();
    await Promise.resolve();

    let p2BeforeGate = false;
    const p2 = host.ensureDirector().then((d) => {
      p2BeforeGate = !gateReleased;
      return d;
    });
    await Promise.resolve();
    await Promise.resolve();

    gateReleased = true;
    runnerGate.resolve({ run: async () => ({}) as never });

    const [d1, d2] = await Promise.all([p1, p2]);
    expect(p2BeforeGate).toBe(false);
    expect(d1).toBeTruthy();
    expect(d2).toBe(d1);
    expect((host as unknown as { directorRunnerSet: boolean }).directorRunnerSet).toBe(true);
  });
});
