/**
 * One HQ session per open WebUI tab.
 *
 * The WebUI runs four concurrent sessions, but HQ only ever heard about the
 * boot one: the presence layer started a single telemetry bridge. Three tabs
 * had no node, no transcript and no way to be steered.
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

const bridges: { sessionId: string; stopped: boolean; writer: unknown }[] = [];
const startSessionTelemetryBridge = vi.fn((opts: { sessionId: string; writer?: unknown }) => {
  const record = { sessionId: opts.sessionId, stopped: false, writer: opts.writer };
  bridges.push(record);
  return () => {
    record.stopped = true;
  };
});
vi.mock('@wrongstack/core/hq', () => ({ startSessionTelemetryBridge }));

const { startWebuiHqSessionTelemetry } = await import('../../src/server/hq-session-telemetry.js');

function harness(options: {
  sessions: string[];
  ownedElsewhere?: (sessionId: string) => boolean;
  writer?: (sessionId: string) => unknown;
  /** Simulate the window before the HQ socket has produced a publisher. */
  noPublisher?: boolean;
}) {
  trackers.length = 0;
  bridges.length = 0;
  startSessionTelemetryBridge.mockClear();
  let live = options.sessions;
  const telemetry = startWebuiHqSessionTelemetry({
    events: { on: () => () => {} } as never,
    projectRoot: '/repo',
    projectName: 'repo',
    getPublisher: () => (options.noPublisher === true ? undefined : ({} as never)),
    listSessions: () => live,
    ...(options.ownedElsewhere ? { isOwnedElsewhere: options.ownedElsewhere } : {}),
    ...(options.writer ? { getWriter: options.writer as never } : {}),
  });
  return {
    telemetry,
    set: (next: string[]) => {
      live = next;
    },
  };
}

describe('startWebuiHqSessionTelemetry', () => {
  it('opens a bridge and a session-scoped tracker for every displayed tab', () => {
    const { telemetry } = harness({ sessions: ['tab-1', 'tab-2', 'tab-3'] });
    telemetry.sync();

    expect(telemetry.active().sort()).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(bridges.map((b) => b.sessionId).sort()).toEqual(['tab-1', 'tab-2', 'tab-3']);
    // Each tracker is scoped: they share the host's one event bus, so an
    // unscoped tracker would report every tab's agents on every tab.
    expect(trackers.map((t) => t.sessionId).sort()).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(trackers.every((t) => t.started)).toBe(true);
    telemetry.stop();
  });

  it('is idempotent — a second sync with the same tabs changes nothing', () => {
    const { telemetry } = harness({ sessions: ['tab-1'] });
    telemetry.sync();
    telemetry.sync();
    expect(startSessionTelemetryBridge).toHaveBeenCalledTimes(1);
    telemetry.stop();
  });

  it('stops a tab that closed and starts one that opened', () => {
    const { telemetry, set } = harness({ sessions: ['tab-1', 'tab-2'] });
    telemetry.sync();

    set(['tab-2', 'tab-3']);
    telemetry.sync();

    expect(telemetry.active().sort()).toEqual(['tab-2', 'tab-3']);
    // The closed tab's bridge is disposed, which publishes `session.ended` —
    // that is what removes the node instead of leaving it to the staleness
    // reaper five minutes later.
    expect(bridges.find((b) => b.sessionId === 'tab-1')?.stopped).toBe(true);
    expect(bridges.find((b) => b.sessionId === 'tab-2')?.stopped).toBe(false);
    expect(trackers.find((t) => t.sessionId === 'tab-1')?.stopped).toBe(true);
    telemetry.stop();
  });

  it('skips a session another publisher in the process already announces', () => {
    // `cli-main` runs its own tracker and bridge for the boot session; a second
    // pair would put two trackers on one bus flushing the same agent list.
    const { telemetry } = harness({
      sessions: ['boot', 'tab-2'],
      ownedElsewhere: (id) => id === 'boot',
    });
    telemetry.sync();
    expect(telemetry.active()).toEqual(['tab-2']);
    telemetry.stop();
  });

  it('hands the bridge the tab own writer when the host holds one', () => {
    const writer = { id: 'tab-1' };
    const { telemetry } = harness({
      sessions: ['tab-1'],
      writer: (id) => (id === 'tab-1' ? writer : undefined),
    });
    telemetry.sync();
    expect(bridges[0]?.writer).toBe(writer);
    telemetry.stop();
  });

  it('starts nothing while the publisher is still connecting', () => {
    const { telemetry } = harness({ sessions: ['tab-1'], noPublisher: true });
    telemetry.sync();
    expect(telemetry.active()).toEqual([]);
    expect(trackers).toHaveLength(0);
    telemetry.stop();
  });

  it('stop() disposes every live bridge and tracker', () => {
    const { telemetry } = harness({ sessions: ['tab-1', 'tab-2'] });
    telemetry.sync();
    telemetry.stop();
    expect(telemetry.active()).toEqual([]);
    expect(bridges.every((b) => b.stopped)).toBe(true);
    expect(trackers.every((t) => t.stopped)).toBe(true);
    // A stopped manager must stay stopped even if the sync timer fires once more.
    telemetry.sync();
    expect(telemetry.active()).toEqual([]);
  });
});
