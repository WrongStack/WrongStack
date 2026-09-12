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

/**
 * Stand-in for the per-session approval registry.
 *
 * Deliberately real enough to answer with: the production code calls
 * `createApprovalRegistry` inside a try/catch (mirroring is optional), so a
 * mock missing this export would make every assertion below pass while ACP
 * approvals silently did nothing.
 */
interface FakeApprovals {
  sessionId: string | undefined;
  answered: Array<{ toolUseId: string; decision: string; expectSessionId?: string | undefined }>;
  live: Set<string>;
  disposed: boolean;
  resolve: (toolUseId: string, decision: string, expectSessionId?: string) => boolean;
  dispose: () => void;
}
const approvalRegistries: FakeApprovals[] = [];
const approvalBridges: { sessionId: string; projectRoot: string; stopped: boolean }[] = [];

vi.mock('@wrongstack/core/hq', () => ({
  startSessionTelemetryBridge: (opts: {
    sessionId: string;
    projectRoot: string;
    events: unknown;
  }) => {
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
  createApprovalRegistry: (_events: unknown) => {
    const registry: FakeApprovals = {
      sessionId: undefined,
      answered: [],
      live: new Set<string>(),
      disposed: false,
      resolve: (toolUseId, decision, expectSessionId) => {
        if (!registry.live.has(toolUseId)) return false;
        if (expectSessionId !== undefined && expectSessionId !== registry.sessionId) return false;
        registry.live.delete(toolUseId);
        registry.answered.push({ toolUseId, decision, expectSessionId });
        return true;
      },
      dispose: () => {
        registry.disposed = true;
      },
    };
    approvalRegistries.push(registry);
    return registry;
  },
  startApprovalTelemetryBridge: (opts: { sessionId: string; projectRoot: string }) => {
    const record = { sessionId: opts.sessionId, projectRoot: opts.projectRoot, stopped: false };
    approvalBridges.push(record);
    // The registry created immediately before this call is the one for this
    // session — record it so a test can pretend a prompt is live on it.
    const registry = approvalRegistries.at(-1);
    if (registry) registry.sessionId = opts.sessionId;
    return () => {
      record.stopped = true;
    };
  },
}));

type CommandHandler = (command: {
  commandId: string;
  type: string;
  payload: unknown;
}) => Promise<{ status: string; message?: string }>;

const connections: {
  capabilities: unknown;
  clientKind: string;
  stopped: boolean;
  onCommand?: CommandHandler | undefined;
}[] = [];
let publisherAvailable = true;
vi.mock('../src/hq-publisher.js', () => ({
  startCliHqConnection: (options: {
    capabilities: unknown;
    clientKind: string;
    onCommand?: CommandHandler;
  }) => {
    const record = {
      capabilities: options.capabilities,
      clientKind: options.clientKind,
      onCommand: options.onCommand,
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
  approvalRegistries.length = 0;
  approvalBridges.length = 0;
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

describe('ACP approval mirroring', () => {
  async function approve(
    sessionId: string | undefined,
    toolUseId: string,
    decision = 'yes',
  ): Promise<{ status: string; message?: string }> {
    const handler = connections[0]?.onCommand;
    if (!handler) throw new Error('ACP connection declared no command handler');
    return handler({
      commandId: 'c1',
      type: 'approve',
      payload: { toolUseId, decision, ...(sessionId ? { sessionId } : {}) },
    });
  }

  it('declares the capabilities the server gates approvals on', () => {
    const { telemetry } = harness();
    // `control.receive` is the server's gate for ANY command; `control.approve`
    // is the one for this one. Missing either means an operator's answer is
    // refused with a 409/403 they cannot act on.
    expect(connections[0]?.capabilities).toContain('control.receive');
    expect(connections[0]?.capabilities).toContain('control.approve');
    telemetry.stop();
  });

  it('creates a registry and bridge per ACP session', async () => {
    const { telemetry, agentFor } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    await wrapped('sess-a', '/work/a');
    await wrapped('sess-b', '/work/b');

    // Per session, not per process: ACP gives each session its own EventBus.
    expect(approvalRegistries).toHaveLength(2);
    expect(approvalBridges.map((b) => b.sessionId)).toEqual(['sess-a', 'sess-b']);
    telemetry.stop();
  });

  it('routes an answer to the session that raised the prompt', async () => {
    const { telemetry, agentFor } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    await wrapped('sess-a', '/work/a');
    await wrapped('sess-b', '/work/b');
    const [a, b] = approvalRegistries;
    b!.live.add('toolu_1');

    const result = await approve('sess-b', 'toolu_1', 'always');

    expect(result.status).toBe('completed');
    expect(b!.answered).toEqual([
      { toolUseId: 'toolu_1', decision: 'always', expectSessionId: 'sess-b' },
    ]);
    // The other editor tab must be untouched — approving a tool call in the
    // wrong conversation is the failure this routing exists to prevent.
    expect(a!.answered).toEqual([]);
    telemetry.stop();
  });

  it('refuses an answer for a session this process does not have', async () => {
    const { telemetry, agentFor } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    await wrapped('sess-a', '/work/a');

    const result = await approve('sess-gone', 'toolu_1');
    expect(result.status).toBe('rejected');
    telemetry.stop();
  });

  it('refuses a prompt that is no longer pending instead of reporting success', async () => {
    const { telemetry, agentFor } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    await wrapped('sess-a', '/work/a');

    const result = await approve('sess-a', 'toolu_never_raised');
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('no longer pending');
    telemetry.stop();
  });

  it('refuses every other command — ACP has no mailbox and no leader', async () => {
    const { telemetry, agentFor } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    await wrapped('sess-a', '/work/a');
    const handler = connections[0]!.onCommand!;

    const steer = await handler({
      commandId: 'c2',
      type: 'steer',
      payload: { to: 'leader', subject: 'x', body: 'y', sessionId: 'sess-a' },
    });
    expect(steer.status).toBe('rejected');
    telemetry.stop();
  });

  it('disposes a closed session registry so its prompts stop being answerable', async () => {
    const { telemetry, agentFor } = harness();
    const wrapped = telemetry.wrapAgentFactory(agentFor);
    await wrapped('sess-a', '/work/a');
    const [registry] = approvalRegistries;
    registry!.live.add('toolu_1');

    telemetry.wrapDispose(vi.fn())('sess-a');

    expect(registry!.disposed).toBe(true);
    expect(approvalBridges[0]?.stopped).toBe(true);
    const result = await approve('sess-a', 'toolu_1');
    expect(result.status).toBe('rejected');
    // Disposed, NOT drained: the prompt belongs to the editor session, and
    // answering it because HQ lost sight would decide for the user.
    expect(registry!.answered).toEqual([]);
    telemetry.stop();
  });
});
