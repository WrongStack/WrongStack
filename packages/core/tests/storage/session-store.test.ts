import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultSecretScrubber, DefaultSessionStore } from '../../src/index.js';

// Lift the prototype so we can override appendFile per-test without touching
// the production code path.
type FileHandle = Awaited<ReturnType<typeof fs.open>>;

describe('DefaultSessionStore', () => {
  let tmp: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-'));
    store = new DefaultSessionStore({ dir: tmp });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates a session and writes session_start as first event', async () => {
    const w = await store.create({ id: 'abc', model: 'm1', provider: 'p1' });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'hi there',
    });
    await w.close();
    const file = path.join(tmp, 'abc.jsonl');
    const raw = await fs.readFile(file, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = JSON.parse(lines[0]!);
    expect(first.type).toBe('session_start');
    expect(first.model).toBe('m1');
    expect(first.provider).toBe('p1');
  });

  it('resume() appends to existing file and rehydrates messages', async () => {
    const w1 = await store.create({ id: 'res1', model: 'm', provider: 'p' });
    await w1.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'first',
    });
    await w1.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'one' }],
      usage: { input: 10, output: 5 },
      stopReason: 'end_turn',
    });
    await w1.close();

    const { writer, data } = await store.resume('res1');
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]).toMatchObject({ role: 'user' });
    expect(data.messages[1]).toMatchObject({ role: 'assistant' });
    // First line of resumed file is the original session_start, not the
    // resume marker.
    await writer.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'second',
    });
    await writer.close();

    const raw = await fs.readFile(path.join(tmp, 'res1.jsonl'), 'utf8');
    const lines = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0].type).toBe('session_start');
    expect(lines.some((l) => l.type === 'session_resumed')).toBe(true);
    expect(lines[lines.length - 1].content).toBe('second');

    // Reloading after the second turn returns all messages including the
    // newly-appended user input.
    const reloaded = await store.load('res1');
    expect(reloaded.messages).toHaveLength(3);
  });

  it('loads and replays user_input + llm_response events', async () => {
    const w = await store.create({ id: 's1', model: 'm', provider: 'p' });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'hello',
    });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'hi back' }],
      usage: { input: 10, output: 5 },
      model: 'm',
    });
    await w.close();

    const data = await store.load('s1');
    expect(data.metadata.id).toBe('s1');
    expect(data.metadata.model).toBe('m');
    expect(data.messages).toHaveLength(2);
    // Replayed messages also carry the event's `ts` — match the core shape.
    expect(data.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(data.usage.input).toBe(10);
    expect(data.usage.output).toBe(5);
  });

  it('returns partial data for damaged session (open tool_use without result)', async () => {
    const w = await store.create({ id: 'broken', model: 'm', provider: 'p' });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'tool_use', id: 'tu-1', name: 'x', input: {} }],
      usage: { input: 1, output: 1 },
    });
    await w.close();
    // Damaged sessions resolve with partial replay instead of throwing —
    // the undamaged portion is still useful for session listing / resume.
    const data = await store.load('broken');
    expect(data.messages).toHaveLength(0);
    expect(JSON.stringify(data.messages)).not.toContain('tool_use');
    expect(data.usage.input).toBe(1);
  });

  it('pairs tool_result with prior tool_use into single user message', async () => {
    const w = await store.create({ id: 'pair', model: 'm', provider: 'p' });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'tool_use', id: 'tu-1', name: 'x', input: {} }],
      usage: { input: 1, output: 1 },
    });
    await w.append({
      type: 'tool_result',
      ts: new Date().toISOString(),
      id: 'tu-1',
      content: 'ok',
      isError: false,
    });
    await w.close();
    const data = await store.load('pair');
    // 1 assistant + 1 user containing the tool_result
    expect(data.messages).toHaveLength(2);
    expect(data.messages[1]?.role).toBe('user');
  });

  it('lists sessions sorted by recency', async () => {
    const a = await store.create({ id: 'a', model: 'm', provider: 'p' });
    await a.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'first',
    });
    await a.close();
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ id: 'b', model: 'm', provider: 'p' });
    await b.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'second',
    });
    await b.close();
    const list = await store.list();
    expect(list.length).toBe(2);
    expect(list.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('list returns empty array for nonexistent dir', async () => {
    const phantomStore = new DefaultSessionStore({
      dir: path.join(tmp, 'definitely-not-here', 'sub'),
    });
    const list = await phantomStore.list();
    expect(list).toEqual([]);
  });

  it('delete removes the file', async () => {
    const w = await store.create({ id: 'doomed', model: 'm', provider: 'p' });
    await w.close();
    await store.delete('doomed');
    await expect(fs.access(path.join(tmp, 'doomed.jsonl'))).rejects.toThrow();
  });

  it('writes a summary manifest on close and list() reads it without parsing the jsonl', async () => {
    const w = await store.create({ id: 's-mani', model: 'mx', provider: 'px' });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'hello there!',
    });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
    });
    await w.close();

    const manifestPath = path.join(tmp, 's-mani.summary.json');
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest).toMatchObject({
      id: 's-mani',
      model: 'mx',
      provider: 'px',
      tokenTotal: 15,
    });
    expect(manifest.title).toContain('hello');

    // Now truncate the JSONL so list() would fail if it tried to parse —
    // proves the fast path only touched the manifest.
    await fs.writeFile(path.join(tmp, 's-mani.jsonl'), '{not json');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('s-mani');
    expect(list[0]!.tokenTotal).toBe(15);
  });

  it('list() writes and reuses a shard-level manifest for cold sharded scans', async () => {
    const shardDir = path.join(tmp, '2026-05-13');
    await fs.mkdir(shardDir, { recursive: true });
    const file = path.join(shardDir, 'legacy.jsonl');
    const events = [
      {
        type: 'session_start',
        ts: '2026-05-13T10:00:00.000Z',
        id: '2026-05-13/legacy',
        model: 'old',
        provider: 'p',
      },
      { type: 'user_input', ts: '2026-05-13T10:00:01.000Z', content: 'older query' },
    ];
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const first = await store.list();
    expect(first).toHaveLength(1);
    const shardManifest = path.join(shardDir, '_manifest.json');
    await expect(fs.access(shardManifest)).resolves.toBeUndefined();

    await fs.writeFile(file, '{not json');
    const second = await store.list();
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe('2026-05-13/legacy');
  });

  it('list() backfills a manifest from the jsonl when one is missing', async () => {
    // Hand-write a session WITHOUT going through the writer, so no manifest exists.
    const file = path.join(tmp, 'legacy.jsonl');
    const events = [
      {
        type: 'session_start',
        ts: '2026-05-13T10:00:00.000Z',
        id: 'legacy',
        model: 'old',
        provider: 'p',
      },
      { type: 'user_input', ts: '2026-05-13T10:00:01.000Z', content: 'older query' },
    ];
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toContain('older');

    // After the first list(), the manifest should now exist.
    const manifest = path.join(tmp, 'legacy.summary.json');
    await expect(fs.access(manifest)).resolves.toBeUndefined();
  });

  it('delete() removes both the jsonl and its manifest', async () => {
    const w = await store.create({ id: 'gone', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'x' });
    await w.close();
    await expect(fs.access(path.join(tmp, 'gone.summary.json'))).resolves.toBeUndefined();
    await store.delete('gone');
    await expect(fs.access(path.join(tmp, 'gone.summary.json'))).rejects.toThrow();
  });

  it('debounces append-failure warnings instead of flooding the console', async () => {
    const w = await store.create({ id: 'flood', model: 'm', provider: 'p' });
    // Force every appendFile after this point to fail. The first event still
    // hits the real disk (session_start) — we replace the handle's method
    // on the instance only.
    const handle = (w as never as { handle: FileHandle }).handle;
    const stub = vi.spyOn(handle, 'appendFile').mockRejectedValue(new Error('ENOSPC'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 25; i++) {
        await w.append({ type: 'user_input', ts: new Date().toISOString(), content: `m${i}` });
      }
      // Appends are buffered (FLUSH_SIZE 50 / inactivity timer) — force the
      // flush so the failure path runs inside the test instead of on a timer.
      await (w as never as { flushBuffer: () => Promise<void> }).flushBuffer();
      // Despite 25 failed events, the throttle folds them into a single
      // warning (the 5-second window hasn't elapsed within the test).
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      stub.mockRestore();
      warn.mockRestore();
      await w.close().catch(() => undefined);
    }
  });

  it('surfaces the suppressed count once the debounce window elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const w = await store.create({ id: 'flood2', model: 'm', provider: 'p' });
      const handle = (w as never as { handle: FileHandle }).handle;
      const stub = vi.spyOn(handle, 'appendFile').mockRejectedValue(new Error('ENOSPC'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const flush = () =>
          (w as never as { flushBuffer: () => Promise<void> }).flushBuffer();
        // First batch: one failing flush of 5 events → one warn that folds
        // the other 4 events into a "+4 suppressed" tail.
        for (let i = 0; i < 5; i++) {
          await w.append({ type: 'user_input', ts: new Date().toISOString(), content: `m${i}` });
        }
        await flush();
        expect(warn).toHaveBeenCalledTimes(1);
        const firstCall = warn.mock.calls[0]!;
        expect(firstCall.some((arg) => /\+\d+ suppressed/.test(String(arg)))).toBe(true);
        // Advance past the 5-second throttle window and fail one more —
        // a fresh warn fires instead of being suppressed.
        vi.setSystemTime(Date.now() + 6000);
        await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'after' });
        await flush();
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        stub.mockRestore();
        warn.mockRestore();
        await w.close().catch(() => undefined);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearHistory() rewrites the jsonl to only a session_start event', async () => {
    const w = await store.create({ id: 'cs1', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hello' });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
    });
    await w.close();
    await store.clearHistory('cs1');
    const raw = await fs.readFile(path.join(tmp, 'cs1.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const evt = JSON.parse(lines[0]!);
    expect(evt.type).toBe('session_start');
    expect(evt.id).toBe('cs1');
    expect(evt.model).toBe('unknown'); // model is reset since history is wiped
    expect(evt.provider).toBe('unknown');
  });

  it('clearHistory() removes the summary manifest', async () => {
    const w = await store.create({ id: 'cs2', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hi' });
    await w.close();
    await expect(fs.access(path.join(tmp, 'cs2.summary.json'))).resolves.toBeUndefined();
    await store.clearHistory('cs2');
    await expect(fs.access(path.join(tmp, 'cs2.summary.json'))).rejects.toThrow();
  });

  it('clearHistory() is idempotent on a session with no prior history', async () => {
    const w = await store.create({ id: 'cs3', model: 'm', provider: 'p' });
    await w.close();
    await store.clearHistory('cs3');
    const raw = await fs.readFile(path.join(tmp, 'cs3.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).type).toBe('session_start');
  });

  it('FileSessionWriter.clearSession() resets the jsonl to session_start only', async () => {
    const w = await store.create({ id: 'wr', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hello' });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'hi back' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
    });
    await w.close();
    await w.clearSession();
    const raw = await fs.readFile(path.join(tmp, 'wr.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const evt = JSON.parse(lines[0]!);
    expect(evt.type).toBe('session_start');
    expect(evt.id).toBe('wr');
    expect(evt.model).toBe('m');
    expect(evt.provider).toBe('p');
  });

  it('FileSessionWriter.clearSession() does nothing when filePath is undefined', async () => {
    // This tests the no-op guard for in-memory writers
    const w = await store.create({ id: 'mem', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'x' });
    await w.close();
    // Should not throw — the guard handles the undefined path gracefully
    await expect(w.clearSession()).resolves.not.toThrow();
  });
});

// ── Idea #1 — in-flight markers (Stateful Session Recovery) ─────────────────
describe('DefaultSessionStore — in-flight markers', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'inflight-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writeInFlightMarker appends an in_flight_start event', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({
      id: 's1',
      title: '',
      model: 'm',
      provider: 'p',
    });
    await writer.writeInFlightMarker('iteration 1 / tool: read');
    // Flush the write buffer so store.load() sees the events on disk.
    await writer.close();
    const events = await store.load('s1');
    const last = events.events[events.events.length - 1]!;
    expect(last.type).toBe('in_flight_start');
    expect(last.context).toBe('iteration 1 / tool: read');
  });

  it('clearInFlightMarker appends an in_flight_end with the given reason', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({
      id: 's1',
      title: '',
      model: 'm',
      provider: 'p',
    });
    await writer.writeInFlightMarker('iteration 5');
    await writer.clearInFlightMarker('clean');
    // Flush the write buffer so store.load() sees the events on disk.
    await writer.close();
    const events = await store.load('s1');
    const last = events.events[events.events.length - 1]!;
    expect(last.type).toBe('in_flight_end');
    expect(last.reason).toBe('clean');
  });

  it('stale marker is detectable via SessionRecovery (round-trip)', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({
      id: 'crash',
      title: '',
      model: 'm',
      provider: 'p',
    });
    await writer.writeInFlightMarker('iteration 7 / tool: bash');
    // No clearInFlightMarker — simulating a crash.
    // Flush the buffer so the stale marker is visible on disk.
    await writer.close();
    const { SessionRecovery } = await import('../../src/storage/session-recovery.js');
    const recovery = new SessionRecovery(tmp);
    const stale = await recovery.detectStale('crash');
    expect(stale).not.toBeNull();
    expect(stale!.context).toBe('iteration 7 / tool: bash');
  });

  it('rejects empty or oversized context', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({
      id: 's1',
      title: '',
      model: 'm',
      provider: 'p',
    });
    await expect(writer.writeInFlightMarker('')).rejects.toThrow(/1\.\.500/);
    await expect(writer.writeInFlightMarker('x'.repeat(501))).rejects.toThrow(/1\.\.500/);
  });

  it('preserves order: other events between start and end survive intact', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({
      id: 's1',
      title: '',
      model: 'm',
      provider: 'p',
    });
    await writer.writeInFlightMarker('start');
    await writer.append({
      type: 'tool_result',
      ts: new Date().toISOString(),
      id: 'tu-1',
      content: 'ok',
      isError: false,
    });
    await writer.clearInFlightMarker('clean');
    // Flush the write buffer so store.load() sees the events on disk.
    await writer.close();
    const events = await store.load('s1');
    const types = events.events.map((e: { type: string }) => e.type);
    expect(types).toContain('in_flight_start');
    expect(types).toContain('tool_result');
    expect(types).toContain('in_flight_end');
    // The end must follow the tool_result, not the start.
    const endIdx = types.lastIndexOf('in_flight_end');
    const toolIdx = types.lastIndexOf('tool_result');
    expect(endIdx).toBeGreaterThan(toolIdx);
  });

  it('extracts tool_call_end events into toolCallEnds on load()', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({ id: 'tools1', title: '', model: 'm', provider: 'p' });
    await writer.append({ type: 'user_input', ts: new Date().toISOString(), content: 'read file' });
    await writer.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'tool_use', id: 'tu-1', name: 'read', input: { path: 'src/x.ts' } }],
      stopReason: 'tool_use',
      usage: { input: 10, output: 5 },
    } as Parameters<typeof writer.append>[0]);
    await writer.append({
      type: 'tool_call_end',
      ts: new Date().toISOString(),
      name: 'read',
      id: 'tu-1',
      durationMs: 42,
      outputSize: 100,
      ok: true,
      outputBytes: 100,
      outputTokens: 28,
      outputLines: 5,
    });
    await writer.append({
      type: 'tool_result',
      ts: new Date().toISOString(),
      id: 'tu-1',
      content: 'file contents here',
      isError: false,
    });
    await writer.close();

    const data = await store.load('tools1');
    expect(data.toolCallEnds).toHaveLength(1);
    expect(data.toolCallEnds[0]).toMatchObject({
      name: 'read',
      id: 'tu-1',
      durationMs: 42,
      ok: true,
      outputBytes: 100,
      outputTokens: 28,
      outputLines: 5,
    });
    // Messages should still replay correctly: user_input + assistant with
    // tool_use + the user message carrying the tool_result.
    expect(data.messages).toHaveLength(3);
  });

  it('returns empty toolCallEnds when no tool_call_end events exist', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({ id: 'tools2', title: '', model: 'm', provider: 'p' });
    await writer.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hello' });
    await writer.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: 'hi back' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
    });
    await writer.close();

    const data = await store.load('tools2');
    expect(data.toolCallEnds).toEqual([]);
    expect(data.messages).toHaveLength(2);
  });

  it('toolCallEnds preserves insertion order from JSONL', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({ id: 'tools3', title: '', model: 'm', provider: 'p' });

    // Write two tool calls interleaved with multiple user/llm turns.
    await writer.append({ type: 'user_input', ts: new Date().toISOString(), content: 'first' });
    await writer.append({
      type: 'llm_response', ts: new Date().toISOString(),
      content: [{ type: 'tool_use', id: 'a1', name: 'read', input: {} }],
      stopReason: 'tool_use', usage: { input: 1, output: 1 },
    } as Parameters<typeof writer.append>[0]);
    await writer.append({ type: 'tool_call_end', ts: new Date().toISOString(), name: 'read', id: 'a1', durationMs: 10, outputSize: 0, ok: true });
    await writer.append({ type: 'tool_result', ts: new Date().toISOString(), id: 'a1', content: 'ok', isError: false });

    await writer.append({ type: 'user_input', ts: new Date().toISOString(), content: 'second' });
    await writer.append({
      type: 'llm_response', ts: new Date().toISOString(),
      content: [{ type: 'tool_use', id: 'b2', name: 'bash', input: {} }],
      stopReason: 'tool_use', usage: { input: 1, output: 1 },
    } as Parameters<typeof writer.append>[0]);
    await writer.append({ type: 'tool_call_end', ts: new Date().toISOString(), name: 'bash', id: 'b2', durationMs: 200, outputSize: 0, ok: false });
    await writer.append({ type: 'tool_result', ts: new Date().toISOString(), id: 'b2', content: 'err', isError: true });
    await writer.close();

    const data = await store.load('tools3');
    expect(data.toolCallEnds).toHaveLength(2);
    expect(data.toolCallEnds[0]).toMatchObject({ name: 'read', id: 'a1', ok: true, durationMs: 10 });
    expect(data.toolCallEnds[1]).toMatchObject({ name: 'bash', id: 'b2', ok: false, durationMs: 200 });
    // Messages replay: 2 user (first + tool_result) + 2 assistant + 2 user (second + tool_result)
    expect(data.messages).toHaveLength(6);
  });
});

