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
      // Pin the clock just after the fixture's last activity so the agent is
      // fresh — this test pins pass-through of initialAgents, not staleness.
      now: () => '2026-06-23T11:01:05Z',
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

  it('downgrades stale busy agent statuses to idle in published snapshots', async () => {
    // Ghost-agent regression: a live publisher keeps republishing its
    // last-known agent list (keepalive tick, initialAgents after a resume).
    // If the terminal agents_updated event for a finished/crashed agent was
    // never observed, its status stayed `running` forever and the HQ topology
    // rendered it as active even though nothing was running.
    const sessionId = '2026-06-23/11-00-00Z_test_ghost';
    await writeSessionLog(sessionId, []);

    const calls: Calls = { snapshots: [], transcripts: [], ended: [] };
    const dispose = startSessionTelemetryBridge({
      publisher: fakePublisher(calls),
      sessionId,
      projectRoot,
      projectName: 'demo',
      globalRoot,
      startedAt: '2026-06-23T11:00:00Z',
      now: () => '2026-06-23T11:10:00Z', // 9 min after any fixture activity
      snapshotIntervalMs: 10_000,
      transcriptIntervalMs: 10_000,
      initialAgents: [
        {
          id: 'leader',
          name: 'leader',
          status: 'running',
          iterations: 5,
          toolCalls: 12,
          lastActivityAt: '2026-06-23T11:01:00Z', // stale: > 5 min before now
        },
        {
          id: 'worker-1',
          name: 'worker-1',
          status: 'streaming',
          iterations: 1,
          toolCalls: 0,
          lastActivityAt: '2026-06-23T11:09:30Z', // fresh: within the window
        },
        {
          id: 'worker-2',
          name: 'worker-2',
          status: 'waiting_user', // idle-ish BY DESIGN — never downgraded
          iterations: 2,
          toolCalls: 3,
          lastActivityAt: '2026-06-23T11:00:30Z', // stale
        },
        {
          id: 'worker-3',
          name: 'worker-3',
          status: 'error', // must stay visible — never downgraded
          iterations: 1,
          toolCalls: 1,
          lastActivityAt: '2026-06-23T11:00:20Z', // stale
        },
      ],
    });

    expect(calls.snapshots[0]).toMatchObject({
      status: 'active', // worker-1 is still genuinely busy
      agents: [
        { id: 'leader', status: 'idle' }, // stale busy → downgraded
        { id: 'worker-1', status: 'streaming' }, // fresh → untouched
        { id: 'worker-2', status: 'waiting_user' }, // preserved
        { id: 'worker-3', status: 'error' }, // preserved
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

  it('reads a large transcript delta in bounded blocks without losing entries', async () => {
    const sessionId = '2026-06-23/13-30-00Z_test_bounded_tail';
    const entries = Array.from({ length: 96 }, (_, i) => ({
      type: 'user_input',
      ts: `t${i}`,
      // Cross several 64 KiB read boundaries and include UTF-8 text to cover
      // a record and character split across block boundaries.
      content: `${i}: ${'x'.repeat(2_048)}é`,
    }));
    await writeSessionLog(sessionId, entries);

    const calls: Calls = { snapshots: [], transcripts: [], ended: [] };
    const dispose = startSessionTelemetryBridge({
      publisher: fakePublisher(calls),
      sessionId,
      projectRoot,
      globalRoot,
      transcriptIntervalMs: 10,
    });

    await tick(150);

    const published = calls.transcripts.flatMap((batch) => batch.entries);
    expect(published).toHaveLength(entries.length);
    expect(published.map((entry) => entry.text)).toEqual(entries.map((entry) => entry.content));

    dispose();
  });

  it('skips an oversized unterminated record and resumes at the next valid record', async () => {
    const sessionId = '2026-06-23/13-45-00Z_test_oversized_record';
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const file = path.join(paths.projectSessions, `${sessionId}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      `${JSON.stringify({ type: 'user_input', ts: 't0', content: 'before' })}\n${'x'.repeat(
        1_100_000,
      )}\n${JSON.stringify({ type: 'user_input', ts: 't1', content: 'recovered' })}\n`,
      'utf8',
    );

    const calls: Calls = { snapshots: [], transcripts: [], ended: [] };
    const dispose = startSessionTelemetryBridge({
      publisher: fakePublisher(calls),
      sessionId,
      projectRoot,
      globalRoot,
      transcriptIntervalMs: 10,
    });

    await tick(250);

    expect(calls.transcripts.flatMap((batch) => batch.entries).map((entry) => entry.text)).toEqual([
      'before',
      'recovered',
    ]);

    dispose();
  });

  it('chunks large initial transcript tails below the HQ websocket payload limit', async () => {
    const sessionId = '2026-06-23/14-00-00Z_test_chunks';
    await writeSessionLog(
      sessionId,
      Array.from({ length: 70 }, (_, i) => ({
        type: 'user_input',
        ts: `t${i}`,
        content: `message ${i}`,
      })),
    );

    const calls: Calls = { snapshots: [], transcripts: [], ended: [] };
    const dispose = startSessionTelemetryBridge({
      publisher: fakePublisher(calls),
      sessionId,
      projectRoot,
      globalRoot,
      transcriptIntervalMs: 20,
    });

    await tick(80);

    expect(calls.transcripts.length).toBeGreaterThan(1);
    expect(calls.transcripts.map((t) => t.fromSeq)).toEqual([0, 32, 64]);
    expect(calls.transcripts.map((t) => t.entries.length)).toEqual([32, 32, 6]);
    expect(calls.transcripts.flatMap((t) => t.entries)).toHaveLength(70);

    dispose();
  });
});
