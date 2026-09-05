/**
 * ACP sessions on the HQ fleet map.
 *
 * An editor driving WrongStack over ACP runs real turns — real provider calls,
 * real tools, real cost — and HQ saw none of it. The only trace an ACP process
 * left was the mailbox-only publisher every agent process opens, which shows
 * as a client with no session and no agents.
 */
import { describe, expect, it, vi } from 'vitest';

const trackers: { sessionId: string | undefined; started: boolean; stopped: boolean }[] = [];
class FakeTracker {
  readonly entry: (typeof trackers)[number];
  constructor(opts: { sessionId?: string }) {
    this.entry = { sessionId: opts.sessionId, started: false, stopped: false };
    trackers.push(this.entry);
  }
  start(): void {
    this.entry.started = true;
  }
  stop(): void {
    this.entry.stopped = true;
  }
  getAgents(): unknown[] {
    return [];
  }
}
vi.mock('@wrongstack/core/coordination', () => ({ AgentStatusTracker: FakeTracker }));

const bridges: { sessionId: string; projectRoot: string; events: unknown; stopped: boolean }[] = [];
vi.mock('@wrongstack/core/hq', () => ({
  startSessionTelemetryBridge: (opts: { sessionId: string; projectRoot: string; events: unknown }) => {
    const record = {
      sessionId: opts.sessionId,
      projectRoot: opts.projectRoot,
      events: opts.events,
      stopped: false,
    };
    bridges.push(record);
    return () => {
      record.stopped = true;
    };
  },
}));

const connections: { capabilities: unknown; clientKind: string; stopped: boolean }[] = [];
let publisherAvailable = true;
vi.mock('../src/hq-publisher.js', () => ({
  startCliHqConnection: (options: { capabilities: unknown; clientKind: string }) => {
    const record = {
      capabilities: options.capabilities,
      clientKind: options.clientKind,
      stopped: false,
    };
    connections.push(record);
    return {
      getPublisher: () => (publisherAvailable ? ({} as never) : undefined),
      getKanbanSyncStats: () => undefined,
      stop: () => {
        record.stopped = true;
      },
    };
  },
}));

const { startAcpHqTelemetry } = await import('../src/acp-hq-telemetry.js');

function fakeAgent(): never {
  // Each ACP session gets its OWN EventBus, which is what makes a per-session
  // tracker work here without any filtering.
  return { events: { id: Math.random() } } as never;
}

function harness() {
  trackers.length = 0;
  bridges.length = 0;
  connections.length = 0;
  publisherAvailable = true;
  const created: string[] = [];
  const telemetry = startAcpHqTelemetry({
    projectRoot: '/repo',
    projectName: 'repo',
  });
  const agentFor = async (sessionId: string, _cwd: string) => {
    created.push(sessionId);
    return fakeAgent();
  };
  return { telemetry, agentFor, created };
}

describe('startAcpHqTelemetry', () => {
  it('opens one publisher for the process and announces itself as an ACP surface', () => {
    const { telemetry } = harness();
    expect(connections).toHaveLength(1);
    expect(connections[0]?.clientKind).toBe('acp');
    // `acp` has to be in the protocol's client-kind set or `client.hello` is
    // refused outright.
    expect(connections[0]?.capabilities).toContain('session.summary');
    telemetry.stop();
    expect(connections[0]?.stopped).toBe(true);
  });

  it('attaches a session-scoped tracker and bridge per ACP session', async () => {
    const { telemetry, agentFor } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);

    const first = await wrapped('sess-a', '/work/a');
    await wrapped('sess-b', '/work/b');

    expect(telemetry.active().sort()).toEqual(['sess-a', 'sess-b']);
    expect(trackers.map((t) => t.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
    expect(trackers.every((t) => t.started)).toBe(true);
    // The bridge listens on that session's own bus, and reports the directory
    // the CLIENT opened rather than where the server booted.
    expect(bridges[0]?.events).toBe((first as unknown as { events: unknown }).events);
    expect(bridges.map((b) => b.projectRoot)).toEqual(['/work/a', '/work/b']);
    telemetry.stop();
  });

  it('returns the same agent the wrapped factory built', async () => {
    const { telemetry, agentFor, created } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    const agent = await wrapped('sess-a', '/work/a');
    expect(created).toEqual(['sess-a']);
    expect(agent).toBeDefined();
    telemetry.stop();
  });

  it('stops reporting when the editor closes the session', async () => {
    const { telemetry, agentFor } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    await wrapped('sess-a', '/work/a');

    const inner = vi.fn();
    const dispose = telemetry.wrapDispose(inner);
    dispose('sess-a');

    expect(inner).toHaveBeenCalledWith('sess-a');
    expect(telemetry.active()).toEqual([]);
    // Disposing the bridge publishes `session.ended`, so the node leaves the
    // map immediately instead of ageing out of it.
    expect(bridges[0]?.stopped).toBe(true);
    expect(trackers[0]?.stopped).toBe(true);
    telemetry.stop();
  });

  it('still disposes the session when telemetry was never attached', () => {
    const { telemetry } = harness();
    const inner = vi.fn();
    telemetry.wrapDispose(inner)('never-seen');
    expect(inner).toHaveBeenCalledWith('never-seen');
    telemetry.stop();
  });

  it('never fails a session because HQ is unreachable', async () => {
    const { telemetry, agentFor } = harness();
    publisherAvailable = false;
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    await expect(wrapped('sess-a', '/work/a')).resolves.toBeDefined();
    expect(telemetry.active()).toEqual([]);
    expect(trackers).toHaveLength(0);
    telemetry.stop();
  });

  it('is idempotent for a session that is created twice', async () => {
    const { telemetry, agentFor } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    await wrapped('sess-a', '/work/a');
    await wrapped('sess-a', '/work/a');
    expect(bridges).toHaveLength(1);
    telemetry.stop();
  });
});
