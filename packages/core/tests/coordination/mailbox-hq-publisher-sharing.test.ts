/**
 * One HQ mailbox socket per process, not per Agent.
 *
 * `attachMailboxChecker` runs for EVERY Agent a process builds — the leader
 * and each subagent — so a per-Agent publisher meant a fleet of five workers
 * opened five extra HQ sockets reporting the same project mailbox. HQ
 * supersedes same-class sockets from one pid, so each new one closed its
 * siblings, they reconnected and closed it back: a permanent reconnect
 * ping-pong that churned HQ's client list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createHqPublisherFromEnv = vi.fn();
vi.mock('../../src/hq/factory.js', () => ({ createHqPublisherFromEnv }));

const getSharedProjectMailbox = vi.fn();
vi.mock('../../src/coordination/remote-mailbox.js', () => ({ getSharedProjectMailbox }));

const { attachMailboxChecker, resetMailboxHqPublishersForTests } = await import(
  '../../src/mailbox-attach.js'
);

interface FakeAgent {
  internals: Parameters<typeof attachMailboxChecker>[0];
  dispose: () => void;
}

function makeAgent(projectRoot: string, sessionId: string): FakeAgent {
  const hooks: (() => void)[] = [];
  const internals = {
    ctx: {
      projectRoot,
      meta: {} as Record<string, unknown>,
      agentId: 'leader',
      agentName: 'leader',
      session: { id: sessionId },
      registerAgentHook: (hook: () => void) => hooks.push(hook),
    },
    events: { onPattern: () => () => {} },
    logger: { debug: () => {} },
  } as never as Parameters<typeof attachMailboxChecker>[0];
  return {
    internals,
    dispose: () => {
      for (const hook of hooks) hook();
    },
  };
}

function fakePublisher(): { connect: () => void; close: () => void } {
  return { connect: vi.fn(), close: vi.fn() };
}

beforeEach(() => {
  resetMailboxHqPublishersForTests();
  createHqPublisherFromEnv.mockReset();
  getSharedProjectMailbox.mockReset();
  // Every mailbox call the checker makes during setup is a no-op stub; this
  // test is about the publisher, and a real handle would spawn the project
  // daemon.
  getSharedProjectMailbox.mockReturnValue({
    registerAgent: () => Promise.resolve(),
    deregisterAgent: () => Promise.resolve(),
    query: () => Promise.resolve([]),
    ackMany: () => Promise.resolve([]),
    getAgentStatuses: () => Promise.resolve([]),
    heartbeat: () => Promise.resolve(),
    agentHeartbeat: () => Promise.resolve(),
  });
});

describe('mailbox HQ publisher sharing', () => {
  it('opens one socket for every Agent in the same process and project', () => {
    const publisher = fakePublisher();
    createHqPublisherFromEnv.mockReturnValue(publisher);

    const leader = makeAgent('/repo', 'sess-1');
    const worker = makeAgent('/repo', 'sess-1');
    attachMailboxChecker(leader.internals);
    attachMailboxChecker(worker.internals);

    expect(createHqPublisherFromEnv).toHaveBeenCalledTimes(1);
    expect(publisher.connect).toHaveBeenCalledTimes(1);
    // The socket must not claim to be a terminal — HQ would render a phantom
    // "waiting for session telemetry" node and orphan-evict it.
    expect(createHqPublisherFromEnv.mock.calls[0]![0].capabilities).toEqual([
      'telemetry.publish',
      'mailbox.summary',
    ]);

    // The last Agent to go closes it, not the first.
    leader.dispose();
    expect(publisher.close).not.toHaveBeenCalled();
    worker.dispose();
    expect(publisher.close).toHaveBeenCalledTimes(1);
  });

  it('keeps separate sockets per project root and surface', () => {
    createHqPublisherFromEnv.mockImplementation(() => fakePublisher());

    attachMailboxChecker(makeAgent('/repo-a', 's1').internals);
    attachMailboxChecker(makeAgent('/repo-b', 's1').internals);
    attachMailboxChecker(makeAgent('/repo-a', 's1').internals, 'webui');

    expect(createHqPublisherFromEnv).toHaveBeenCalledTimes(3);
  });

  it('reopens after the last Agent released it', () => {
    createHqPublisherFromEnv.mockImplementation(() => fakePublisher());

    const first = makeAgent('/repo', 's1');
    attachMailboxChecker(first.internals);
    first.dispose();
    attachMailboxChecker(makeAgent('/repo', 's2').internals);

    expect(createHqPublisherFromEnv).toHaveBeenCalledTimes(2);
  });

  it('balances the refcount when HQ is disabled', () => {
    createHqPublisherFromEnv.mockReturnValue(undefined);

    const agent = makeAgent('/repo', 's1');
    attachMailboxChecker(agent.internals);
    attachMailboxChecker(makeAgent('/repo', 's1').internals);
    agent.dispose();

    // Cached as `undefined` rather than re-deciding per Agent, so the config
    // is read once.
    expect(createHqPublisherFromEnv).toHaveBeenCalledTimes(1);
  });
});