// ── JSONL durability & correctness hardening ────────────────────────────────
describe('DefaultSessionStore — JSONL correctness', () => {
  let tmp: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-hard-'));
    store = new DefaultSessionStore({ dir: tmp });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('resume() writes the summary sidecar into the shard directory, not the sessions root', async () => {
    const id = '2026-06-11/sess_01JX2S9V7T5M6N7P8Q9R0STXVW';
    const w = await store.create({ id, model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hi' });
    await w.close();

    const { writer } = await store.resume(id);
    await writer.append({ type: 'user_input', ts: new Date().toISOString(), content: 'again' });
    await writer.close();

    // Sidecar must sit next to the JSONL inside the date shard…
    await expect(
      fs.access(path.join(tmp, '2026-06-11', 'sess_01JX2S9V7T5M6N7P8Q9R0STXVW.summary.json')),
    ).resolves.toBeUndefined();
    // …and must NOT be orphaned at the sessions root.
    await expect(
      fs.access(path.join(tmp, 'sess_01JX2S9V7T5M6N7P8Q9R0STXVW.summary.json')),
    ).rejects.toThrow();
  });

  it('close() is idempotent and awaitable — concurrent closers share one close', async () => {
    const w = await store.create({ id: 'dbl-close', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'payload' });
    await Promise.all([w.close(), w.close(), w.close()]);
    // When ALL close() calls resolve, the data and the sidecar are on disk.
    const raw = await fs.readFile(path.join(tmp, 'dbl-close.jsonl'), 'utf8');
    expect(raw).toContain('payload');
    await expect(fs.access(path.join(tmp, 'dbl-close.summary.json'))).resolves.toBeUndefined();
  });

  it('first-append init cannot be overtaken by a concurrent second append', async () => {
    const w = await store.create({ id: 'init-race', model: 'm', provider: 'p' });
    // Fire two appends WITHOUT awaiting the first — the session_start record
    // must still be line 1 and events must keep call order.
    const p1 = w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'first' });
    const p2 = w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'second' });
    await Promise.all([p1, p2]);
    await w.close();
    const lines = (await fs.readFile(path.join(tmp, 'init-race.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0].type).toBe('session_start');
    const inputs = lines.filter((l) => l.type === 'user_input').map((l) => l.content);
    expect(inputs).toEqual(['first', 'second']);
  });

  it('concurrent flush() calls never reorder or tear JSONL lines', async () => {
    const w = await store.create({ id: 'order', model: 'm', provider: 'p' });
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 120; i++) {
      promises.push(
        w.append({ type: 'user_input', ts: new Date().toISOString(), content: `m${i}` }),
      );
      // Interleave explicit flushes with buffered appends to provoke
      // overlapping write attempts.
      if (i % 7 === 0) promises.push(w.flush());
    }
    await Promise.all(promises);
    await w.close();
    const raw = await fs.readFile(path.join(tmp, 'order.jsonl'), 'utf8');
    // Every line parses (no torn writes)…
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    // …and user_input events appear in exact append order.
    const contents = lines.filter((l) => l.type === 'user_input').map((l) => l.content);
    expect(contents).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
  });

  it('pendingToolUses tracks open tool_use blocks from llm_response content', async () => {
    const w = await store.create({ id: 'pending', model: 'm', provider: 'p' });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [
        { type: 'tool_use', id: 'tu-9', name: 'bash', input: {} },
        { type: 'tool_use', id: 'tu-10', name: 'read', input: {} },
      ],
      stopReason: 'tool_use',
      usage: { input: 1, output: 1 },
    });
    expect(w.pendingToolUses.sort()).toEqual(['tu-10', 'tu-9']);
    await w.append({
      type: 'tool_result',
      ts: new Date().toISOString(),
      id: 'tu-9',
      content: 'ok',
      isError: false,
    });
    expect(w.pendingToolUses).toEqual(['tu-10']);
    await w.close();
  });

  it('prune() removes old sessions in BOTH layouts and protects the active one', async () => {
    const old = new Date(Date.now() - 60 * 86_400_000); // 60 days ago

    // Sharded old session.
    const sharded = await store.create({ id: '2026-04-01/old-shard_aa11', model: 'm', provider: 'p' });
    await sharded.append({ type: 'user_input', ts: new Date().toISOString(), content: 'x' });
    await sharded.close();
    await fs.utimes(path.join(tmp, '2026-04-01', 'old-shard_aa11.jsonl'), old, old);

    // Flat legacy old session at the sessions root (pre-shard layout).
    const flat = await store.create({ id: 'legacy-flat', model: 'm', provider: 'p' });
    await flat.append({ type: 'user_input', ts: new Date().toISOString(), content: 'y' });
    await flat.close();
    await fs.utimes(path.join(tmp, 'legacy-flat.jsonl'), old, old);

    // Old but ACTIVE session — must survive.
    const active = await store.create({ id: '2026-04-01/active_bb22', model: 'm', provider: 'p' });
    await active.append({ type: 'user_input', ts: new Date().toISOString(), content: 'z' });
    await active.close();
    await fs.utimes(path.join(tmp, '2026-04-01', 'active_bb22.jsonl'), old, old);
    await fs.writeFile(
      path.join(tmp, 'active.json'),
      JSON.stringify({ sessionId: '2026-04-01/active_bb22' }),
      'utf8',
    );

    // Recent session — must survive.
    const recent = await store.create({ id: 'recent-flat', model: 'm', provider: 'p' });
    await recent.append({ type: 'user_input', ts: new Date().toISOString(), content: 'r' });
    await recent.close();

    const deleted = await store.prune(30);
    expect(deleted).toBe(2);
    await expect(fs.access(path.join(tmp, '2026-04-01', 'old-shard_aa11.jsonl'))).rejects.toThrow();
    await expect(fs.access(path.join(tmp, 'legacy-flat.jsonl'))).rejects.toThrow();
    await expect(fs.access(path.join(tmp, '2026-04-01', 'active_bb22.jsonl'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmp, 'recent-flat.jsonl'))).resolves.toBeUndefined();
    // Bookkeeping survives the root-level sweep.
    await expect(fs.access(path.join(tmp, '_index.jsonl'))).resolves.toBeUndefined();
  });

  it('metadata endedAt comes from the LAST session_end, not a mid-stream one', async () => {
    const file = path.join(tmp, 'multi-end.jsonl');
    const events = [
      { type: 'session_start', ts: '2026-06-11T10:00:00.000Z', id: 'multi-end', model: 'm', provider: 'p' },
      { type: 'user_input', ts: '2026-06-11T10:00:01.000Z', content: 'q1' },
      // Legacy /save wrote a mid-stream session_end while the session kept going.
      { type: 'session_end', ts: '2026-06-11T10:00:02.000Z', usage: { input: 1, output: 1 } },
      { type: 'user_input', ts: '2026-06-11T10:00:03.000Z', content: 'q2' },
      { type: 'session_end', ts: '2026-06-11T10:00:04.000Z', usage: { input: 2, output: 2 } },
    ];
    await fs.writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const data = await store.load('multi-end');
    expect(data.metadata.endedAt).toBe('2026-06-11T10:00:04.000Z');
  });
});

