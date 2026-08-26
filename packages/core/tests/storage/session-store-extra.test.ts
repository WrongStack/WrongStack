import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultSecretScrubber, DefaultSessionStore, EventBus } from '../../src/index.js';
import { SessionRecovery } from '../../src/storage/session-recovery.js';
import type { SessionEvent } from '../../src/types/session.js';

let tmp: string;
let store: DefaultSessionStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-extra-'));
  store = new DefaultSessionStore({ dir: tmp });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

const now = () => new Date().toISOString();
const hash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

describe('FileSessionWriter — transcriptPath / file snapshots / checkpoints', () => {
  it('exposes the transcript path', async () => {
    const w = await store.create({ id: 'tp', model: 'm', provider: 'p' });
    expect(w.transcriptPath).toBe(path.join(tmp, 'tp.jsonl'));
    await w.close();
  });

  it('records pending file changes and flushes them on writeCheckpoint', async () => {
    const w = await store.create({ id: 'fc', model: 'm', provider: 'p' });
    w.recordFileChange({ path: 'a.ts', action: 'modified', before: 'x', after: 'y' });
    w.recordFileChange({ path: 'b.ts', action: 'created', before: null, after: 'new' });
    await w.writeCheckpoint(0, 'preview text');
    await w.close();
    const raw = await fs.readFile(path.join(tmp, 'fc.jsonl'), 'utf8');
    const types = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).type);
    expect(types).toContain('file_snapshot');
    expect(types).toContain('checkpoint');
  });

  it('attaches a content-addressed workspace manifest to checkpoint events', async () => {
    const events = new EventBus();
    const checkpointWritten = vi.fn();
    events.on('checkpoint.written', checkpointWritten);
    store = new DefaultSessionStore({ dir: tmp, events });
    const w = await store.create({ id: 'workspace-cp', model: 'm', provider: 'p' });
    const workspaceCheckpoint = {
      manifestHash: 'a'.repeat(64),
      baseHead: 'b'.repeat(40),
      entryCount: 2,
      unresolvedCount: 0,
      capturedAt: now(),
      coverage: 'git-head-plus-dirty' as const,
    };
    const capture = vi.fn().mockResolvedValue(workspaceCheckpoint);
    (w as never as { checkpointCas: { capture: typeof capture } }).checkpointCas = { capture };
    await w.writeCheckpoint(4, 'workspace state');
    await w.close();

    const data = await store.load('workspace-cp');
    expect(capture).toHaveBeenCalledWith('workspace-cp', 4);
    expect(data.events).toContainEqual(
      expect.objectContaining({
        type: 'checkpoint',
        promptIndex: 4,
        workspaceCheckpoint,
      }),
    );
    expect(checkpointWritten).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'workspace-cp',
        promptIndex: 4,
        workspaceCheckpoint,
      }),
    );
  });

  it('journals file changes during an active prompt without waiting for the next prompt', async () => {
    const w = await store.create({ id: 'fc-active', model: 'm', provider: 'p' });
    await w.writeCheckpoint(0, 'active prompt');
    w.recordFileChange({ path: 'a.ts', action: 'modified', before: 'x', after: 'y' });
    await w.flush();

    const data = await store.load('fc-active');
    expect(data.events).toContainEqual(
      expect.objectContaining({
        type: 'file_snapshot',
        promptIndex: 0,
        files: [{ path: 'a.ts', action: 'modified', before: 'x', after: 'y' }],
      }),
    );
    await w.close();
  });

  it('journals file observations without waiting for writer close', async () => {
    const w = await store.create({ id: 'observed', model: 'm', provider: 'p' });
    w.recordFileObservation?.({
      path: path.join(tmp, 'a.ts'),
      hash: hash('const a = 1;'),
      mtimeMs: 123,
      source: 'user',
    });
    await w.flush();

    const data = await store.load('observed');
    expect(data.events).toContainEqual(
      expect.objectContaining({
        type: 'file_observation',
        path: path.join(tmp, 'a.ts'),
        hash: hash('const a = 1;'),
        source: 'user',
      }),
    );
    await w.close();
  });

  it('writeFileSnapshot appends a file_snapshot event directly', async () => {
    const w = await store.create({ id: 'fs', model: 'm', provider: 'p' });
    await w.writeFileSnapshot(1, [{ path: 'z.ts', action: 'deleted', before: 'old', after: null }]);
    await w.close();
    const data = await store.load('fs');
    expect(data.events.some((e) => e.type === 'file_snapshot')).toBe(true);
  });
});

describe('DefaultSessionStore — resume file validation', () => {
  it('injects an ephemeral system warning when an observed file changed', async () => {
    const sessions = path.join(tmp, 'sessions');
    const projectStore = new DefaultSessionStore({ dir: sessions, projectRoot: tmp });
    const file = path.join(tmp, 'src.ts');
    await fs.writeFile(file, 'before', 'utf8');
    const stat = await fs.stat(file);
    const w = await projectStore.create({ id: 'stale', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'inspect src.ts' });
    w.recordFileObservation?.({
      path: file,
      hash: hash('before'),
      mtimeMs: stat.mtimeMs,
      source: 'user',
    });
    await w.close();
    await fs.writeFile(file, 'after', 'utf8');

    const resumed = await projectStore.resume('stale');
    expect(resumed.data.resumeValidation).toMatchObject({
      checkedFileCount: 1,
      staleFiles: [{ path: file, status: 'modified', expectedHash: hash('before') }],
    });
    expect(resumed.data.messages.at(-1)).toMatchObject({
      role: 'system',
      content: expect.stringContaining('Prior tool results and reasoning'),
    });
    await resumed.writer.close();

    // The notice belongs to this resume boundary only; it is not replayed or
    // appended to the JSONL on subsequent ordinary loads.
    const loaded = await projectStore.load('stale');
    expect(loaded.messages.some((message) => message.role === 'system')).toBe(false);
  });

  it('does not inject a warning when the latest observed hash still matches', async () => {
    const sessions = path.join(tmp, 'sessions');
    const projectStore = new DefaultSessionStore({ dir: sessions, projectRoot: tmp });
    const file = path.join(tmp, 'same.ts');
    await fs.writeFile(file, 'current', 'utf8');
    const stat = await fs.stat(file);
    const w = await projectStore.create({ id: 'fresh', model: 'm', provider: 'p' });
    w.recordFileObservation?.({
      path: file,
      hash: hash('old'),
      mtimeMs: stat.mtimeMs - 1,
      source: 'user',
    });
    w.recordFileObservation?.({
      path: file,
      hash: hash('current'),
      mtimeMs: stat.mtimeMs,
      source: 'write',
    });
    await w.close();

    const resumed = await projectStore.resume('fresh');
    expect(resumed.data.resumeValidation).toMatchObject({
      checkedFileCount: 1,
      staleFiles: [],
    });
    expect(resumed.data.messages.some((message) => message.role === 'system')).toBe(false);
    await resumed.writer.close();
  });

  it('marks deleted and out-of-project observations as stale without reading outside the root', async () => {
    const sessions = path.join(tmp, 'sessions');
    const projectStore = new DefaultSessionStore({ dir: sessions, projectRoot: tmp });
    const deleted = path.join(tmp, 'deleted.ts');
    const outside = path.join(path.dirname(tmp), 'outside.ts');
    const w = await projectStore.create({ id: 'unavailable', model: 'm', provider: 'p' });
    w.recordFileObservation?.({
      path: deleted,
      hash: hash('gone'),
      mtimeMs: 1,
      source: 'user',
    });
    w.recordFileObservation?.({
      path: outside,
      hash: hash('outside'),
      mtimeMs: 1,
      source: 'user',
    });
    await w.close();

    const resumed = await projectStore.resume('unavailable');
    expect(resumed.data.resumeValidation?.staleFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: deleted, status: 'deleted' }),
        expect.objectContaining({ path: outside, status: 'outside_project' }),
      ]),
    );
    await resumed.writer.close();
  });

  it('rebuilds stale sidecar counters from the JSONL before resume', {
    timeout: 5000,
  }, async () => {
    const id = 'stale-summary';
    const writer = await store.create({ id, model: 'm', provider: 'p' });
    await writer.append({ type: 'user_input', ts: now(), content: 'persisted prompt' });
    await writer.close();
    const manifestPath = path.join(tmp, `${id}.summary.json`);
    const stale = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ ...stale, messageCount: 0, lastUserMessage: 'stale preview' }),
      'utf8',
    );

    const resumed = await store.resume(id);
    await resumed.writer.close();

    const rebuilt = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      messageCount?: number;
      lastUserMessage?: string;
    };
    expect(rebuilt.messageCount).toBe(1);
    expect(rebuilt.lastUserMessage).toBe('persisted prompt');
  });
});

