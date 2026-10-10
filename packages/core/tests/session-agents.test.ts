import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRuntimeDatabaseSync as loadTestDatabaseSync } from '@wrongstack/persistence';

const DatabaseSync = loadTestDatabaseSync();

import { gzipSync } from 'node:zlib';
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

  it('re-derives after a same-length journal rewrite with an unmoved mtime', () => {
    // Regression: the roster memo was keyed on (size, mtime) ONLY, so an
    // in-place rewrite to the SAME byte length whose mtime did not advance —
    // coarse timestamp granularity, or a rewind/repair/clear inside one tick —
    // served the OLD roster for a journal this projection is documented to
    // follow exactly ("a projection cannot drift"). 'alpha' and 'bravo' are the
    // same width, so the swap is invisible to a stat; the content hash is what
    // distinguishes them.
    const root = makeTempProject();
    const sessionId = '2026-08-26/sess_SAMELEN';
    const file = path.join(root, 'sessions', '2026-08-26', 'sess_SAMELEN.jsonl');
    const journal = (agentId: string): string => {
      const events = [
        { type: 'session_start', ts: ts(0), id: sessionId, model: 'm', provider: 'p' },
        { type: 'agent_spawned', ts: ts(1), agentId, role: 'reviewer' },
      ] as SessionEvent[];
      return `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
    };

    // Pin a WHOLE-SECOND mtime. fs.utimesSync takes float seconds and cannot
    // restore a raw stat.mtimeMs bit-exactly, so pinning a clean value is what
    // makes this assert content invalidation rather than filesystem timing.
    const PINNED_SECONDS = 1_700_000_000;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, journal('alpha'), 'utf8');
    fs.utimesSync(file, PINNED_SECONDS, PINNED_SECONDS);
    // The rewrite is genuinely the same length.
    expect(fs.statSync(file).size).toBe(Buffer.byteLength(journal('bravo'), 'utf8'));

    const store = new SessionCatalogStore(root);
    try {
      store.rebuildCatalog();
      expect(store.listSessionAgents(sessionId).map((a) => a.agentId)).toEqual(['alpha']);

      fs.writeFileSync(file, journal('bravo'), 'utf8');
      fs.utimesSync(file, PINNED_SECONDS, PINNED_SECONDS);
      expect(store.listSessionAgents(sessionId).map((a) => a.agentId)).toEqual(['bravo']);
    } finally {
      store.close();
    }
  });

  it('migrates a catalog written before transcript_content_hash existed', () => {
    // The index table is created with CREATE TABLE IF NOT EXISTS, which covers
    // a new TABLE but not a new COLUMN — a catalog from an older binary keeps
    // the four-column shape, so every read naming the hash column would throw
    // on open. Reopening must add it via the guarded ALTER and still serve the
    // roster (the NULL hash reads as "unknown" and forces one re-derive).
    const root = makeTempProject();
    const sessionId = '2026-08-26/sess_LEGACY';
    seedSession(root, sessionId, [
      { type: 'session_start', ts: ts(0), id: sessionId, model: 'm', provider: 'p' },
      { type: 'agent_spawned', ts: ts(1), agentId: 'helper', role: 'reviewer' },
    ] as SessionEvent[]);

    const first = new SessionCatalogStore(root);
    first.rebuildCatalog();
    first.listSessionAgents(sessionId);
    first.close();

    // Roll the table back to the pre-hash shape, as an older binary left it.
    const legacy = new DatabaseSync(path.join(root, 'sessions', 'catalog.sqlite'));
    legacy.exec('ALTER TABLE session_agent_index DROP COLUMN transcript_content_hash');
    legacy.close();

    const reopened = new SessionCatalogStore(root);
    try {
      reopened.rebuildCatalog();
      expect(reopened.listSessionAgents(sessionId).map((a) => a.agentId)).toEqual(['helper']);
    } finally {
      reopened.close();
    }
  });

  it('derives the roster from a cold (gzip) transcript instead of caching an empty one', () => {
    const root = makeTempProject();
    const sessionId = '2026-08-26/sess_COLD';
    const [day, leaf] = sessionId.split('/');
    const dir = path.join(root, 'sessions', day!);
    fs.mkdirSync(dir, { recursive: true });
    const journal = [
      { type: 'agent_spawned', ts: ts(1), agentId: 'helper', role: 'reviewer' },
      { type: 'tool_call', ts: ts(2), id: 'tc-1', agentId: 'helper', name: 'bash' },
      { type: 'agent_stopped', ts: ts(3), agentId: 'helper', reason: 'completed' },
    ] as SessionEvent[];
    fs.writeFileSync(
      path.join(dir, `${leaf}.jsonl.gz`),
      gzipSync(`${journal.map((e) => JSON.stringify(e)).join('\n')}\n`),
    );

    const store = new SessionCatalogStore(root);
    try {
      store.upsertSummary(
        {
          id: sessionId,
          title: 'archived fleet session',
          startedAt: ts(0),
          model: 'm',
          provider: 'p',
          tokenTotal: 5,
          lastActivityAt: ts(3),
        },
        `${sessionId}.jsonl.gz`,
        `${sessionId}.summary.json`,
        { storageState: 'cold', codec: 'gzip', archivedAt: null },
      );

      // Regression (bug-hunt round 3): the gz transcript was previously read as
      // utf8 text, every line failed JSON.parse, and the derived EMPTY roster was
      // cached (full-replace) — archived sessions reported "no agents" forever.
      const roster = store.listSessionAgents(sessionId);
      expect(roster.map((a) => a.agentId)).toEqual(['helper']);
      expect(roster[0]?.status).toBe('completed');
      expect(roster[0]?.interleavedEventCount).toBe(1);

      // The cached rows (gz size/mtime key) must serve the same roster.
      expect(store.listSessionAgents(sessionId)).toEqual(roster);
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