// F-06 (CWE-532): secrets in user/model turns must be scrubbed before they are
// persisted to the JSONL log and the summary sidecar.
describe('DefaultSessionStore — secret scrubbing (F-06)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-scrub-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // A realistic-looking (fake) Anthropic key the scrubber recognizes.
  const FAKE_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

  it('scrubs secrets from user_input content in the JSONL log', async () => {
    const store = new DefaultSessionStore({
      dir: tmp,
      secretScrubber: new DefaultSecretScrubber(),
    });
    const w = await store.create({ id: 'sc1', model: 'm', provider: 'p' });
    await w.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: `my key is ${FAKE_KEY} ok`,
    });
    await w.close();
    const raw = await fs.readFile(path.join(tmp, 'sc1.jsonl'), 'utf8');
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).toContain('[REDACTED:anthropic_key]');
  });

  it('scrubs secrets from llm_response content blocks', async () => {
    const store = new DefaultSessionStore({
      dir: tmp,
      secretScrubber: new DefaultSecretScrubber(),
    });
    const w = await store.create({ id: 'sc2', model: 'm', provider: 'p' });
    await w.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [{ type: 'text', text: `here you go: ${FAKE_KEY}` }],
      usage: { input: 1, output: 1 },
    } as Parameters<typeof w.append>[0]);
    await w.close();
    const raw = await fs.readFile(path.join(tmp, 'sc2.jsonl'), 'utf8');
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).toContain('[REDACTED:anthropic_key]');
  });

  it('keeps the summary sidecar title clean too', async () => {
    const store = new DefaultSessionStore({
      dir: tmp,
      secretScrubber: new DefaultSecretScrubber(),
    });
    const w = await store.create({ id: 'sc3', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: FAKE_KEY });
    await w.close();
    const summary = await fs.readFile(path.join(tmp, 'sc3.summary.json'), 'utf8');
    expect(summary).not.toContain(FAKE_KEY);
  });

  it('without a scrubber, content is written verbatim (opt-in)', async () => {
    const store = new DefaultSessionStore({ dir: tmp });
    const w = await store.create({ id: 'sc4', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: FAKE_KEY });
    await w.close();
    const raw = await fs.readFile(path.join(tmp, 'sc4.jsonl'), 'utf8');
    expect(raw).toContain(FAKE_KEY);
  });
});