describe('DefaultSessionStore — non-destructive journal fork', () => {
  it('forks an exact checkpoint prefix without copying parent rewind snapshots', async () => {
    const parent = await store.create({ id: 'parent', model: 'm', provider: 'p' });
    const workspaceCheckpoint = {
      manifestHash: 'c'.repeat(64),
      baseHead: 'd'.repeat(40),
      entryCount: 1,
      unresolvedCount: 0,
      capturedAt: now(),
      coverage: 'git-head-plus-dirty' as const,
    };
    const capture = vi.fn(async (_sessionId: string, promptIndex: number) =>
      promptIndex === 0 ? workspaceCheckpoint : undefined,
    );
    (parent as never as { checkpointCas: { capture: typeof capture } }).checkpointCas = { capture };
    await parent.append({ type: 'user_input', ts: now(), content: 'first prompt' });
    await parent.writeCheckpoint(0, 'first prompt');
    await parent.writeFileSnapshot(0, [
      { path: path.join(tmp, 'a.ts'), action: 'modified', before: 'a0', after: 'a1' },
    ]);
    await parent.append({
      type: 'llm_response',
      ts: now(),
      content: [{ type: 'text', text: 'first answer' }],
      usage: { input: 1, output: 1 },
      stopReason: 'end_turn',
    });
    await parent.append({ type: 'user_input', ts: now(), content: 'second prompt' });
    await parent.writeCheckpoint(1, 'second prompt');
    await parent.close();
    const parentBefore = await fs.readFile(path.join(tmp, 'parent.jsonl'), 'utf8');

    const firstFork = await store.fork('parent', { checkpointPromptIndex: 0 });
    const secondFork = await store.fork('parent', { checkpointPromptIndex: 0 });

    expect(firstFork.id).not.toBe('parent');
    expect(firstFork.id).not.toBe(secondFork.id);
    expect(firstFork.checkpointHash).toMatch(/^[a-f\d]{64}$/);
    expect(firstFork.checkpointHash).toBe(secondFork.checkpointHash);
    expect(firstFork.workspace).toBe('shared-current');
    expect(firstFork.workspaceCheckpoint).toEqual(workspaceCheckpoint);
    expect(firstFork.data.metadata.forkedFrom).toEqual({
      sessionId: 'parent',
      checkpointPromptIndex: 0,
      checkpointHash: firstFork.checkpointHash,
      workspace: 'shared-current',
      workspaceCheckpointHash: workspaceCheckpoint.manifestHash,
    });
    expect(firstFork.data.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'first prompt' }),
    ]);
    expect(firstFork.data.events.some((event) => event.type === 'file_snapshot')).toBe(false);
    expect(await fs.readFile(path.join(tmp, 'parent.jsonl'), 'utf8')).toBe(parentBefore);
  });

  it('forks the latest exact replay state and rejects an unknown checkpoint', async () => {
    const parent = await store.create({ id: 'latest-parent', model: 'm', provider: 'p' });
    await parent.append({ type: 'user_input', ts: now(), content: 'old raw turn' });
    await parent.append({
      type: 'context_snapshot',
      ts: now(),
      reason: 'compaction',
      messages: [{ role: 'system', content: 'exact compacted state' }],
    });
    await parent.close();

    const forked = await store.fork('latest-parent');
    expect(forked.data.messages).toEqual([
      expect.objectContaining({ role: 'system', content: 'exact compacted state' }),
    ]);
    await expect(store.fork('latest-parent', { checkpointPromptIndex: 99 })).rejects.toThrow(
      'Checkpoint 99 not found',
    );
  });

  it('inherits the turns before a superseded snapshot when forking a compacted session', async () => {
    // The loader empties every snapshot but the newest to bound heap, in place,
    // on the array it hands back. A fork that took its prefix from there wrote
    // `messages_replaced {messages: []}` into the child, and replay read that
    // as "the conversation is empty now" — so forking at any checkpoint that
    // preceded the newest snapshot silently dropped the inherited history.
    const parent = await store.create({ id: 'compacted', model: 'm', provider: 'p' });
    const turn = (text: string) => ({ role: 'user' as const, content: text, ts: now() });
    await parent.writeCheckpoint(0, 'first');
    await parent.append({
      type: 'messages_replaced',
      ts: now(),
      version: 1,
      messages: [turn('a'), turn('b')],
    });
    await parent.append({
      type: 'message_appended',
      ts: now(),
      version: 1,
      message: turn('c'),
    });
    await parent.writeCheckpoint(1, 'second');
    // A second compaction supersedes the first snapshot; only this one keeps
    // its payload once the parent is loaded.
    await parent.append({
      type: 'messages_replaced',
      ts: now(),
      version: 1,
      messages: [turn('a'), turn('b'), turn('c'), turn('d')],
    });
    await parent.writeCheckpoint(2, 'third');
    await parent.close();

    const texts = (data: { messages: readonly { content: unknown }[] }) =>
      data.messages.map((m) => m.content);

    // Forking at checkpoint 1 cuts before the surviving snapshot, so the only
    // snapshot in the prefix is the stripped one.
    const atFirstCompaction = await store.fork('compacted', { checkpointPromptIndex: 1 });
    expect(texts(atFirstCompaction.data)).toEqual(['a', 'b', 'c']);

    const atLatest = await store.fork('compacted');
    expect(texts(atLatest.data)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores a snapshot whose payload was stripped before it was persisted', async () => {
    // Defense in depth for the fork bug above: journals written by an older
    // build already carry emptied snapshots, and replaying one as an ordinary
    // snapshot would wipe the history it was supposed to describe.
    const file = path.join(tmp, 'pre-stripped.jsonl');
    const lines: unknown[] = [
      { type: 'session_start', ts: now(), id: 'pre-stripped', model: 'm', provider: 'p' },
      {
        type: 'message_appended',
        ts: now(),
        version: 1,
        message: { role: 'user', content: 'kept', ts: now() },
      },
      { type: 'messages_replaced', ts: now(), version: 1, messages: [], messagesOmitted: 7 },
    ];
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const data = await store.load('pre-stripped');
    expect(data.messages.map((m) => m.content)).toEqual(['kept']);
  });
});

