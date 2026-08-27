import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveSessionAgents } from '../src/session-catalog/session-agents.js';
import { SessionCatalogStore } from '../src/session-catalog/store.js';
import { withAgentAttribution } from '../src/storage/session-agent-attribution.js';
import type { SessionEvent, SessionWriter } from '../src/types/session.js';

const ts = (n: number) => new Date(Date.UTC(2026, 7, 26, 12, n)).toISOString();

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-session-agents-'));
  tempRoots.push(root);
  return root;
}

describe('deriveSessionAgents', () => {
  it('merges a link that arrives before the spawn record', () => {
    // The real ordering: the subagent factory appends `agent_session_linked`
    // from inside coordinator.spawn(), and the fleet layer only appends
    // `agent_spawned` after that call returns.
    const [agent] = deriveSessionAgents([
      {
        type: 'agent_session_linked',
        ts: ts(1),
        agentId: 'helper-1',
        agentSessionId: '2026-08-26/sess_CHILD',
        transcriptPath: '/tmp/helper-1.jsonl',
        provider: 'anthropic',
        model: 'claude-opus-5',
      },
      { type: 'agent_spawned', ts: ts(2), agentId: 'helper-1', role: 'reviewer' },
    ] as SessionEvent[]);

    expect(agent).toMatchObject({
      agentId: 'helper-1',
      role: 'reviewer',
      agentSessionId: '2026-08-26/sess_CHILD',
      transcriptPath: '/tmp/helper-1.jsonl',
      provider: 'anthropic',
      model: 'claude-opus-5',
      status: 'running',
      // The earliest of the two stamps, not the last one seen.
      spawnedAt: ts(1),
    });
  });

  it('counts only interleaved work, never the agent lifecycle records', () => {
    const [agent] = deriveSessionAgents([
      { type: 'agent_spawned', ts: ts(1), agentId: 'sub', role: 'writer' },
      { type: 'tool_call_start', ts: ts(2), name: 'read', id: 't1', input: {}, agentId: 'sub' },
      { type: 'tool_result', ts: ts(3), id: 't1', content: 'x', isError: false, agentId: 'sub' },
      // The leader's own event carries no stamp and must not be attributed.
      { type: 'tool_call_start', ts: ts(4), name: 'bash', id: 't2', input: {} },
      { type: 'agent_stopped', ts: ts(5), agentId: 'sub', reason: 'completed' },
    ] as SessionEvent[]);

    expect(agent?.interleavedEventCount).toBe(2);
    expect(agent?.status).toBe('completed');
    expect(agent?.endedAt).toBe(ts(5));
  });

  it('keeps a recorded error as the outcome when a stop follows it', () => {
    const [agent] = deriveSessionAgents([
      { type: 'agent_spawned', ts: ts(1), agentId: 'sub', role: 'writer' },
      { type: 'agent_error', ts: ts(2), agentId: 'sub', error: 'provider refused' },
      { type: 'agent_stopped', ts: ts(3), agentId: 'sub' },
    ] as SessionEvent[]);

    expect(agent?.status).toBe('failed');
    expect(agent?.error).toBe('provider refused');
  });

  it('leaves an agent running when the journal was truncated mid-fleet', () => {
    const [agent] = deriveSessionAgents([
      { type: 'agent_spawned', ts: ts(1), agentId: 'sub', role: 'writer' },
    ] as SessionEvent[]);
    expect(agent?.status).toBe('running');
    expect(agent?.endedAt).toBeUndefined();
  });

  it('preserves spawn order', () => {
    const agents = deriveSessionAgents([
      { type: 'agent_spawned', ts: ts(1), agentId: 'a', role: 'r' },
      { type: 'agent_spawned', ts: ts(2), agentId: 'b', role: 'r' },
      { type: 'agent_stopped', ts: ts(3), agentId: 'a' },
    ] as SessionEvent[]);
    expect(agents.map((a) => a.agentId)).toEqual(['a', 'b']);
  });
});

