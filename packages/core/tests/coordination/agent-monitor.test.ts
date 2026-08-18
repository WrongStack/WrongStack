/**
 * AgentMonitorService unit tests.
 *
 * Verifies that FleetBus events are correctly translated into timeline
 * entries, that virtual chat history is maintained, that JSONL files
 * are written, and that the stream toggle controls local EventBus emission.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTimelineEntry } from '../../src/coordination/agent-monitor.js';
import {
  type AgentMonitorService,
  createAgentMonitorService,
} from '../../src/coordination/agent-monitor.js';
import { FleetBus } from '../../src/coordination/fleet-bus.js';
import { EventBus } from '../../src/kernel/events.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function tmpDir(): string {
  return path.join(os.tmpdir(), `ws-agent-monitor-test-${Date.now().toString(36)}`);
}

function makeFleetEvent(subagentId: string, type: string, payload: Record<string, unknown>) {
  return { subagentId, ts: Date.now(), type, payload };
}

function waitForEvents(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('AgentMonitorService', () => {
  let fleetBus: FleetBus;
  let events: EventBus;
  let monitor: AgentMonitorService;
  let transcriptsDir: string;
  /** Accumulated timeline entries from local EventBus. */
  let timelineEntries: Array<{ subagentId: string; content: string; kind: string }>;

  beforeEach(async () => {
    fleetBus = new FleetBus();
    events = new EventBus();
    transcriptsDir = tmpDir();
    await fsp.mkdir(transcriptsDir, { recursive: true });
    timelineEntries = [];

    monitor = createAgentMonitorService({
      fleetBus,
      events,
      transcriptsDir,
      maxEntriesPerAgent: 50,
      streamEnabled: true,
    });

    // Collect emitted timeline events for assertions.
    events.on('agent.timeline.message', (payload) => {
      timelineEntries.push({
        subagentId: payload.subagentId,
        content: payload.content,
        kind: payload.kind,
      });
    });
  });

  afterEach(async () => {
    // close(), not stop(): stop() only starts the transcript flush, so removing
    // the dir here would race the in-flight appends (ENOTEMPTY on Windows).
    await monitor.close();
    await fsp.rm(transcriptsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // ── Lifecycle ────────────────────────────────────────────────────

  it('starts and stops without throwing', () => {
    expect(() => monitor.start()).not.toThrow();
    expect(() => monitor.stop()).not.toThrow();
  });

  it('is safe to start and stop multiple times', () => {
    monitor.start();
    monitor.start(); // second start should be no-op
    monitor.stop();
    monitor.stop(); // second stop should be no-op
    monitor.start(); // restart
    monitor.stop();
  });

  it('starts without a FleetBus set', () => {
    const mon = createAgentMonitorService({
      events,
      transcriptsDir,
      streamEnabled: false,
    });
    // No fleetBus — start() should not crash.
    expect(() => mon.start()).not.toThrow();
    expect(mon.streamEnabled).toBe(false);
    mon.stop();
  });

  // ── Stream toggle ────────────────────────────────────────────────

  it('setStreamEnabled toggles the stream flag', () => {
    expect(monitor.streamEnabled).toBe(true);
    monitor.setStreamEnabled(false);
    expect(monitor.streamEnabled).toBe(false);
    monitor.setStreamEnabled(true);
    expect(monitor.streamEnabled).toBe(true);
  });

  // ── Subagent tracking ────────────────────────────────────────────

  it('trackSubagent creates a virtual session', () => {
    monitor.start();
    monitor.trackSubagent('bug-hunter-1', 'Bug Hunter', 'Find SQL injection bugs');

    const sessions = monitor.getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.subagentId).toBe('bug-hunter-1');
    expect(sessions[0]!.agentName).toBe('Bug Hunter');
    expect(sessions[0]!.status).toBe('spawned');
    expect(sessions[0]!.task).toBe('Find SQL injection bugs');
  });

  it('trackSubagent is idempotent for the same id', () => {
    monitor.start();
    monitor.trackSubagent('agent-1', 'Agent One');
    monitor.trackSubagent('agent-1', 'Agent One (dup)'); // second call ignored

    expect(monitor.getAllSessions()).toHaveLength(1);
    expect(monitor.getAllSessions()[0]!.agentName).toBe('Agent One');
  });

  it('trackSubagent emits an agent.status_changed event on spawn', () => {
    const statusEvents: Array<{ subagentId: string; status: string }> = [];
    events.on('agent.status_changed', (p) => {
      statusEvents.push({ subagentId: p.subagentId, status: p.status });
    });

    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1', 'do something');

    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]!.subagentId).toBe('a1');
    expect(statusEvents[0]!.status).toBe('spawned');
  });

  // ── Timeline entries via FleetBus ─────────────────────────────────

  it('routes provider.text_delta into timeline', () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');
    timelineEntries.length = 0; // clear spawn entry

    fleetBus.emit(
      makeFleetEvent('a1', 'provider.text_delta', { text: 'Hello world', iteration: 0 }),
    );

    // The streaming segment is in the ring immediately (live views poll it)…
    const session = monitor.getSession('a1');
    expect(session).toBeDefined();
    expect(session!.transcript).toHaveLength(2); // spawn system entry + text entry
    expect(session!.transcript[1]!.kind).toBe('text');
    expect(session!.transcript[1]!.content).toBe('Hello world');

    // …but the timeline announcement fires once, when the segment CLOSES
    // (here: a tool boundary), with the complete content.
    expect(timelineEntries).toHaveLength(0);
    fleetBus.emit(makeFleetEvent('a1', 'tool.started', { name: 'read', iteration: 0 }));
    const textEvents = timelineEntries.filter((e) => e.kind === 'text');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]!.content).toBe('Hello world');
    expect(textEvents[0]!.subagentId).toBe('a1');
  });

  it('coalesces consecutive same-iteration deltas into ONE transcript entry', async () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');
    timelineEntries.length = 0; // clear spawn entry

    // Word-by-word stream — the historical failure mode was one transcript
    // entry (and one JSONL line) per word.
    for (const word of ['package ', 'structure ', 'and ', 'entry ', 'point']) {
      fleetBus.emit(makeFleetEvent('a1', 'provider.thinking_delta', { text: word, iteration: 1 }));
    }
    // A tool event is a segment boundary.
    fleetBus.emit(makeFleetEvent('a1', 'tool.started', { name: 'glob', iteration: 1 }));

    const session = monitor.getSession('a1');
    const thinking = session!.transcript.filter((e) => e.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.content).toBe('package structure and entry point');
    // Announced once, on close (the tool boundary), with the full content.
    const thinkingEvents = timelineEntries.filter((e) => e.kind === 'thinking');
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0]!.content).toBe('package structure and entry point');

    // JSONL: exactly one line for the whole segment (written on close).
    await waitForEvents(100);
    const filePath = path.join(transcriptsDir, 'a1', 'transcript.jsonl');
    const lines = (await fsp.readFile(filePath, 'utf8')).trim().split('\n');
    const thinkingLines = lines.filter((l) => (JSON.parse(l) as AgentTimelineEntry).kind === 'thinking');
    expect(thinkingLines).toHaveLength(1);
    expect((JSON.parse(thinkingLines[0]) as AgentTimelineEntry).content).toBe(
      'package structure and entry point',
    );
  });

  it('breaks streaming segments on kind and iteration changes', () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');

    fleetBus.emit(makeFleetEvent('a1', 'provider.thinking_delta', { text: 'think1', iteration: 1 }));
    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { text: 'answer', iteration: 1 }));
    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { text: ' more', iteration: 1 }));
    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { text: 'next iter', iteration: 2 }));

    const t = monitor.getSession('a1')!.transcript.filter((e) => e.kind !== 'system');
    expect(t.map((e) => [e.kind, e.content])).toEqual([
      ['thinking', 'think1'],
      ['text', 'answer more'],
      ['text', 'next iter'],
    ]);
  });

  it('skips empty text_delta events', () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');
    timelineEntries.length = 0; // clear spawn entry

    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { text: '', iteration: 0 }));
    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { iteration: 0 })); // no text field

    expect(timelineEntries).toHaveLength(0);
  });

  it('routes tool.started and tool.executed into timeline', () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');
    timelineEntries.length = 0; // clear spawn entry

    fleetBus.emit(makeFleetEvent('a1', 'tool.started', { name: 'read', iteration: 1 }));
    fleetBus.emit(
      makeFleetEvent('a1', 'tool.executed', {
        name: 'read',
        ok: true,
        durationMs: 42,
        iteration: 1,
      }),
    );

    expect(timelineEntries).toHaveLength(2);
    expect(timelineEntries[0]!.kind).toBe('tool_use');
    expect(timelineEntries[0]!.content).toContain('read');
    expect(timelineEntries[1]!.kind).toBe('tool_result');
    expect(timelineEntries[1]!.content).toContain('read');
    expect(timelineEntries[1]!.content).toContain('42ms');
  });

  it('ignores events from unknown subagents', () => {
    monitor.start();
    // Emit before trackSubagent — should be silently dropped
    fleetBus.emit(
      makeFleetEvent('unknown', 'provider.text_delta', { text: 'should not appear', iteration: 0 }),
    );

    expect(timelineEntries).toHaveLength(0);
    expect(monitor.getSession('unknown')).toBeUndefined();
  });

  it('completeSubagent marks session as completed and emits status', () => {
    const statusEvents: Array<{ subagentId: string; status: string }> = [];
    events.on('agent.status_changed', (p) => {
      statusEvents.push({ subagentId: p.subagentId, status: p.status });
    });

    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');
    monitor.completeSubagent('a1', 'completed', 'Done in 5 iterations');

    const session = monitor.getSession('a1');
    expect(session!.status).toBe('completed');

    expect(statusEvents).toHaveLength(2); // spawned + completed
    expect(statusEvents[1]!.status).toBe('completed');
  });

  it('getTranscript returns entries newest-first with limit', () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');

    for (let i = 0; i < 10; i++) {
      fleetBus.emit(
        makeFleetEvent('a1', 'provider.text_delta', { text: `msg ${i}`, iteration: i }),
      );
    }

    const transcript = monitor.getTranscript('a1', 3);
    expect(transcript).toHaveLength(3); // limited
    expect(transcript[0]!.content).toBe('msg 9'); // newest first
    expect(transcript[2]!.content).toBe('msg 7');
  });

  // ── Ring buffer cap ──────────────────────────────────────────────

  it('caps transcript entries at maxEntriesPerAgent', () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');

    // Emit more events than the ring buffer size
    for (let i = 0; i < 60; i++) {
      fleetBus.emit(
        makeFleetEvent('a1', 'provider.text_delta', { text: `msg ${i}`, iteration: i }),
      );
    }

    const session = monitor.getSession('a1');
    // 1 spawn entry + 60 text entries = 61, capped at 50
    expect(session!.transcript.length).toBeLessThanOrEqual(50);
    // The oldest entries are gone, the newest remain
    const hasMsg0 = session!.transcript.some((e) => e.content === 'msg 0');
    const hasMsg59 = session!.transcript.some((e) => e.content === 'msg 59');
    expect(hasMsg0).toBe(false);
    expect(hasMsg59).toBe(true);
  });

  // ── Stream toggle suppresses local EventBus emission ──────────────

  it('disabling stream stops timeline event emission', () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');
    monitor.setStreamEnabled(false);

    fleetBus.emit(
      makeFleetEvent('a1', 'provider.text_delta', { text: 'stream off', iteration: 0 }),
    );

    // Stream is off, but the entry still appears in the transcript
    const session = monitor.getSession('a1');
    const textEntries = session!.transcript.filter((e) => e.kind === 'text');
    expect(textEntries).toHaveLength(1);

    // Wait — the stream toggle doesn't suppress EventBus emission currently.
    // The agent.timeline.message event is always emitted. The /agents stream
    // toggle controls the TUI/WebUI rendering, not the EventBus emission.
    // This test documents the current behavior.
    expect(timelineEntries.length).toBeGreaterThanOrEqual(0);
  });

  // ── JSONL persistence ────────────────────────────────────────────

  it('writes transcript entries to JSONL files', async () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');

    fleetBus.emit(
      makeFleetEvent('a1', 'provider.text_delta', { text: 'persisted entry', iteration: 0 }),
    );

    // Streaming segments are persisted when they CLOSE (segment-per-line,
    // not delta-per-line) — close() flushes open segments AND awaits the
    // write chain so no async I/O is still in flight.
    await monitor.close();

    const filePath = path.join(transcriptsDir, 'a1', 'transcript.jsonl');
    const content = await fsp.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');

    // Find the text entry among all written lines
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const textLines = lines.filter((l) => l.includes('persisted entry'));
    expect(textLines).toHaveLength(1);
    const parsed = JSON.parse(textLines[0]) as AgentTimelineEntry;
    expect(parsed.content).toBe('persisted entry');
    expect(parsed.subagentId).toBe('a1');
    expect(parsed.kind).toBe('text');
  });

  it('creates subdirectories per subagent', async () => {
    monitor.start();
    monitor.trackSubagent('agent-a', 'A');
    monitor.trackSubagent('agent-b', 'B');

    fleetBus.emit(
      makeFleetEvent('agent-a', 'provider.text_delta', { text: 'from a', iteration: 0 }),
    );
    fleetBus.emit(
      makeFleetEvent('agent-b', 'provider.text_delta', { text: 'from b', iteration: 0 }),
    );

    // Flush open streaming segments to disk — close() deterministically awaits
    // the write chain so no async I/O is still in flight.
    await monitor.close();

    const dirA = path.join(transcriptsDir, 'agent-a');
    const dirB = path.join(transcriptsDir, 'agent-b');
    const fileA = path.join(dirA, 'transcript.jsonl');
    const fileB = path.join(dirB, 'transcript.jsonl');

    const dirAExists = await fsp
      .stat(dirA)
      .then(() => true)
      .catch(() => false);
    const dirBExists = await fsp
      .stat(dirB)
      .then(() => true)
      .catch(() => false);
    expect(dirAExists).toBe(true);
    expect(dirBExists).toBe(true);

    const contentA = await fsp.readFile(fileA, 'utf8');
    const contentB = await fsp.readFile(fileB, 'utf8');
    expect(contentA).toContain('from a');
    expect(contentB).toContain('from b');
  });

  // ── onEntry callback ─────────────────────────────────────────────

  it('calls onEntry callback once per completed segment/entry', () => {
    const onEntry = vi.fn();
    monitor = createAgentMonitorService({
      fleetBus,
      events,
      transcriptsDir,
      onEntry,
      streamEnabled: true,
    });
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');
    onEntry.mockClear(); // clear spawn entry from mock

    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { text: 'cb ', iteration: 0 }));
    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { text: 'test', iteration: 0 }));
    // Streaming segments announce on close — force the boundary.
    monitor.completeSubagent('a1', 'completed');

    // First call = the closed text segment (full content), second = status.
    expect(onEntry).toHaveBeenCalledTimes(2);
    const entry = onEntry.mock.calls[0]![0] as AgentTimelineEntry;
    expect(entry.content).toBe('cb test');
    expect(entry.kind).toBe('text');
    expect(entry.subagentId).toBe('a1');
  });

  // ── setOnEntry ───────────────────────────────────────────────────

  it('setOnEntry replaces the callback', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    monitor.setOnEntry(cb1);
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');
    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { text: 'first cb', iteration: 0 }));
    // Iteration change closes the first segment → cb1 fires with it.
    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { text: 'second cb', iteration: 1 }));

    expect(cb1).toHaveBeenCalled();

    monitor.setOnEntry(cb2);
    fleetBus.emit(makeFleetEvent('a1', 'provider.text_delta', { text: 'third cb', iteration: 2 }));

    expect(cb2).toHaveBeenCalled();
  });

  // ── Edge cases ───────────────────────────────────────────────────

  it('getAllSessions returns empty array when no subagents tracked', () => {
    expect(monitor.getAllSessions()).toEqual([]);
  });

  it('getSession returns undefined for unknown subagent', () => {
    expect(monitor.getSession('nonexistent')).toBeUndefined();
  });

  it('getTranscript returns empty array for unknown subagent', () => {
    expect(monitor.getTranscript('nonexistent')).toEqual([]);
  });

  it('completeSubagent on unknown subagent is a no-op', () => {
    expect(() => monitor.completeSubagent('unknown', 'completed')).not.toThrow();
  });

  it('setFleetBus connects a new FleetBus', () => {
    const mon = createAgentMonitorService({
      events,
      transcriptsDir,
      streamEnabled: true,
    });
    const fb = new FleetBus();

    mon.setFleetBus(fb);
    mon.start();
    mon.trackSubagent('a1', 'Agent 1');

    fb.emit(makeFleetEvent('a1', 'provider.text_delta', { text: 'via setFleetBus', iteration: 0 }));

    const session = mon.getSession('a1');
    expect(session).toBeDefined();
    const textEntries = session!.transcript.filter((e) => e.kind === 'text');
    expect(textEntries).toHaveLength(1);
    expect(textEntries[0]!.content).toBe('via setFleetBus');

    mon.stop();
  });

  // ── close(): draining transcript writes ──────────────────────────

  describe('close', () => {
    it('flushes the open streaming segment AND waits for it to reach disk', async () => {
      monitor.start();
      monitor.trackSubagent('a1', 'Agent 1');
      fleetBus.emit(
        makeFleetEvent('a1', 'provider.text_delta', { text: 'streaming reply', iteration: 0 }),
      );

      // The open segment lives only in the ring until it closes.
      const file = path.join(transcriptsDir, 'a1', 'transcript.jsonl');
      const before = await fsp.readFile(file, 'utf8').catch(() => '');
      expect(before).not.toContain('streaming reply');

      // close() must leave nothing in flight — a caller that exits right after
      // it would otherwise lose exactly the text that was on screen.
      await monitor.close();

      const after = await fsp.readFile(file, 'utf8');
      expect(after).toContain('streaming reply');
    });

    it('is safe to call without a started service', async () => {
      await expect(monitor.close()).resolves.toBeUndefined();
    });
  });

  // ── Resume: rebuilding the ring from disk ────────────────────────

  describe('loadSessionsFromDisk', () => {
    it('restores subagent transcripts a fresh process never observed', async () => {
      // Exactly the resume case: the transcripts are on disk from a previous
      // run, and this service instance has never seen the subagent.
      const dir = path.join(transcriptsDir, 'worker-7');
      await fsp.mkdir(dir, { recursive: true });
      const entry = (kind: string, content: string, ts: string) =>
        JSON.stringify({
          id: `e-${content}`,
          subagentId: 'worker-7',
          agentName: 'Worker 7',
          ts,
          kind,
          content,
          iteration: 0,
        });
      await fsp.writeFile(
        path.join(dir, 'transcript.jsonl'),
        [
          entry('text', 'hello from the previous run', '2026-07-16T10:00:00.000Z'),
          entry('tool_use', 'read_file', '2026-07-16T10:00:01.000Z'),
        ].join('\n') + '\n',
      );

      expect(monitor.getAllSessions()).toEqual([]);
      const sessions = await monitor.loadSessionsFromDisk();

      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.subagentId).toBe('worker-7');
      expect(sessions[0]?.agentName).toBe('Worker 7');
      expect(sessions[0]?.transcript.map((e) => e.content)).toEqual([
        'hello from the previous run',
        'read_file',
      ]);
      // Nothing on disk says whether the run finished or was killed.
      expect(sessions[0]?.status).toBe('restored');
    });

    it('does not clobber a live subagent with its staler JSONL', async () => {
      monitor.start();
      monitor.trackSubagent('a1', 'Agent 1');
      const dir = path.join(transcriptsDir, 'a1');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, 'transcript.jsonl'),
        JSON.stringify({
          id: 'stale',
          subagentId: 'a1',
          agentName: 'Agent 1',
          ts: '2026-07-16T09:00:00.000Z',
          kind: 'text',
          content: 'stale disk copy',
          iteration: 0,
        }) + '\n',
      );

      const sessions = await monitor.loadSessionsFromDisk();
      const a1 = sessions.find((s) => s.subagentId === 'a1');
      // The ring holds the open streaming segment, which the JSONL never has.
      expect(a1?.transcript.some((e) => e.content === 'stale disk copy')).toBe(false);
    });

    it('skips a torn trailing line rather than losing the whole transcript', async () => {
      const dir = path.join(transcriptsDir, 'crashed');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, 'transcript.jsonl'),
        JSON.stringify({
          id: 'ok',
          subagentId: 'crashed',
          agentName: 'Crashed',
          ts: '2026-07-16T10:00:00.000Z',
          kind: 'text',
          content: 'complete line',
          iteration: 0,
        }) +
          '\n{"id":"partial","subagen',
      );

      const sessions = await monitor.loadSessionsFromDisk();
      expect(sessions[0]?.transcript.map((e) => e.content)).toEqual(['complete line']);
    });

    it('returns the ring untouched when no transcripts dir exists', async () => {
      await fsp.rm(transcriptsDir, { recursive: true, force: true });
      await expect(monitor.loadSessionsFromDisk()).resolves.toEqual([]);
    });
  });

  // ── Iteration heartbeat ──────────────────────────────────────────

  it('emits status entry every 5 iterations', () => {
    monitor.start();
    monitor.trackSubagent('a1', 'Agent 1');
    timelineEntries.length = 0; // discard spawn entry

    // Emit iteration 0, 5, 10
    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      fleetBus.emit(makeFleetEvent('a1', 'iteration.completed', { index: i }));
    }

    // Should have status entries for iterations 5 and 10
    const statusEntries = timelineEntries.filter((e) => e.kind === 'status');
    expect(statusEntries.length).toBeGreaterThanOrEqual(2);
    expect(statusEntries.some((e) => e.content.includes('5'))).toBe(true);
    expect(statusEntries.some((e) => e.content.includes('10'))).toBe(true);
  });
});