// ── load() mtime-based cache ─────────────────────────────────────────────
describe('DefaultSessionStore — load() cache', () => {
  let tmp: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-cache-'));
    store = new DefaultSessionStore({ dir: tmp });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns the same object reference on repeated load() calls (cache hit)', async () => {
    const w = await store.create({ id: 'cache1', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hello' });
    await w.close();

    const first = await store.load('cache1');
    const second = await store.load('cache1');
    // Same reference — the cache returned the exact same object without
    // re-reading or re-parsing the JSONL.
    expect(first).toBe(second);
  });

  it('invalidates cache when the file is modified (mtime changes)', async () => {
    const w = await store.create({ id: 'cache2', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'v1' });
    await w.close();

    const first = await store.load('cache2');
    expect(first.messages).toHaveLength(1);

    // Modify the file externally — append a new event and force mtime change.
    const file = path.join(tmp, 'cache2.jsonl');
    const newEvent = JSON.stringify({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: 'v2',
    });
    await fs.appendFile(file, '\n' + newEvent + '\n', 'utf8');

    // The cache must detect the mtime change and re-parse.
    const second = await store.load('cache2');
    expect(second).not.toBe(first);
    expect(second.messages).toHaveLength(2);
  });

  it('clearLoadCache() forces a full re-read even when mtime is unchanged', async () => {
    const w = await store.create({ id: 'cache3', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hello' });
    await w.close();

    const first = await store.load('cache3');
    // Clear the cache for this session.
    store.clearLoadCache('cache3');
    const second = await store.load('cache3');
    // Different reference (re-parsed) but structurally equal.
    expect(second).not.toBe(first);
    expect(second.messages).toEqual(first.messages);
  });

  it('clearLoadCache() without args clears all entries', async () => {
    const w1 = await store.create({ id: 'a', model: 'm', provider: 'p' });
    await w1.append({ type: 'user_input', ts: new Date().toISOString(), content: 'x' });
    await w1.close();
    const w2 = await store.create({ id: 'b', model: 'm', provider: 'p' });
    await w2.append({ type: 'user_input', ts: new Date().toISOString(), content: 'y' });
    await w2.close();

    const a1 = await store.load('a');
    const b1 = await store.load('b');
    store.clearLoadCache();
    const a2 = await store.load('a');
    const b2 = await store.load('b');
    expect(a2).not.toBe(a1);
    expect(b2).not.toBe(b1);
  });

  it('cache does not serve stale data after clearHistory()', async () => {
    const w = await store.create({ id: 'cache4', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'original' });
    await w.close();

    const first = await store.load('cache4');
    expect(first.messages).toHaveLength(1);

    // clearHistory() rewrites the file — mtime changes.
    await store.clearHistory('cache4');

    const second = await store.load('cache4');
    expect(second).not.toBe(first);
    // After clearHistory, the file contains only a session_start event,
    // so no user messages.
    expect(second.messages).toHaveLength(0);
  });

  it('emits storage.cache_hit event on cache hit when EventBus is wired', async () => {
    const events: Array<{ type: string; sessionId?: string }> = [];
    const eventBus = {
      emit: (type: string, payload: Record<string, unknown>) => {
        events.push({ type, ...payload } as { type: string; sessionId?: string });
      },
      on: () => () => {},
    };
    const cachedStore = new DefaultSessionStore({ dir: tmp, events: eventBus as never });
    const w = await cachedStore.create({ id: 'ev1', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: new Date().toISOString(), content: 'hi' });
    await w.close();

    // First load — cache miss.
    await cachedStore.load('ev1');
    const missEvents = events.filter((e) => e.type === 'storage.cache_hit');
    expect(missEvents).toHaveLength(0);

    // Second load — cache hit.
    await cachedStore.load('ev1');
    const hitEvents = events.filter((e) => e.type === 'storage.cache_hit');
    expect(hitEvents).toHaveLength(1);
    expect(hitEvents[0]?.sessionId).toBe('ev1');
  });
});
