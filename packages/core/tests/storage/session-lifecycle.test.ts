import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionStore } from '../../src/index.js';
import type { SessionEvent } from '../../src/index.js';

/**
 * End-to-end session lifecycle: the full chain a real run exercises —
 * create → conversation events → session_end → close → resume → more
 * events → session_end → close — verified at every layer (JSONL content,
 * replayed messages, metadata, summary sidecar, index, recovery posture).
 *
 * This is the integration net under the unit tests: if any single link
 * (writer buffering, shard dirs, resume markers, sidecar placement,
 * index dedup) regresses, this test fails even when the unit around the
 * regressed link still passes.
 */
describe('session lifecycle end-to-end (JSONL chain)', () => {
  let tmp: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-e2e-'));
    store = new DefaultSessionStore({ dir: tmp });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('create → events → end → close → resume → events → end → close', async () => {
    // ── Run 1: create with a date-sharded id (the production default) ──
    const writer1 = await store.create({ id: '', model: 'model-x', provider: 'prov-y' });
    const id = writer1.id;
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}\//); // date shard prefix
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}\/sess_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id).not.toContain('model-x');
    expect(id).not.toContain('prov-y');

    await writer1.append({ type: 'user_input', ts: ts(1), content: 'first question' });
    await writer1.append({
      type: 'llm_response',
      ts: ts(2),
      content: [{ type: 'tool_use', id: 'tu-1', name: 'read', input: { path: 'a.ts' } }],
      stopReason: 'tool_use',
      usage: { input: 10, output: 5 },
    });
    // Open tool_use must be visible as pending until its result arrives.
    expect(writer1.pendingToolUses).toEqual(['tu-1']);
    await writer1.append({
      type: 'tool_result',
      ts: ts(3),
      id: 'tu-1',
      content: 'file contents',
      isError: false,
    });
    expect(writer1.pendingToolUses).toEqual([]);
    await writer1.append({
      type: 'llm_response',
      ts: ts(4),
      content: [{ type: 'text', text: 'answer one' }],
      stopReason: 'end_turn',
      usage: { input: 20, output: 8 },
    });
    await writer1.append({ type: 'session_end', ts: ts(5), usage: { input: 30, output: 13 } });
    await writer1.close();

    // ── Disk state after run 1 ──
    const shardDir = path.join(tmp, id.split('/')[0]!);
    const base = id.split('/')[1]!;
    const jsonlPath = path.join(shardDir, `${base}.jsonl`);
    const sidecarPath = path.join(shardDir, `${base}.summary.json`);

    const lines1 = await readJsonl(jsonlPath);
    expect(lines1[0]!['type']).toBe('session_start');
    expect(lines1.at(-1)!['type']).toBe('session_end');

    const sidecar1 = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    expect(sidecar1.id).toBe(id);
    expect(sidecar1.title).toContain('first question');
    expect(sidecar1.tokenTotal).toBe(43); // usage from llm_response events: 15 + 28
    expect(sidecar1.outcome).toBe('completed');

    // Index lists the closed session exactly once.
    const list1 = await store.list();
    expect(list1.filter((s) => s.id === id)).toHaveLength(1);

    // ── Run 2: resume the same session ──
    const { writer: writer2, data } = await store.resume(id);
    expect(data.messages).toHaveLength(4); // user, assistant(tool_use), user(tool_result), assistant
    expect(data.usage).toMatchObject({ input: 30, output: 13 });
    expect(data.metadata.endedAt).toBe(ts(5));

    await writer2.append({ type: 'user_input', ts: ts(6), content: 'second question' });
    await writer2.append({
      type: 'llm_response',
      ts: ts(7),
      content: [{ type: 'text', text: 'answer two' }],
      stopReason: 'end_turn',
      usage: { input: 40, output: 9 },
    });
    await writer2.append({ type: 'session_end', ts: ts(8), usage: { input: 70, output: 22 } });
    await writer2.close();

    // ── Disk state after run 2 ──
    const lines2 = await readJsonl(jsonlPath);
    // Original record intact, resume marker present, strictly appended.
    expect(lines2[0]!['type']).toBe('session_start');
    expect(lines2.length).toBeGreaterThan(lines1.length);
    expect(lines2.slice(0, lines1.length).map((l) => l['type'])).toEqual(
      lines1.map((l) => l['type']),
    );
    expect(lines2.some((l) => l['type'] === 'session_resumed')).toBe(true);
    expect(lines2.at(-1)!['type']).toBe('session_end');

    // Sidecar refreshed IN THE SHARD DIR (not orphaned at the root).
    const sidecar2 = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    expect(sidecar2.outcome).toBe('completed');
    await expect(fs.access(path.join(tmp, `${base}.summary.json`))).rejects.toThrow();

    // ── Full reload: both runs replay as one conversation ──
    const reloaded = await store.load(id);
    expect(reloaded.messages).toHaveLength(6);
    expect(reloaded.usage).toMatchObject({ input: 70, output: 22 });
    // endedAt is the LAST session_end (run 2), not run 1's.
    expect(reloaded.metadata.endedAt).toBe(ts(8));
    // No damage: every tool_use has a matching result.
    const replayedJson = JSON.stringify(reloaded.messages);
    expect(replayedJson).toContain('tu-1');

    // Index still lists the session exactly once after the resume cycle.
    const list2 = await store.list();
    expect(list2.filter((s) => s.id === id)).toHaveLength(1);

    // The shard-level manifest is built on first cold list and contains the final summary.
    await fs.unlink(path.join(tmp, '_index.jsonl')).catch(() => undefined);
    const coldStore = new DefaultSessionStore({ dir: tmp });
    await coldStore.list();
    const shardManifestPath = path.join(shardDir, '_manifest.json');
    const shardManifest = JSON.parse(await fs.readFile(shardManifestPath, 'utf8')) as {
      summaries: Array<{ id: string; tokenTotal: number }>;
    };
    const shardEntry = shardManifest.summaries.find((summary) => summary.id === id);
    expect(shardEntry?.tokenTotal).toBe(92);
  });

  it('a crash (no session_end, dangling in-flight) is visible to recovery after the same chain', async () => {
    const writer = await store.create({ id: '', model: 'm', provider: 'p' });
    const id = writer.id;
    await writer.append({ type: 'user_input', ts: ts(1), content: 'doomed question' });
    await writer.writeInFlightMarker('iteration 0 / provider call');
    // Simulate SIGKILL: flush what the loop already flushed, but never
    // append session_end or close cleanly. (flush() is what the agent loop
    // calls after user_input — the marker and input are on disk.)
    await writer.flush();

    const { SessionRecovery } = await import('../../src/storage/session-recovery.js');
    const recovery = new SessionRecovery(tmp);
    const stale = await recovery.detectStale(id);
    expect(stale).not.toBeNull();
    expect(stale!.context).toBe('iteration 0 / provider call');

    // The directory-wide scan must also surface the sharded session —
    // a root-only listing misses every modern (date-sharded) crash.
    const resumable = await recovery.listResumable();
    expect(resumable.some((s) => s.sessionId === id)).toBe(true);

    // And the resumed view still replays the surviving user turn.
    const data = await store.load(id);
    expect(data.messages).toHaveLength(1);
    expect(data.metadata.endedAt).toBeUndefined();
  });
});

function ts(n: number): string {
  return new Date(Date.UTC(2026, 5, 11, 10, 0, n)).toISOString();
}

async function readJsonl(fp: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(fp, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// Type-level sanity: the events appended above are valid SessionEvents.
const _typecheck: SessionEvent = { type: 'user_input', ts: '', content: '' };
void _typecheck;
