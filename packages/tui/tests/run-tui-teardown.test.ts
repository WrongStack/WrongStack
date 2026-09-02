import { type Mock, describe, expect, it, vi } from 'vitest';
import {
  createDurableTeardown,
  type DurableTeardownOptions,
  type TeardownSession,
} from '../src/run-tui-teardown.js';

interface MockSession extends TeardownSession {
  close: Mock<() => Promise<void>>;
  flushSync: Mock<() => void>;
}

function makeSession(overrides: Partial<TeardownSession> = {}): MockSession {
  return {
    close: vi.fn().mockResolvedValue(undefined) as unknown as Mock<() => Promise<void>>,
    flushSync: vi.fn() as unknown as Mock<() => void>,
    ...overrides,
  } as MockSession;
}

function makeOpts(session: TeardownSession | undefined, closeBudgetMs = 25) {
  const exit = vi.fn();
  const cleanup = vi.fn();
  const killChildren = vi.fn();
  let opts: DurableTeardownOptions | undefined;
  const teardown = createDurableTeardown(
    (opts = {
      getSession: () => session,
      killChildren,
      cleanup,
      closeBudgetMs,
      exit,
    }),
  );
  return { teardown, exit, cleanup, killChildren, opts: () => opts! };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createDurableTeardown', () => {
  it('shutdownViaSignal: salvages synchronously, cleans up, exits with the given code', async () => {
    const session = makeSession();
    const { teardown, exit, cleanup, killChildren } = makeOpts(session);

    await teardown.shutdownViaSignal(143);

    expect(killChildren).toHaveBeenCalledOnce();
    // Salvage ran BEFORE cleanup (buffer must be safe before terminal work).
    expect(session.flushSync.mock.invocationCallOrder[0]!).toBeLessThan(
      cleanup.mock.invocationCallOrder[0]!,
    );
    // Close was attempted and awaited before exit.
    expect(session.close).toHaveBeenCalled();
    expect(cleanup.mock.invocationCallOrder[0]!).toBeLessThan(exit.mock.invocationCallOrder[0]!);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('shutdownViaSignal: waits for a slow-but-resolving close instead of exiting early', async () => {
    let resolveClose: (() => void) | undefined;
    const session = makeSession({
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveClose = resolve;
          }),
      ) as unknown as Mock<() => Promise<void>>,
    });
    const { teardown, exit } = makeOpts(session, 5_000);

    const done = teardown.shutdownViaSignal(130);
    // Close has been started but not resolved — give the race a chance to
    // wrongly pick the timeout path if the implementation ignored close().
    await sleep(30);
    expect(exit).not.toHaveBeenCalled();

    resolveClose?.();
    await done;
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('shutdownViaSignal: exits after the bounded budget when close hangs forever', async () => {
    const session = makeSession({
      close: vi.fn(() => new Promise<void>(() => {})) as unknown as Mock<() => Promise<void>>,
    });
    const { teardown, exit } = makeOpts(session, 25);

    const done = teardown.shutdownViaSignal(143);
    await sleep(80);
    await done;

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('shutdownViaSignal: a rejecting close still reaches exit (and does not throw)', async () => {
    const session = makeSession({
      close: vi.fn().mockRejectedValue(new Error('datasync failed')) as unknown as Mock<
        () => Promise<void>
      >,
    });
    const { teardown, exit } = makeOpts(session);

    await expect(teardown.shutdownViaSignal(1)).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('awaitDurableClose: runs salvage + cleanup + close but NEVER exits (natural path)', async () => {
    const session = makeSession();
    const { teardown, exit, cleanup } = makeOpts(session);

    await teardown.awaitDurableClose();

    expect(session.flushSync).toHaveBeenCalled();
    expect(session.close).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it('salvageSync: calls flushSync through getSession and swallows its failures', () => {
    const throwing = makeSession({
      flushSync: vi.fn(() => {
        throw new Error('fd closed');
      }) as unknown as Mock<() => void>,
    });
    const { teardown } = makeOpts(throwing);
    expect(() => teardown.salvageSync()).not.toThrow();

    const absent = makeOpts(undefined);
    expect(() => absent.teardown.salvageSync()).not.toThrow();
  });

  it('cleanup failures do not block the exit path', async () => {
    const session = makeSession();
    const { exit } = makeOpts(session);
    // Replace cleanup with a throwing one via a second instance sharing exit.
    const broken = createDurableTeardown({
      getSession: () => session,
      cleanup: () => {
        throw new Error('stdout detached');
      },
      closeBudgetMs: 25,
      exit,
    });

    await broken.shutdownViaSignal(70);

    expect(exit).toHaveBeenCalledWith(70);
  });
});
