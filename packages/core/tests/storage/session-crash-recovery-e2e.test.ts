/**
 * Crash-to-recovery, exercised against the real writer and reader.
 *
 * The in-process resume/recovery unit tests all pass on a journal that was
 * closed politely. These cover what happens when it was not: a write torn
 * mid-line by power loss, a process that vanished without a `session_end`, and
 * a journal that is empty or pure garbage. A companion test
 * (`session-crash-sigkill.test.ts`) does the same against a real SIGKILLed
 * child process.
 *
 * What these pin down:
 *  - the loader skips a torn trailing line without losing the events before it;
 *  - `SessionRecovery` reports the dangling in-flight context verbatim and names
 *    the interrupted tool call, so an operator sees what the agent was doing;
 *  - resuming a crashed journal heals it — the synthetic tool_result closes the
 *    dangling call, the session finishes, and it stops being listed resumable;
 *  - `outcome` follows the journal (`completed` after a clean end) instead of
 *    latching on an error the session already recovered from;
 *  - a zero-byte or garbage journal never throws on the listing path.
 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractInterruptedTools, SessionRecovery } from '../../src/storage/session-recovery.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { SessionEvent } from '../../src/types/session.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs
      .splice(0)
      .map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  ),
);

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crash-recovery-'));
  dirs.push(dir);
  return dir;
}

const journalTypes = async (dir: string, id: string): Promise<Array<SessionEvent['type']>> =>
  (await readFile(path.join(dir, `${id}.jsonl`), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as SessionEvent).type);

describe('crash recovery end-to-end', () => {
  it('skips a line torn mid-write and keeps every event before it', async () => {
    const dir = await tempDir();
    const store = new DefaultSessionStore({ dir });
    const writer = await store.create({ id: 'torn', model: 'm', provider: 'p' });
    await writer.append({ type: 'user_input', ts: '2026-01-01T00:00:01.000Z', content: 'hello' });
    await writer.append({
      type: 'llm_response',
      ts: '2026-01-01T00:00:02.000Z',
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5, cacheRead: 1_000 },
      model: 'routed-model',
      provider: 'routed-provider',
    });
    await writer.flush();
    // Power cut mid-write: a half-serialized JSON line with no terminator.
    await appendFile(
      path.join(dir, 'torn.jsonl'),
      '{"type":"llm_response","ts":"2026-01-01T00:00:03.0',
    );
    await writer.close().catch(() => {});

    const reader = new DefaultSessionStore({ dir });
    const data = await reader.load('torn');
    expect(data.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // Cache buckets survive the round trip, and the torn line contributes nothing.
    expect(data.usage).toMatchObject({ input: 10, output: 5, cacheRead: 1_000 });

    const [summary] = await reader.list();
    expect(summary?.tokenTotal).toBe(1_015);
    expect(summary?.model).toBe('routed-model');
    await reader.dispose?.();
  });

  it('heals a journal that lost its process: recover, resume, finish, reload', async () => {
    const dir = await tempDir();
    const store = new DefaultSessionStore({ dir });
    const writer = await store.create({ id: 'cont', model: 'm', provider: 'p' });
    await writer.append({ type: 'user_input', ts: '2026-01-01T00:00:01.000Z', content: 'first' });
    await writer.writeInFlightMarker('iteration 0 / tool: bash');
    await writer.append({
      type: 'llm_response',
      ts: '2026-01-01T00:00:02.000Z',
      content: [{ type: 'tool_use', id: 'tu-9', name: 'bash', input: { command: 'ls' } }],
      stopReason: 'tool_use',
      usage: { input: 50, output: 5 },
      model: 'm',
      provider: 'p',
    });
    await writer.flush();
    // The process dies here: no session_end, no close().

    const plan = await new SessionRecovery(dir).recover('cont');
    expect(plan?.stale).toBe(true);
    // Verbatim context is the whole point of the in-flight marker — it is what
    // the recovery UI shows for "what was the agent doing when it died?".
    expect(plan?.context).toBe('iteration 0 / tool: bash');
    expect(extractInterruptedTools(plan!).map((t) => ({ id: t.id, name: t.name }))).toEqual([
      { id: 'tu-9', name: 'bash' },
    ]);

    const store2 = new DefaultSessionStore({ dir });
    const resumed = await store2.resume('cont');
    // The dangling tool_use is healed in the returned model context too, not
    // only in the JSONL file that resume() appends to.
    expect(resumed.data.pendingToolUseCount ?? 0).toBe(0);
    expect(JSON.stringify(resumed.data.messages)).toContain('"tool_use_id":"tu-9"');
    expect(JSON.stringify(resumed.data.messages)).toContain('[interrupted]');

    // Carry on working on the resumed writer, then shut down cleanly.
    await resumed.writer.append({
      type: 'user_input',
      ts: '2026-01-01T00:00:10.000Z',
      content: 'second',
    });
    await resumed.writer.append({
      type: 'llm_response',
      ts: '2026-01-01T00:00:11.000Z',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input: 20, output: 3, cacheRead: 400 },
      model: 'later-model',
      provider: 'later-provider',
    });
    await resumed.writer.clearInFlightMarker('recovered');
    await resumed.writer.append({
      type: 'session_end',
      ts: '2026-01-01T00:00:12.000Z',
      usage: { input: 70, output: 8, cacheRead: 400 },
    });
    await resumed.writer.close();

    const types = await journalTypes(dir, 'cont');
    // resume() injected the synthetic tool_result that closes tu-9.
    expect(types).toEqual([
      'session_start',
      'user_input',
      'in_flight_start',
      'llm_response',
      'session_resumed',
      'tool_result',
      'in_flight_end',
      'user_input',
      'llm_response',
      'in_flight_end',
      'session_end',
    ]);

    const store3 = new DefaultSessionStore({ dir });
    // The heal is real: nothing is left dangling, so it is no longer offered.
    expect(await new SessionRecovery(dir).listResumable()).toEqual([]);

    const [summary] = await store3.list();
    // A recovered-and-finished session reads as completed. The synthetic
    // tool_result is an errored one, which used to latch outcome to 'error'
    // permanently — branding every successful recovery a failure.
    expect(summary?.outcome).toBe('completed');
    expect(summary?.model).toBe('later-model');

    // With tu-9 now closed, the assistant turn that carried it replays.
    const reloaded = await store3.load('cont');
    expect(reloaded.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
      'assistant',
    ]);
    // Absent means none: the field is only written when a call is left open.
    expect(reloaded.pendingToolUseCount ?? 0).toBe(0);
    await store2.dispose?.();
    await store3.dispose?.();
  });

  it('reads an empty or garbage journal without throwing', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'empty.jsonl'), '');
    await writeFile(path.join(dir, 'garbage.jsonl'), 'not json at all\n{{{\n');
    const store = new DefaultSessionStore({ dir });

    const list = await store.list();
    expect(list).toHaveLength(2);
    // Neither is mistakable for recoverable work.
    expect(await new SessionRecovery(dir).listResumable()).toEqual([]);
    for (const entry of list) {
      expect(entry.tokenTotal).toBe(0);
      expect(entry.outcome).toBeUndefined();
    }
    await store.dispose?.();
  });
});