describe('withAgentAttribution', () => {
  function recordingWriter(sink: SessionEvent[]): SessionWriter {
    return {
      id: 'leader',
      pendingToolUses: [],
      append: async (event: SessionEvent) => {
        sink.push(event);
      },
      appendBatch: async (events: SessionEvent[]) => {
        sink.push(...events);
      },
      flush: async () => {},
      close: async () => {},
      recordFileChange: () => {},
      recordSideEffect: () => {},
      writeCheckpoint: async () => {},
      writeFileSnapshot: async () => {},
      truncateToCheckpoint: async () => 0,
      clearSession: async () => {},
      writeInFlightMarker: async () => {},
      clearInFlightMarker: async () => {},
    } as unknown as SessionWriter;
  }

  it('stamps appends and batches', async () => {
    const sink: SessionEvent[] = [];
    const writer = withAgentAttribution(recordingWriter(sink), 'sub-7');
    await writer.append({ type: 'error', ts: ts(1), message: 'x', phase: 'tool' });
    await writer.appendBatch([{ type: 'error', ts: ts(2), message: 'y', phase: 'tool' }]);
    expect(sink.map((e) => e.agentId)).toEqual(['sub-7', 'sub-7']);
  });

  it('never overwrites a deeper agent stamp', async () => {
    const sink: SessionEvent[] = [];
    const writer = withAgentAttribution(recordingWriter(sink), 'outer');
    await writer.append({
      type: 'error',
      ts: ts(1),
      message: 'x',
      phase: 'tool',
      agentId: 'inner',
    });
    expect(sink[0]?.agentId).toBe('inner');
  });

  it('returns the writer untouched for an empty id', () => {
    const base = recordingWriter([]);
    expect(withAgentAttribution(base, '')).toBe(base);
  });
});

describe('SessionCatalogStore.listSessionAgents', () => {
  function seedSession(root: string, sessionId: string, events: SessionEvent[]): void {
    const [day, leaf] = sessionId.split('/');
    const dir = path.join(root, 'sessions', day!);
    fs.mkdirSync(dir, { recursive: true });
    const body = events.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(path.join(dir, `${leaf}.jsonl`), `${body}\n`, 'utf8');
  }

  it('derives the roster from the journal and re-derives when it grows', () => {
    const root = makeTempProject();
    const sessionId = '2026-08-26/sess_LEADER';
    seedSession(root, sessionId, [
      { type: 'session_start', ts: ts(0), id: sessionId, model: 'm', provider: 'p' },
      { type: 'agent_spawned', ts: ts(1), agentId: 'helper', role: 'reviewer' },
    ] as SessionEvent[]);

    const store = new SessionCatalogStore(root);
    try {
      store.rebuildCatalog();
      const first = store.listSessionAgents(sessionId);
      expect(first.map((a) => a.agentId)).toEqual(['helper']);
      expect(first[0]?.status).toBe('running');

      // A second call with an unchanged file must serve the cached rows and
      // still report the same roster.
      expect(store.listSessionAgents(sessionId)).toEqual(first);

      // Append a terminal record: size and mtime move, so the cache is stale
      // and the roster must follow the file rather than the memo.
      const file = path.join(root, 'sessions', '2026-08-26', 'sess_LEADER.jsonl');
      const stop = JSON.stringify({
        type: 'agent_stopped',
        ts: ts(9),
        agentId: 'helper',
        reason: 'completed',
      });
      fs.appendFileSync(file, `${stop}\n`, 'utf8');
      // mtime granularity can collapse two writes in the same tick; force the
      // difference so the test asserts invalidation, not filesystem timing.
      const later = new Date(Date.now() + 5_000);
      fs.utimesSync(file, later, later);

      expect(store.listSessionAgents(sessionId)[0]?.status).toBe('completed');
    } finally {
      store.close();
    }
  });

  it('returns an empty roster for an unknown session', () => {
    const root = makeTempProject();
    const store = new SessionCatalogStore(root);
    try {
      expect(store.listSessionAgents('2026-08-26/sess_NOPE')).toEqual([]);
    } finally {
      store.close();
    }
  });
});
