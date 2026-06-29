import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  HqSessionEndedPayload,
  HqSessionSnapshotPayload,
  HqTranscriptAppendPayload,
} from '../../src/hq/protocol.js';
import type { HqPublisher } from '../../src/hq/publisher.js';
import { startSessionTelemetryBridge } from '../../src/hq/session-bridge.js';
import { EventBus } from '../../src/kernel/events.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

let globalRoot: string;
let projectRoot: string;

beforeEach(async () => {
  globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-bridge-global-'));
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-bridge-proj-'));
});

afterEach(async () => {
  await fs.rm(globalRoot, { recursive: true, force: true });
  await fs.rm(projectRoot, { recursive: true, force: true });
});

interface Calls {
  snapshots: HqSessionSnapshotPayload[];
  transcripts: HqTranscriptAppendPayload[];
  ended: HqSessionEndedPayload[];
}

function fakePublisher(calls: Calls): HqPublisher {
  return {
    identity: {
      clientId: 'c1',
      kind: 'tui',
      machineId: 'm1',
      hostname: 'box.local',
      pid: 7,
      startedAt: 't',
    },
    project: {
      projectId: 'p1',
      projectRoot,
      projectName: 'demo',
      machineId: 'm1',
      workspaceKind: 'git',
    },
    publishSessionSnapshot: (p: HqSessionSnapshotPayload) => {
      calls.snapshots.push(p);
      return {} as never;
    },
    publishTranscriptAppend: (p: HqTranscriptAppendPayload) => {
      calls.transcripts.push(p);
      return {} as never;
    },
    publishSessionEnded: (p: HqSessionEndedPayload) => {
      calls.ended.push(p);
      return {} as never;
    },
  } as unknown as HqPublisher;
}

async function writeSessionLog(sessionId: string, lines: object[]): Promise<void> {
  const paths = resolveWstackPaths({ projectRoot, globalRoot });
  const file = path.join(paths.projectSessions, `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('session telemetry bridge', () => {
  it('publishes initialAgents in the first snapshot', async () => {
    const sessionId = '2026-06-23/11-00-00Z_test_seed';
    await writeSessionLog(sessionId, []);

    const calls: Calls = { snapshots: [], transcripts: [], ended: [] };
    const dispose = startSessionTelemetryBridge({
      publisher: fakePublisher(calls),
      sessionId,
      projectRoot,
      projectName: 'demo',
      globalRoot,
      startedAt: '2026-06-23T11:00:00Z',
      snapshotIntervalMs: 10_000,
      transcriptIntervalMs: 10_000,
      initialAgents: [
        {
          id: 'leader',
          name: 'leader',
          status: 'streaming',
          iterations: 2,
          toolCalls: 1,
          model: 'openai/gpt-5',
          ctxPct: 33,
          partialText: 'working',
          lastActivityAt: '2026-06-23T11:01:00Z',
        },
      ],
    });

    expect(calls.snapshots[0]).toMatchObject({
      status: 'active',
      agentCount: 1,
      lastActivityAt: '2026-06-23T11:01:00Z',
      agents: [
        {
          id: 'leader',
          status: 'streaming',
          model: 'openai/gpt-5',
          ctxPct: 33,
          partialText: 'working',
        },
      ],
    });

    dispose();
  });

  it('publishes an initial snapshot, agent updates, transcript, and ended', async () => {
    const sessionId = '2026-06-23/sess_01JX2S9V7T5M6N7P8Q9R0STXVW';
    await writeSessionLog(sessionId, [
      { type: 'user_input', ts: '2026-06-23T12:00:01Z', content: 'hello' },
      {
        type: 'llm_response',
        ts: '2026-06-23T12:00:02Z',
        content: [{ type: 'text', text: 'hi there' }],
      },
    ]);

    const calls: Calls = { snapshots: [], transcripts: [], ended: [] };
    const events = new EventBus();
    const dispose = startSessionTelemetryBridge({
      publisher: fakePublisher(calls),
      events,
      sessionId,
      projectRoot,
      projectName: 'demo',
      globalRoot,
      gitBranch: 'main',
      snapshotIntervalMs: 10_000,
      transcriptIntervalMs: 20,
    });

    // Initial snapshot is synchronous on start.
    expect(calls.snapshots.length).toBeGreaterThanOrEqual(1);
    const first = calls.snapshots[0]!;
    expect(first.sessionId).toBe(sessionId);
    expect(first.machineId).toBe('m1');
    expect(first.clientKind).toBe('tui');
    expect(first.gitBranch).toBe('main');
    expect(first.status).toBe('idle');
    expect(first.agents).toHaveLength(0);

    // Agent state arrives on the bus → a new snapshot with active status.
    events.emit('session.agents_updated', {
      agents: [
        {
          id: 'leader',
          name: 'leader',
          startedAt: '2026-06-23T12:00:00Z',
          status: 'running',
          iterations: 1,
          toolCalls: 0,
          model: 'opus',
          ctxPct: 42,
          lastActivityAt: 't',
        },
      ],
    });
    const active = calls.snapshots[calls.snapshots.length - 1]!;
    expect(active.status).toBe('active');
    expect(active.agents).toHaveLength(1);
    expect(active.agents[0]).toMatchObject({
      id: 'leader',
      status: 'running',
      startedAt: '2026-06-23T12:00:00Z',
      model: 'opus',
      ctxPct: 42,
    });

    // Transcript is tailed from the JSONL on disk.
    await tick(60);
    const allEntries = calls.transcripts.flatMap((t) => t.entries);
    expect(allEntries.length).toBeGreaterThanOrEqual(2);
    expect(allEntries.find((e) => e.role === 'user')?.text).toBe('hello');
    expect(allEntries.find((e) => e.role === 'assistant')?.text).toBe('hi there');

    dispose();
    expect(calls.ended).toHaveLength(1);
    expect(calls.ended[0]!.sessionId).toBe(sessionId);
  });

  it('streams newly appended turns incrementally', async () => {
    const sessionId = '2026-06-23/13-00-00Z_test_bb22';
    await writeSessionLog(sessionId, [{ type: 'user_input', ts: 't1', content: 'first' }]);

    const calls: Calls = { snapshots: [], transcripts: [], ended: [] };
    const dispose = startSessionTelemetryBridge({
      publisher: fakePublisher(calls),
      sessionId,
      projectRoot,
      globalRoot,
      transcriptIntervalMs: 15,
    });

    await tick(50);
    const before = calls.transcripts.flatMap((t) => t.entries).length;
    expect(before).toBeGreaterThanOrEqual(1);

    // Append a new turn to the live log.
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const file = path.join(paths.projectSessions, `${sessionId}.jsonl`);
    await fs.appendFile(
      file,
      JSON.stringify({ type: 'user_input', ts: 't2', content: 'second' }) + '\n',
      'utf8',
    );

    await tick(60);
    const entries = calls.transcripts.flatMap((t) => t.entries);
    expect(entries.map((e) => e.text)).toContain('second');

    dispose();
  });
});
