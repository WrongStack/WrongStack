import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HqSessionHistory } from '../src/persistence/session-history.js';
import type { HqSessionSnapshotPayload, HqSnapshot } from '../src/protocol.js';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');

function session(
  id: string,
  over: Partial<HqSessionSnapshotPayload> = {},
): HqSessionSnapshotPayload {
  return {
    sessionId: id,
    clientKind: 'tui',
    machineId: 'm1',
    hostname: 'LAB-02',
    projectId: 'p1',
    projectName: 'Datapipe',
    projectRoot: '/w/p1',
    status: 'active',
    startedAt: new Date(T0).toISOString(),
    lastActivityAt: new Date(T0 + 60_000).toISOString(),
    agentCount: 2,
    agents: [
      {
        id: 'leader',
        name: 'leader',
        status: 'idle',
        iterations: 3,
        toolCalls: 7,
        costUsd: 0.5,
        tokensIn: 1000,
        tokensOut: 200,
        model: 'm-a',
        lastActivityAt: '',
      },
      {
        id: 'w1',
        name: 'worker',
        status: 'idle',
        iterations: 1,
        toolCalls: 2,
        costUsd: 0.25,
        model: 'm-b',
        lastActivityAt: '',
      },
    ],
    ...over,
  } as HqSessionSnapshotPayload;
}

const snap = (sessions: HqSessionSnapshotPayload[]): HqSnapshot =>
  ({ liveSessions: sessions }) as unknown as HqSnapshot;

describe('HqSessionHistory', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-session-history-'));
  });
  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('records a session that left, with its final figures and why it left', () => {
    const history = new HqSessionHistory({ dataDir });
    history.observe(
      snap([session('s1'), session('s2', { hostname: 'DESK', projectId: 'p2' })]),
      T0,
    );
    history.noteEnded('s1', T0 + 1_000);
    history.observe(snap([]), T0 + 2_000);

    const [second, first] = history.recent();
    expect(first).toMatchObject({
      sessionId: 's1',
      outcome: 'ended',
      machineKey: 'host:lab-02',
      projectName: 'Datapipe',
      costUsd: 0.75,
      tokensIn: 1000,
      tokensOut: 200,
      toolCalls: 9,
      agents: 2,
      models: ['m-a', 'm-b'],
      endedAt: new Date(T0 + 2_000).toISOString(),
    });
    // s2 just stopped reporting: HQ lost it, which may be a crash.
    expect(second).toMatchObject({ sessionId: 's2', outcome: 'lost', machineKey: 'host:desk' });
    expect(history.recent({ projectId: 'p2' }).map((entry) => entry.sessionId)).toEqual(['s2']);
    expect(history.recent({ machineKey: 'host:lab-02' }).map((entry) => entry.sessionId)).toEqual([
      's1',
    ]);
  });

  it('keeps a still-open session out of the history', () => {
    const history = new HqSessionHistory({ dataDir });
    history.observe(snap([session('s1')]), T0);
    history.observe(snap([session('s1')]), T0 + 1);
    expect(history.recent()).toEqual([]);
  });

  it('survives a restart through session-history.jsonl', async () => {
    const first = new HqSessionHistory({ dataDir });
    first.observe(snap([session('s1')]), T0);
    first.observe(snap([]), T0 + 1);
    await first.drain();

    const second = new HqSessionHistory({ dataDir });
    await second.load();
    expect(second.recent().map((entry) => entry.sessionId)).toEqual(['s1']);
  });
});