describe('FileSessionWriter — appendBatch', () => {
  it('is a no-op for an empty batch', async () => {
    const w = await store.create({ id: 'ab0', model: 'm', provider: 'p' });
    await w.appendBatch([]);
    await w.close();
    const data = await store.load('ab0');
    // Only the session_start (+ session_end on close) — no batch events.
    expect(data.events.filter((e) => e.type === 'user_input')).toHaveLength(0);
  });

  it('buffers a small batch and flushes immediately past FLUSH_SIZE', async () => {
    const w = await store.create({ id: 'ab1', model: 'm', provider: 'p' });
    // Non-critical events: user_input would flush itself immediately since
    // the kill-safety fix and mask the FLUSH_SIZE boundary being tested.
    const many: SessionEvent[] = Array.from({ length: 55 }, (_, i) => ({
      type: 'tool_result',
      ts: now(),
      id: `tu-${i}`,
      content: `msg-${i}`,
      isError: false,
    }));
    await w.appendBatch(many);
    await w.close();
    const data = await store.load('ab1');
    expect(data.events.filter((e) => e.type === 'tool_result')).toHaveLength(55);
  });

  it('list() surfaces a never-closed (killed) session via the directory-scan union', async () => {
    const closedWriter = await store.create({ id: 'p1a', model: 'm', provider: 'p' });
    await closedWriter.append({ type: 'user_input', ts: now(), content: 'alpha closed cleanly' });
    await closedWriter.close();

    // Simulates a killed process: transcript events exist, but close() never
    // ran — so no index row was ever appended for this session.
    const killed = await store.create({ id: 'p1b', model: 'm', provider: 'p' });
    await killed.append({ type: 'user_input', ts: now(), content: 'beta killed mid-flight' });

    const list = await store.list(10);
    const ids = list.map((s) => s.id);
    expect(ids).toContain('p1a');
    // Regression guard: index-only listing made p1b invisible whenever any
    // older session had closed cleanly (non-empty _index.jsonl).
    expect(ids).toContain('p1b');
    // Most recent activity sorts first.
    expect(ids.indexOf('p1b')).toBeLessThan(ids.indexOf('p1a'));

    await killed.close(); // release the handle before afterEach cleanup
  });

  it('list() sees a fresh unclosed session even when shard manifests were primed', async () => {
    // Prime any persisted shard-manifest caches with an earlier listing pass.
    await store.list();
    const fresh = await store.create({ id: 'p1c', model: 'm', provider: 'p' });
    await fresh.append({ type: 'user_input', ts: now(), content: 'charlie unclosed' });

    const ids = (await store.list(10)).map((s) => s.id);
    expect(ids).toContain('p1c');

    await fresh.close(); // release the handle before afterEach cleanup
  });

  it('resume() heals a crashed session: synthesized error results, recovered marker, detectStale clears', async () => {
    // Simulate a kill mid-iteration: tool_use recorded, no result, dangling
    // in_flight_start, and NO clean shutdown sequence.
    // Fixture is written DIRECTLY as JSONL (no FileSessionWriter): the real
    // writer would keep its handle (and unref'd timers) open across resume()
    // and afterEach cleanup, racing both. Field shapes mirror exactly what
    // append()/writeInFlightMarker() persist for these event types.
    const crashLines = [
      {
        type: 'session_start',
        ts: now(),
        id: 'p2crash',
        model: 'm',
        provider: 'p',
      },
      { type: 'user_input', ts: now(), content: 'do work' },
      {
        type: 'llm_response',
        ts: now(),
        content: [{ type: 'tool_use', id: 'tu-x', name: 'write_file', input: { path: 'a.ts' } }],
        stopReason: 'tool_use',
        usage: { input: 5, output: 2 },
      },
      { type: 'in_flight_start', ts: now(), context: 'writing a.ts' },
    ];
    await fs.writeFile(
      path.join(tmp, 'p2crash.jsonl'),
      `${crashLines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );
    // No clearInFlightMarker / session_end — the process "died" here.

    const before = await new SessionRecovery(tmp).detectStale('p2crash');
    expect(before).not.toBeNull();

    const resumed = await store.resume('p2crash');
    expect(resumed).not.toBeNull();

    // Journal healed: the synthesized result pairs with the dangling
    // tool_use id, and the stale boundary is closed with reason='recovered'.
    const healed = (await fs.readFile(path.join(tmp, 'p2crash.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      healed.some(
        (event) =>
          event['type'] === 'tool_result' && event['id'] === 'tu-x' && event['isError'] === true,
      ),
    ).toBe(true);
    expect(
      healed.some((event) => event['type'] === 'in_flight_end' && event['reason'] === 'recovered'),
    ).toBe(true);

    // detectStale() must report a CLEAN file after recovery.
    const after = await new SessionRecovery(tmp).detectStale('p2crash');
    expect(after).toBeNull();

    // Crash notice surfaced into restored history.
    const sawCrashNotice = resumed!.data.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('[SESSION RESUME CRASH RECOVERY]'),
    );
    expect(sawCrashNotice).toBe(true);
    expect(
      resumed!.data.messages.some(
        (m) =>
          typeof m.content === 'string' &&
          m.content.includes('removed from the restored conversation'),
      ),
    ).toBe(true);
    expect(
      resumed!.data.messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('marked failed'),
      ),
    ).toBe(false);

    await resumed!.writer.close(); // release handle before afterEach cleanup
  });

  it('ignores appendBatch after close()', async () => {
    const w = await store.create({ id: 'ab2', model: 'm', provider: 'p' });
    await w.close();
    await w.appendBatch([{ type: 'user_input', ts: now(), content: 'late' }]);
    const data = await store.load('ab2');
    expect(data.events.some((e) => e.type === 'user_input')).toBe(false);
  });
});

describe('DefaultSessionStore — crash-torn append boundary', () => {
  it('isolates a partial final JSON record before writing resumed events', async () => {
    const id = 'torn-tail';
    const file = path.join(tmp, `${id}.jsonl`);
    const sessionStart = {
      type: 'session_start',
      ts: now(),
      id,
      model: 'm',
      provider: 'p',
    };
    await fs.writeFile(file, `${JSON.stringify(sessionStart)}\n{"type":"tool_result"`, 'utf8');

    const resumed = await store.resume(id);
    await resumed.writer.append({ type: 'user_input', ts: now(), content: 'after crash' });
    await resumed.writer.close();

    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines[1]).toBe('{"type":"tool_result"');
    expect(lines.slice(2).map((line) => JSON.parse(line).type)).toEqual([
      'session_resumed',
      'user_input',
    ]);
    await expect(store.load(id)).resolves.toMatchObject({
      messages: [expect.objectContaining({ role: 'user', content: 'after crash' })],
    });
  });

  it('preserves a valid final JSON record that lacks only its newline', async () => {
    const id = 'missing-newline';
    const file = path.join(tmp, `${id}.jsonl`);
    const records = [
      { type: 'session_start', ts: now(), id, model: 'm', provider: 'p' },
      { type: 'user_input', ts: now(), content: 'before resume' },
    ];
    await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join('\n'), 'utf8');

    const resumed = await store.resume(id);
    await resumed.writer.append({ type: 'user_input', ts: now(), content: 'after resume' });
    await resumed.writer.close();

    const data = await store.load(id);
    expect(data.events.filter((event) => event.type === 'user_input')).toHaveLength(2);
    expect(data.events.some((event) => event.type === 'session_resumed')).toBe(true);
  });
});

describe('FileSessionWriter — truncateToCheckpoint / clearSession / in-flight', () => {
  it('truncates events after a checkpoint and records a rewound marker', async () => {
    const w = await store.create({ id: 'tc', model: 'm', provider: 'p' });
    await w.writeCheckpoint(0, 'first');
    await w.append({
      type: 'user_input',
      ts: now(),
      content: 'kept',
      promptIndex: 0,
    } as SessionEvent);
    await w.writeCheckpoint(1, 'second');
    await w.append({
      type: 'user_input',
      ts: now(),
      content: 'dropped',
      promptIndex: 1,
    } as SessionEvent);
    const removed = await w.truncateToCheckpoint(0);
    expect(removed).toBeGreaterThan(0);
    await w.close();
    const data = await store.load('tc');
    expect(data.events.some((e) => e.type === 'rewound')).toBe(true);
  });

  it('clearSession rewrites the file to a single session_start', async () => {
    const w = await store.create({ id: 'cl', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'before clear' });
    await w.clearSession();
    await w.close();
    const data = await store.load('cl');
    expect(data.events.some((e) => e.type === 'user_input')).toBe(false);
  });

  it('rejects an out-of-range in-flight context', async () => {
    const w = await store.create({ id: 'if', model: 'm', provider: 'p' });
    await expect(w.writeInFlightMarker('')).rejects.toThrow(/1\.\.500/);
    await expect(w.writeInFlightMarker('x'.repeat(501))).rejects.toThrow(/1\.\.500/);
    await w.writeInFlightMarker('valid context');
    await w.clearInFlightMarker('clean');
    await w.close();
  });

  it('derives the summary title from array text content', async () => {
    const w = await store.create({ id: 'title', model: 'm', provider: 'p' });
    await w.append({
      type: 'user_input',
      ts: now(),
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
    } as SessionEvent);
    await w.close();
    const summaries = await store.list();
    const entry = summaries.find((s) => s.id === 'title');
    expect(entry?.title).toContain('hello');
  });
});

describe('DefaultSessionStore — best-effort cleanup paths', () => {
  it('clearHistory swallows a missing summary sidecar', async () => {
    // Raw session with no .summary.json → clearHistory's unlink hits ENOENT.
    await writeRawSession(tmp, 'noidx', [
      { type: 'session_start', ts: now(), id: 'noidx', model: 'm', provider: 'p' },
    ]);
    await expect(store.clearHistory('noidx')).resolves.toBeUndefined();
    const raw = await fs.readFile(path.join(tmp, 'noidx.jsonl'), 'utf8');
    expect(raw).toContain('session_start');
  });

  it('prune removes an aged session and cleans up its empty date shard', async () => {
    const shard = path.join(tmp, '2020-01-01');
    await fs.mkdir(shard, { recursive: true });
    await writeRawSession(shard, '00-00-00Z_old', [
      {
        type: 'session_start',
        ts: '2020-01-01T00:00:00.000Z',
        id: '2020-01-01/00-00-00Z_old',
        model: 'm',
        provider: 'p',
      },
    ]);
    // Backdate the mtime well past the prune cutoff.
    const old = new Date('2020-01-01T00:00:00.000Z');
    await fs.utimes(path.join(shard, '00-00-00Z_old.jsonl'), old, old);
    const deleted = await store.prune(30);
    expect(deleted).toBeGreaterThanOrEqual(1);
    // The now-empty date shard directory is removed.
    await expect(fs.stat(shard)).rejects.toBeDefined();
  });
});

describe('DefaultSessionStore — error paths', () => {
  it('surfaces a create failure when the file handle cannot be opened', async () => {
    // A 300-char basename exceeds NAME_MAX (255) on Linux and the path limit on
    // Windows → fsp.open() throws, exercising the emitError + rethrow path.
    const longId = 'x'.repeat(300);
    await expect(store.create({ id: longId, model: 'm', provider: 'p' })).rejects.toThrow(
      /Failed to open session file/,
    );
  });

  it('load() rejects for a missing session', async () => {
    await expect(store.load('does-not-exist')).rejects.toBeDefined();
  });

  it('resume() rejects for missing or empty session references', async () => {
    await expect(store.resume('also-missing')).rejects.toBeDefined();
    await expect(store.resolveId('   ')).rejects.toThrow('Session not found: (empty query)');
  });

  it('rejects ambiguous leaf references instead of choosing a session', async () => {
    for (const id of ['2026-07-04/shared-leaf', '2026-07-05/shared-leaf']) {
      const writer = await store.create({ id, model: 'm', provider: 'p' });
      await writer.close();
    }
    await expect(store.resolveId('shared-leaf')).rejects.toThrow(/Ambiguous session id/);
    await expect(store.resume('shared-leaf')).rejects.toThrow(/Ambiguous session id/);
  });

  it('prefers an exact leaf over another session that only shares its prefix', async () => {
    for (const id of ['2026-07-04/sess_exact', '2026-07-05/sess_exact_extra']) {
      const writer = await store.create({ id, model: 'm', provider: 'p' });
      await writer.close();
    }
    await expect(store.resolveId('sess_exact')).resolves.toBe('2026-07-04/sess_exact');
    await expect(store.resolveId('2026-07-05/sess_exact_extra')).resolves.toBe(
      '2026-07-05/sess_exact_extra',
    );
  });
});

describe('DefaultSessionStore — rebuildIndex / summary fallback / shard scan', () => {
  it('rebuilds the index from sessions on disk', async () => {
    for (const id of ['r1', 'r2']) {
      const w = await store.create({ id, model: 'm', provider: 'p' });
      await w.append({ type: 'user_input', ts: now(), content: id });
      await w.close();
    }
    const count = await store.rebuildIndex();
    expect(count).toBeGreaterThanOrEqual(2);
    const idx = await fs.readFile(path.join(tmp, '_index.jsonl'), 'utf8');
    expect(idx).toContain('r1');
    expect(idx).toContain('r2');
  });

  it('caches parsed index entries until the index file changes', async () => {
    for (const id of ['cache-a', 'cache-b']) {
      const w = await store.create({ id, model: 'm', provider: 'p' });
      await w.append({ type: 'user_input', ts: now(), content: id });
      await w.close();
    }

    const first = await store.list();
    const cacheAfterFirst = (
      store as { _indexCache: { summaries: unknown[]; byId: Map<string, unknown> } | null }
    )._indexCache;
    expect(cacheAfterFirst?.summaries.length).toBeGreaterThanOrEqual(2);

    const second = await store.list();
    const cacheAfterSecond = (store as { _indexCache: { summaries: unknown[] } | null })
      ._indexCache;
    expect(cacheAfterSecond).toBe(cacheAfterFirst);
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));

    await fs.appendFile(
      path.join(tmp, '_index.jsonl'),
      `${JSON.stringify({ id: 'cache-c', title: 'cache-c', startedAt: new Date(Date.now() + 1_000).toISOString(), model: 'm', provider: 'p', tokenTotal: 0 })}\n`,
      'utf8',
    );

    const third = await store.list();
    const cacheAfterThird = (
      store as { _indexCache: { summaries: unknown[]; byId: Map<string, unknown> } | null }
    )._indexCache;
    expect(cacheAfterThird).not.toBe(cacheAfterFirst);
    // Growth on the same index file reuses the parsed map and consumes only
    // the appended byte range instead of reparsing the complete JSONL.
    expect(cacheAfterThird?.byId).toBe(cacheAfterFirst?.byId);
    expect(third.some((s) => s.id === 'cache-c')).toBe(true);
  });

  it('applies appended index tombstones through the incremental cache path', async () => {
    for (const id of ['keep-indexed', 'drop-indexed']) {
      const w = await store.create({ id, model: 'm', provider: 'p' });
      await w.append({ type: 'user_input', ts: now(), content: id });
      await w.close();
    }
    await store.list();
    const cacheBefore = (store as { _indexCache: { byId: Map<string, unknown> } | null })
      ._indexCache;

    await fs.appendFile(
      path.join(tmp, '_index.jsonl'),
      `${JSON.stringify({ action: 'delete', id: 'drop-indexed' })}\n`,
      'utf8',
    );

    const listed = await store.list();
    const cacheAfter = (store as { _indexCache: { byId: Map<string, unknown> } | null })
      ._indexCache;
    expect(cacheAfter?.byId).toBe(cacheBefore?.byId);
    expect(listed.some((summary) => summary.id === 'keep-indexed')).toBe(true);
    expect(listed.some((summary) => summary.id === 'drop-indexed')).toBe(false);
  });

  it('rebuilds a missing summary sidecar during list()', async () => {
    const w = await store.create({ id: 'nosum', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'sidecar gone' });
    await w.close();
    // Remove the summary sidecar AND the index so list() must rebuild via summaryFor().
    await fs.rm(path.join(tmp, 'nosum.summary.json'), { force: true });
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });
    const summaries = await store.list();
    expect(summaries.some((s) => s.id === 'nosum')).toBe(true);
    // The fallback wrote the manifest back.
    const rebuilt = await fs.readFile(path.join(tmp, 'nosum.summary.json'), 'utf8');
    expect(rebuilt).toContain('nosum');
  });

  it('collects date-sharded ids and skips non-session directories', async () => {
    const w = await store.create({ id: '2026-01-02/aa-bb-ccZ_x1', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'sharded' });
    await w.close();
    // Directories that must be skipped during the scan.
    await fs.mkdir(path.join(tmp, 'subagents'), { recursive: true });
    await fs.mkdir(path.join(tmp, '.hidden'), { recursive: true });
    const count = await store.rebuildIndex();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('sorts indexed sessions and falls back to a directory scan', async () => {
    // Two indexed sessions with distinct start times → exercise the index sort.
    for (const id of ['s-old', 's-new']) {
      const w = await store.create({ id, model: 'm', provider: 'p' });
      await w.append({ type: 'user_input', ts: now(), content: id });
      await w.close();
    }
    const indexed = await store.list();
    expect(indexed.length).toBeGreaterThanOrEqual(2);
    // Drop the index → list() must scan the directory and sort the summaries.
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });
    const scanned = await store.list();
    expect(scanned.length).toBeGreaterThanOrEqual(2);
  });

  it('sorts index entries by startedAt with an id tiebreak', async () => {
    // Hand-author the index with controlled timestamps: two share a startedAt
    // (→ id localeCompare tiebreak), one is newer (→ both < and > comparisons).
    // Scrambled order with two equal timestamps so the comparator hits all three
    // returns: a<b (→1), a>b (→-1), and the id-localeCompare tiebreak.
    const entries = [
      {
        id: 'cm',
        title: 't',
        startedAt: '2026-02-02T00:00:00.000Z',
        model: 'm',
        provider: 'p',
        tokenTotal: 0,
      },
      {
        id: 'ao',
        title: 't',
        startedAt: '2026-01-01T00:00:00.000Z',
        model: 'm',
        provider: 'p',
        tokenTotal: 0,
      },
      {
        id: 'dn',
        title: 't',
        startedAt: '2026-03-03T00:00:00.000Z',
        model: 'm',
        provider: 'p',
        tokenTotal: 0,
      },
      {
        id: 'bo',
        title: 't',
        startedAt: '2026-01-01T00:00:00.000Z',
        model: 'm',
        provider: 'p',
        tokenTotal: 0,
      },
    ];
    await fs.writeFile(
      path.join(tmp, '_index.jsonl'),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
    const out = await store.list();
    expect(out.map((s) => s.id)).toEqual(['dn', 'cm', 'ao', 'bo']); // newest first, id tiebreak on the Jan pair
  });

  it('sorts directory-scanned summaries when start times tie', async () => {
    // Two raw sessions sharing a session_start ts → fallback-scan localeCompare tie.
    const ts = '2026-03-03T00:00:00.000Z';
    for (const id of ['z-sess', 'y-sess']) {
      await writeRawSession(tmp, id, [
        { type: 'session_start', ts, id, model: 'm', provider: 'p' },
        { type: 'user_input', ts, content: id },
      ]);
    }
    const out = await store.list();
    const ids = out.filter((s) => s.id.endsWith('-sess')).map((s) => s.id);
    expect(ids).toEqual(['y-sess', 'z-sess']); // id tiebreak on equal startedAt
  });
});

/** Write a raw JSONL session file directly so we control the exact event stream. */
async function writeRawSession(dir: string, id: string, events: object[]): Promise<void> {
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(path.join(dir, `${id}.jsonl`), lines, 'utf8');
}

describe('DefaultSessionStore — summarize / replay over raw event streams', () => {
  it('counts iterations/tools/files and marks an unfinished session aborted', async () => {
    await writeRawSession(tmp, 'sm-abort', [
      { type: 'session_start', ts: now(), id: 'sm-abort', model: 'm', provider: 'p' },
      { type: 'user_input', ts: now(), content: 'go' },
      { type: 'tool_call_start', ts: now(), name: 'bash', id: 't1' },
      { type: 'tool_result', ts: now(), id: 't1', content: 'oops', isError: true },
      {
        type: 'file_snapshot',
        ts: now(),
        promptIndex: 0,
        files: [{ path: 'a', action: 'modified', before: '1', after: '2' }],
      },
      { type: 'in_flight_start', ts: now(), context: 'mid-op' }, // last event → aborted
    ]);
    const summaries = await store.list();
    const s = summaries.find((x) => x.id === 'sm-abort');
    expect(s?.outcome).toBe('aborted');
    expect(s?.toolErrorCount).toBe(1);
    expect(s?.fileChangeCount).toBe(1);
  });

  it('marks a session that emitted an error event as error', async () => {
    await writeRawSession(tmp, 'sm-err', [
      { type: 'session_start', ts: now(), id: 'sm-err', model: 'm', provider: 'p' },
      { type: 'user_input', ts: now(), content: 'go' },
      { type: 'error', ts: now(), message: 'boom' },
      {
        type: 'llm_response',
        ts: now(),
        content: [{ type: 'text', text: 'end' }],
        usage: { input: 1, output: 1 },
        stopReason: 'end_turn',
      },
    ]);
    const summaries = await store.list();
    expect(summaries.find((x) => x.id === 'sm-err')?.outcome).toBe('error');
  });

  it('groups consecutive tool_result events into one user message on replay', async () => {
    await writeRawSession(tmp, 'rp', [
      { type: 'session_start', ts: now(), id: 'rp', model: 'm', provider: 'p' },
      { type: 'user_input', ts: now(), content: 'do two things' },
      {
        type: 'llm_response',
        ts: now(),
        content: [
          { type: 'tool_use', id: 'u1', name: 'bash', input: {} },
          { type: 'tool_use', id: 'u2', name: 'bash', input: {} },
        ],
        usage: { input: 5, output: 5 },
        stopReason: 'tool_use',
      },
      { type: 'tool_result', ts: now(), id: 'u1', content: 'r1', isError: false },
      { type: 'tool_result', ts: now(), id: 'u2', content: 'r2', isError: false },
    ]);
    const data = await store.load('rp');
    // The two tool_results collapse into a single trailing user message.
    const last = data.messages[data.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(Array.isArray(last?.content) ? last.content.length : 0).toBe(2);
  });

  it('replaces earlier replay state at context_snapshot and applies later events', async () => {
    await writeRawSession(tmp, 'snapshot-replay', [
      { type: 'session_start', ts: now(), id: 'snapshot-replay', model: 'm', provider: 'p' },
      { type: 'user_input', ts: now(), content: 'ancient user turn' },
      {
        type: 'llm_response',
        ts: now(),
        content: [{ type: 'text', text: 'ancient answer' }],
        usage: { input: 5, output: 5 },
        stopReason: 'end_turn',
      },
      {
        type: 'context_snapshot',
        ts: now(),
        reason: 'compaction',
        messages: [
          { role: 'system', content: '[prior_turns_digest: compacted state]' },
          { role: 'user', content: 'current turn' },
        ],
      },
      {
        type: 'llm_response',
        ts: now(),
        content: [{ type: 'text', text: 'answer after compaction' }],
        usage: { input: 2, output: 3 },
        stopReason: 'end_turn',
      },
    ]);

    const data = await store.load('snapshot-replay');
    expect(data.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(JSON.stringify(data.messages)).not.toContain('ancient user turn');
    expect(JSON.stringify(data.messages)).toContain('answer after compaction');
    // Usage remains the complete session cost, not merely the post-snapshot tail.
    expect(data.usage).toMatchObject({ input: 7, output: 8 });
  });

  it('round-trips the exact conversation journal across tool calls, results, and intervening messages', async () => {
    const ts = now();
    const exactMessages = [
      { role: 'user' as const, content: 'inspect the project', ts },
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'I will inspect it.' },
          { type: 'tool_use' as const, id: 'tu-1', name: 'read', input: { path: 'a.ts' } },
        ],
        ts,
      },
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: '[MAILBOX BTW] Keep the ordering intact.' },
          { type: 'tool_result' as const, tool_use_id: 'tu-1', content: 'file contents' },
        ],
        ts,
      },
      { role: 'system' as const, content: '[note between tool batches]', ts },
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'The result was file contents.' }],
        ts,
      },
    ];

    await writeRawSession(tmp, 'exact-journal', [
      { type: 'session_start', ts, id: 'exact-journal', model: 'm', provider: 'p' },
      // Legacy events remain for older readers and usage accounting.
      { type: 'user_input', ts, content: 'inspect the project' },
      {
        type: 'llm_response',
        ts,
        content: exactMessages[1]!.content,
        usage: { input: 3, output: 2 },
        stopReason: 'tool_use',
      },
      { type: 'tool_result', ts, id: 'tu-1', content: 'file contents', isError: false },
      // The exact journal is authoritative and must not duplicate legacy turns.
      ...exactMessages.map((message) => ({ type: 'message_appended', ts, version: 1, message })),
      {
        type: 'message_updated',
        ts,
        version: 1,
        index: 2,
        message: {
          ...exactMessages[2],
          content: [
            { type: 'text', text: '[MAILBOX BTW] Keep the ordering intact. Updated.' },
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents' },
          ],
        },
      },
    ] as SessionEvent[]);

    const data = await store.load('exact-journal');
    expect(data.messages).toEqual([
      exactMessages[0],
      exactMessages[1],
      {
        ...exactMessages[2],
        content: [
          { type: 'text', text: '[MAILBOX BTW] Keep the ordering intact. Updated.' },
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents' },
        ],
      },
      exactMessages[3],
      exactMessages[4],
    ]);
    expect(data.usage).toMatchObject({ input: 3, output: 2 });
  });

  it('uses messages_replaced as an exact recovery boundary and applies later journal events', async () => {
    const ts = now();
    await writeRawSession(tmp, 'exact-replace', [
      { type: 'session_start', ts, id: 'exact-replace', model: 'm', provider: 'p' },
      { type: 'user_input', ts, content: 'legacy prefix' },
      {
        type: 'messages_replaced',
        ts,
        version: 1,
        messages: [
          { role: 'system', content: '[recovered exact state]' },
          { role: 'user', content: 'continue from here' },
        ],
      },
      {
        type: 'message_appended',
        ts,
        version: 1,
        message: { role: 'assistant', content: 'continued exactly' },
      },
    ] as SessionEvent[]);

    const data = await store.load('exact-replace');
    expect(data.messages).toEqual([
      { role: 'system', content: '[recovered exact state]' },
      { role: 'user', content: 'continue from here' },
      { role: 'assistant', content: 'continued exactly', ts },
    ]);
  });

  it('ignores a malformed context_snapshot without discarding replayed history', async () => {
    await writeRawSession(tmp, 'bad-snapshot', [
      { type: 'session_start', ts: now(), id: 'bad-snapshot', model: 'm', provider: 'p' },
      { type: 'user_input', ts: now(), content: 'keep me' },
      { type: 'context_snapshot', ts: now(), reason: 'compaction', messages: 'not-an-array' },
    ]);
    const data = await store.load('bad-snapshot');
    expect(data.messages).toContainEqual(
      expect.objectContaining({ role: 'user', content: 'keep me' }),
    );
  });
});

describe('FileSessionWriter — observeForSummary event types + scheduled flush', () => {
  it('tracks tool_call_start, legacy tool_use, compaction and provider_error events', async () => {
    const w = await store.create({ id: 'obs', model: 'm', provider: 'p' });
    await w.append({ type: 'tool_call_start', ts: now(), name: 'bash', id: 'c1' } as SessionEvent);
    await w.append({
      type: 'tool_use',
      ts: now(),
      id: 'u9',
      name: 'bash',
      input: {},
    } as SessionEvent);
    await w.append({ type: 'compaction', ts: now() } as SessionEvent);
    await w.append({
      type: 'provider_error',
      ts: now(),
      providerId: 'openai',
      description: 'rate limited',
      retryable: true,
    } as SessionEvent);
    await w.close();
    const summaries = await store.list();
    const s = summaries.find((x) => x.id === 'obs');
    expect(s?.outcome).toBe('error');
    expect(s?.toolCallCount).toBe(1);
  });

  it('scrubs llm_response secrets but passes non-conversation events through untouched', async () => {
    const scrubStore = new DefaultSessionStore({
      dir: tmp,
      secretScrubber: new DefaultSecretScrubber(),
    });
    const w = await scrubStore.create({ id: 'scrub', model: 'm', provider: 'p' });
    await w.append({
      type: 'llm_response',
      ts: now(),
      content: [{ type: 'text', text: 'token sk-ant-SECRETSECRETSECRETSECRET here' }],
      usage: { input: 1, output: 1 },
      stopReason: 'end_turn',
    } as SessionEvent);
    // A non-user/non-llm event takes the scrubEvent pass-through branch.
    await w.append({ type: 'tool_call_start', ts: now(), name: 'bash', id: 'p1' } as SessionEvent);
    await w.append({
      type: 'context_snapshot',
      ts: now(),
      reason: 'compaction',
      messages: [
        {
          role: 'system',
          content: 'snapshot sk-ant-SECRETSECRETSECRETSECRET value',
          _estTokens: 99,
        },
      ],
    });
    await w.close();
    const raw = await fs.readFile(path.join(tmp, 'scrub.jsonl'), 'utf8');
    expect(raw).not.toContain('SECRETSECRETSECRETSECRET');
    expect(raw).not.toContain('_estTokens');
    expect(raw).toContain('tool_call_start');
  });

  it('flushes buffered events via the deferred timer', async () => {
    const w = await store.create({ id: 'timer', model: 'm', provider: 'p' });
    // A single NON-CRITICAL append schedules the 500ms flush timer instead of
    // flushing now (critical types like user_input flush themselves since the
    // kill-safety fix and would make this test vacuous).
    await w.append({
      type: 'tool_result',
      ts: now(),
      id: 'tu-deferred',
      content: 'deferred',
      isError: false,
    });
    // Wait for the timer to fire and land the event on disk (no explicit flush).
    await vi.waitFor(
      async () => {
        const raw = await fs.readFile(path.join(tmp, 'timer.jsonl'), 'utf8');
        expect(raw).toContain('deferred');
      },
      { timeout: 3000, interval: 50 },
    );
    await w.close();
  });

  it('size-boundary append cancels the pending deferred timer (no late flush)', async () => {
    vi.useFakeTimers();
    try {
      const w = await store.create({ id: 'timer2', model: 'm', provider: 'p' });
      await w.append({
        type: 'tool_result',
        ts: now(),
        id: 'tu-deferred',
        content: 'deferred',
        isError: false,
      }); // schedules the 500ms timer; nothing written yet
      const before = await fs.readFile(path.join(tmp, 'timer2.jsonl'), 'utf8');
      expect(before).not.toContain('deferred');

      const big: SessionEvent[] = Array.from({ length: 60 }, (_, i) => ({
        type: 'tool_result',
        ts: now(),
        id: `tu-b${i}`,
        content: `b${i}`,
        isError: false,
      }));
      await w.appendBatch(big); // size boundary → cancelTimer + immediate flush

      const after = await fs.readFile(path.join(tmp, 'timer2.jsonl'), 'utf8');
      expect(after).toContain('deferred'); // drained together with the batch
      const snapshotLength = after.length;
      // Advancing past the original interval must produce NOTHING further:
      // proof the pending timer was actually canceled, not left to fire.
      await vi.advanceTimersByTimeAsync(500);
      const post = await fs.readFile(path.join(tmp, 'timer2.jsonl'), 'utf8');
      expect(post.length).toBe(snapshotLength);
      await w.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a pending flush timer when a later batch exceeds the flush size', async () => {
    const w = await store.create({ id: 'ab3', model: 'm', provider: 'p' });
    await w.appendBatch([
      { type: 'tool_result', ts: now(), id: 'tu-s0', content: 'small', isError: false },
    ]); // schedules timer (non-critical)
    const big: SessionEvent[] = Array.from({ length: 60 }, (_, i) => ({
      type: 'tool_result',
      ts: now(),
      id: `tu-b${i}`,
      content: `b${i}`,
      isError: false,
    }));
    await w.appendBatch(big); // timer pending → cleared, immediate flush
    // Assert BEFORE close(): close() flushes on its own and would mask a
    // broken immediate-flush path here (chimera M).
    const raw = await fs.readFile(path.join(tmp, 'ab3.jsonl'), 'utf8');
    expect(raw.split('\n').filter((l) => l.includes('"type":"tool_result"'))).toHaveLength(61);
    await w.close();
  });
});

describe('DefaultSessionStore.loadEventsOnly — fast-path loader', () => {
  it('returns events and metadata but skips message reconstruction', async () => {
    const w = await store.create({ id: 'eo1', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'hello' });
    await w.append({
      type: 'llm_response',
      ts: now(),
      content: [
        { type: 'text', text: 'world' },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      ],
      usage: { input: 7, output: 11 },
      stopReason: 'tool_use',
    });
    await w.append({ type: 'tool_result', ts: now(), id: 't1', content: 'r', isError: false });
    await w.close();

    const data = await store.loadEventsOnly('eo1');
    // Events are preserved verbatim.
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.events.some((e) => e.type === 'user_input')).toBe(true);
    expect(data.events.some((e) => e.type === 'llm_response')).toBe(true);
    // Messages array is empty — this is the whole point of the fast path.
    expect(data.messages).toEqual([]);
    // Metadata is still extracted.
    expect(data.metadata.id).toBe('eo1');
    expect(data.metadata.model).toBe('m');
    expect(data.metadata.provider).toBe('p');
    // Usage is still summed across llm_response events.
    expect(data.usage.input).toBe(7);
    expect(data.usage.output).toBe(11);
  });

  it('reuses the full-load cache when called after load()', async () => {
    const w = await store.create({ id: 'eo2', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'x' });
    await w.close();

    // First call — populates the cache.
    const full = await store.load('eo2');
    expect(full.messages.length).toBeGreaterThan(0);
    // Second call (events-only) — should hit the cache and project to messages=[].
    const eventsOnly = await store.loadEventsOnly('eo2');
    expect(eventsOnly.messages).toEqual([]);
    // Events list is shared with the cached full load.
    expect(eventsOnly.events.length).toBe(full.events.length);
    expect(eventsOnly.metadata.id).toBe('eo2');
  });

  it('reads through the file when cache is cold (no prior full load)', async () => {
    const w = await store.create({ id: 'eo3', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'cold' });
    await w.close();

    // First call is events-only — cache is cold, so it reads through.
    const eventsOnly = await store.loadEventsOnly('eo3');
    expect(eventsOnly.messages).toEqual([]);
    expect(eventsOnly.events.some((e) => e.type === 'user_input')).toBe(true);
    // A subsequent full load sees the same events (no corruption from the cold path).
    const full = await store.load('eo3');
    expect(full.events.length).toBe(eventsOnly.events.length);
  });
});

describe('DefaultSessionStore.rename', () => {
  it('persists a name to the .summary.json sidecar and reflects it in list()', async () => {
    const w = await store.create({ id: '2026-07-04/rn1', model: 'm', provider: 'p' });
    await w.append({
      type: 'user_input',
      ts: now(),
      content: 'hello world this is the first message',
    });
    await w.close();

    const updated = await store.rename('2026-07-04/rn1', 'DB refactor');
    expect(updated.name).toBe('DB refactor');
    expect(updated.title).toContain('hello world');

    const listed = await store.list();
    expect(listed.find((s) => s.id === '2026-07-04/rn1')?.name).toBe('DB refactor');

    const raw = await fs.readFile(path.join(tmp, '2026-07-04', 'rn1.summary.json'), 'utf8');
    expect(JSON.parse(raw).name).toBe('DB refactor');
  });

  it('clears the name when given an empty/whitespace string', async () => {
    const w = await store.create({ id: '2026-07-04/rn2', model: 'm', provider: 'p' });
    await w.close();
    await store.rename('2026-07-04/rn2', 'temp name');
    const cleared = await store.rename('2026-07-04/rn2', '   ');
    expect(cleared.name).toBeUndefined();
    const listed = await store.list();
    expect(listed.find((s) => s.id === '2026-07-04/rn2')?.name).toBeUndefined();
  });

  it('throws "Session not found" when the session JSONL does not exist', async () => {
    await expect(store.rename('2026-07-04/ghost', 'nope')).rejects.toThrow(/Session not found/);
  });

  it('overwrites a previous name on a second rename', async () => {
    const w = await store.create({ id: '2026-07-04/rn3', model: 'm', provider: 'p' });
    await w.close();
    await store.rename('2026-07-04/rn3', 'first');
    const second = await store.rename('2026-07-04/rn3', 'second');
    expect(second.name).toBe('second');
    const listed = await store.list();
    expect(listed.find((s) => s.id === '2026-07-04/rn3')?.name).toBe('second');
  });

  it('preserves a renamed session name after resume and close', { timeout: 5000 }, async () => {
    const id = '2026-07-04/rn4';
    const w = await store.create({ id, model: 'm', provider: 'p' });
    await w.close();
    await store.rename(id, 'Persist across resume');

    const resumed = await store.resume(id);
    await resumed.writer.close();

    const raw = await fs.readFile(path.join(tmp, '2026-07-04', 'rn4.summary.json'), 'utf8');
    expect(JSON.parse(raw).name).toBe('Persist across resume');
    const listed = await store.list();
    expect(listed.find((summary) => summary.id === id)?.name).toBe('Persist across resume');
  });

  it('keeps an active rename authoritative when the open writer closes', async () => {
    const id = '2026-07-04/rn-active';
    const writer = await store.create({ id, model: 'm', provider: 'p' });
    await writer.append({ type: 'user_input', ts: now(), content: 'active work' });
    await writer.flush();

    await store.rename(id, 'Live rename');
    await writer.close();

    const sidecar = JSON.parse(
      await fs.readFile(path.join(tmp, '2026-07-04', 'rn-active.summary.json'), 'utf8'),
    ) as { name?: string; lastUserMessage?: string };
    expect(sidecar).toMatchObject({ name: 'Live rename', lastUserMessage: 'active work' });
    expect((await store.list()).find((summary) => summary.id === id)?.name).toBe('Live rename');
  });

  it('deletes a persisted shard manifest so a cold list sees the renamed value', async () => {
    const id = '2026-07-04/rn-manifest';
    const writer = await store.create({ id, model: 'm', provider: 'p' });
    await writer.close();
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });
    await new DefaultSessionStore({ dir: tmp }).list();
    const shardManifest = path.join(tmp, '2026-07-04', '_manifest.json');
    await expect(fs.access(shardManifest)).resolves.toBeUndefined();

    await store.rename(id, 'Fresh manifest name');
    await expect(fs.access(shardManifest)).rejects.toThrow();
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });
    const listed = await new DefaultSessionStore({ dir: tmp }).list();
    expect(listed.find((summary) => summary.id === id)?.name).toBe('Fresh manifest name');
  });

  it('invalidates a warm shard cache after another store changes the manifest', async () => {
    const id = '2026-07-04/rn-cross-process';
    const writer = await store.create({ id, model: 'm', provider: 'p' });
    await writer.close();
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });

    const warmStore = new DefaultSessionStore({ dir: tmp });
    expect((await warmStore.list()).find((summary) => summary.id === id)?.name).toBeUndefined();

    await store.rename(id, 'Changed by peer store');
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });

    const refreshed = await warmStore.list();
    expect(refreshed.find((summary) => summary.id === id)?.name).toBe('Changed by peer store');
  });

  it('rejects and rolls back the sidecar when the rename index update fails', {
    timeout: 5000,
  }, async () => {
    const id = '2026-07-04/rn-index-failure';
    const writer = await store.create({ id, model: 'm', provider: 'p' });
    await writer.close();
    const sidecarPath = path.join(tmp, '2026-07-04', 'rn-index-failure.summary.json');
    const before = JSON.parse(await fs.readFile(sidecarPath, 'utf8')) as { name?: string };
    (store as never as { appendToIndexStrict(): Promise<void> }).appendToIndexStrict = () =>
      Promise.reject(new Error('index unavailable'));

    await expect(store.rename(id, 'Must be indexed')).rejects.toThrow('index unavailable');
    const after = JSON.parse(await fs.readFile(sidecarPath, 'utf8')) as { name?: string };
    expect(after.name).toBe(before.name);
  });
});

describe('DefaultSessionStore.delete — in-use protection', () => {
  it('ignores legacy project-wide active.json files', async () => {
    const w = await store.create({ id: '2026-07-04/act1', model: 'm', provider: 'p' });
    await w.close();
    // Legacy versions wrote one project-wide lock. It is no longer an
    // ownership authority because concurrent surfaces each own a session.
    await fs.writeFile(
      path.join(tmp, 'active.json'),
      JSON.stringify({
        v: 1,
        sessionId: '2026-07-04/act1',
        pid: 99999,
        hostname: 'other',
        startedAt: now(),
      }),
    );
    await store.delete('2026-07-04/act1');
    await expect(fs.access(path.join(tmp, '2026-07-04', 'act1.jsonl'))).rejects.toThrow();
  });

  it('deletes a session that is not active and not in the registry', async () => {
    const w = await store.create({ id: '2026-07-04/free1', model: 'm', provider: 'p' });
    await w.close();
    await store.delete('2026-07-04/free1');
    await expect(fs.access(path.join(tmp, '2026-07-04', 'free1.jsonl'))).rejects.toThrow();
  });

  it('refuses to delete when the isSessionInUse callback reports in use', async () => {
    let reportInUse = false;
    const guardedStore = new DefaultSessionStore({
      dir: tmp,
      isSessionInUse: async (id) =>
        reportInUse && id === '2026-07-04/regn1' ? 'active in WrongStack (PID 12345)' : null,
    });
    // Setup runs with the flag off: creation itself is legitimate here.
    const w = await guardedStore.create({ id: '2026-07-04/regn1', model: 'm', provider: 'p' });
    await w.close();
    // Simulate a concurrent holder appearing after creation.
    reportInUse = true;
    await expect(guardedStore.delete('2026-07-04/regn1')).rejects.toThrow(/in use/);
    await expect(fs.access(path.join(tmp, '2026-07-04', 'regn1.jsonl'))).resolves.toBeUndefined();
    // A different session is deletable through the same guarded store.
    const w2 = await guardedStore.create({ id: '2026-07-04/regn2', model: 'm', provider: 'p' });
    await w2.close();
    await guardedStore.delete('2026-07-04/regn2');
    await expect(fs.access(path.join(tmp, '2026-07-04', 'regn2.jsonl'))).rejects.toThrow();
  });

  it('create() refuses IDs another process holds live', async () => {
    const guardedStore = new DefaultSessionStore({
      dir: tmp,
      isSessionInUse: async () => 'active in WrongStack (PID 99999)',
    });
    await expect(
      guardedStore.create({ id: '2026-07-04/held1', model: 'm', provider: 'p' }),
    ).rejects.toThrow(/in use/);
    // Nothing was written under the refused id.
    await expect(fs.access(path.join(tmp, '2026-07-04', 'held1.jsonl'))).rejects.toThrow();
  });

  it('still deletes when isSessionInUse resolves null', async () => {
    const guardedStore = new DefaultSessionStore({
      dir: tmp,
      isSessionInUse: async () => null,
    });
    const w = await guardedStore.create({ id: '2026-07-04/gn1', model: 'm', provider: 'p' });
    await w.close();
    await guardedStore.delete('2026-07-04/gn1');
    await expect(fs.access(path.join(tmp, '2026-07-04', 'gn1.jsonl'))).rejects.toThrow();
  });
});
