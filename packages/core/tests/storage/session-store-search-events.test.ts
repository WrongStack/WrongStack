/**
 * Regression tests for DefaultSessionStore.searchEvents — the streaming
 * JSONL walker that DefaultSessionReader.search uses as its fast path.
 *
 * The contract is:
 *  - Walks each event once, parses lazily, only yields matches.
 *  - Stops at `limit`.
 *  - Skips malformed lines (same policy as `load()`).
 *  - Handles missing files by returning [] (matches load's ENOENT path).
 *  - Respects `eventIndex` (0-based, monotonic across the file).
 *  - Honors `signal` for early termination.
 *  - Tolerates chunk boundaries (lines longer than CHUNK; the trailing
 *    partial line must carry forward).
 *
 * These tests also cover the perf invariant indirectly: a session with
 * 100k events must not allocate ~100k objects when only the first 5
 * matches are wanted.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSessionStore } from '../../src/index.js';
import type { SessionEvent } from '../../src/types/session.js';

describe('DefaultSessionStore.searchEvents — streaming walker', () => {
  let tmp: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-srch-'));
    store = new DefaultSessionStore({ dir: tmp });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Append a synthetic event JSONL line to the session file. */
  async function append(id: string, ev: SessionEvent): Promise<void> {
    const file = path.join(tmp, `${id}.jsonl`);
    await fs.appendFile(file, JSON.stringify(ev) + '\n', 'utf8');
  }

  /** Build a complete minimal session_start line. */
  function sessionStart(id: string, ts: string): SessionEvent {
    return {
      type: 'session_start',
      ts,
      id,
      model: 'test-model',
      provider: 'test-provider',
    };
  }

  it('returns [] for a missing session', async () => {
    const out = await store.searchEvents('nope', () => true);
    expect(out).toEqual([]);
  });

  it('returns [] for an empty file', async () => {
    await fs.writeFile(path.join(tmp, 'empty.jsonl'), '', 'utf8');
    const out = await store.searchEvents('empty', () => true);
    expect(out).toEqual([]);
  });

  it('yields only events for which the predicate is true', async () => {
    const ts = (n: number) => `2026-06-26T10:00:${String(n).padStart(2, '0')}.000Z`;
    await append('s', sessionStart('s', ts(0)));
    for (let i = 1; i <= 5; i++) {
      await append('s', {
        type: 'user_input',
        ts: ts(i),
        content: `message-${i}`,
      });
    }
    const out = await store.searchEvents(
      's',
      (ev) => ev.type === 'user_input' && (ev as { content: string }).content === 'message-3',
    );
    expect(out).toHaveLength(1);
    // session_start=0, message-1=1, message-2=2, message-3=3.
    expect(out[0]?.eventIndex).toBe(3);
    expect((out[0]!.event as { content: string }).content).toBe('message-3');
  });

  it('assigns eventIndex monotonically, skipping malformed lines', async () => {
    const file = path.join(tmp, 's.jsonl');
    const lines = [
      JSON.stringify({
        type: 'session_start',
        ts: '2026-06-26T10:00:00.000Z',
        model: 'm',
        provider: 'p',
      }),
      'this is not json',
      JSON.stringify({ type: 'user_input', ts: '2026-06-26T10:00:01.000Z', content: 'alpha' }),
      '{"type":"unknown_future_type","ts":"2026-06-26T10:00:02.000Z"}', // shape-valid but unknown type
      JSON.stringify({ type: 'user_input', ts: '2026-06-26T10:00:03.000Z', content: 'beta' }),
    ];
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');

    const out = await store.searchEvents('s', (ev) => ev.type === 'user_input');
    // Indices reflect lines that PASSED the shape guard (including the
    // unknown-but-shape-valid future type), in document order:
    //   0=session_start, 1=alpha (user_input), 2=unknown_future_type, 3=beta.
    expect(out.map((m) => m.eventIndex)).toEqual([1, 3]);
    expect((out[0]!.event as { content: string }).content).toBe('alpha');
    expect((out[1]!.event as { content: string }).content).toBe('beta');
  });

  it('skips lines missing the required shape (no type, no ts)', async () => {
    const file = path.join(tmp, 's.jsonl');
    const lines = [
      JSON.stringify({
        type: 'session_start',
        ts: '2026-06-26T10:00:00.000Z',
        model: 'm',
        provider: 'p',
      }),
      JSON.stringify({ ts: '2026-06-26T10:00:01.000Z' }), // no type
      JSON.stringify({ type: 'user_input' }), // no ts
      JSON.stringify({ type: 'user_input', ts: '2026-06-26T10:00:02.000Z', content: 'kept' }),
      'null',
      JSON.stringify(null), // valid JSON, wrong shape
    ];
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');

    const out = await store.searchEvents('s', (ev) => ev.type === 'user_input');
    expect(out).toHaveLength(1);
    expect((out[0]!.event as { content: string }).content).toBe('kept');
    // The kept event is the 4th line in the file but only the 2nd that
    // passes the shape guard (after session_start at index 0).
    expect(out[0]?.eventIndex).toBe(1);
  });

  it('stops walking once limit matches are collected', async () => {
    const file = path.join(tmp, 's.jsonl');
    const lines: string[] = [
      JSON.stringify({
        type: 'session_start',
        ts: '2026-06-26T10:00:00.000Z',
        model: 'm',
        provider: 'p',
      }),
    ];
    // 1000 user_input events, every one a match.
    for (let i = 1; i <= 1000; i++) {
      lines.push(
        JSON.stringify({
          type: 'user_input',
          ts: `2026-06-26T10:00:${String(i).padStart(2, '0')}.000Z`,
          content: `m-${i}`,
        }),
      );
    }
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');

    const out = await store.searchEvents('s', () => true, { limit: 5 });
    expect(out).toHaveLength(5);
    // The 5 collected events are session_start (index 0) plus the first 4
    // user_inputs. We never see eventIndex 5 because the walker stops the
    // moment the 5th hit is collected.
    expect(out.map((m) => m.eventIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('handles a trailing line without a final newline', async () => {
    const file = path.join(tmp, 's.jsonl');
    // session_start with newline, then a single user_input WITHOUT newline.
    await fs.writeFile(
      file,
      JSON.stringify({
        type: 'session_start',
        ts: '2026-06-26T10:00:00.000Z',
        model: 'm',
        provider: 'p',
      }) +
        '\n' +
        JSON.stringify({ type: 'user_input', ts: '2026-06-26T10:00:01.000Z', content: 'tail' }),
      'utf8',
    );

    const out = await store.searchEvents('s', (ev) => ev.type === 'user_input');
    expect(out).toHaveLength(1);
    expect((out[0]!.event as { content: string }).content).toBe('tail');
  });

  it('drops a partial trailing line (truncated JSON)', async () => {
    // File consists ONLY of a partial trailing line — no complete events.
    // The walker should not throw, not synthesize a false hit, and not
    // allocate a fake eventIndex for the leftover.
    const file = path.join(tmp, 's.jsonl');
    await fs.writeFile(file, '{"type":"user_input","ts":"2026-06-26T10:00:01.000Z",', 'utf8');

    const out = await store.searchEvents('s', () => true);
    expect(out).toEqual([]);
  });

  it('does not allocate parse work past the limit (matches budget)', async () => {
    // Construct a session with 5000 events; only the first 3 user_inputs
    // match. We count predicate invocations to confirm we stop early.
    const file = path.join(tmp, 's.jsonl');
    const lines: string[] = [
      JSON.stringify({
        type: 'session_start',
        ts: '2026-06-26T10:00:00.000Z',
        model: 'm',
        provider: 'p',
      }),
    ];
    for (let i = 1; i <= 5000; i++) {
      // Only the first 3 user_inputs match; the rest are llm_response (no
      // match). The walker should stop scanning after the 3rd user_input
      // is collected.
      const isMatch = i <= 3;
      lines.push(
        JSON.stringify({
          type: isMatch ? 'user_input' : 'llm_response',
          ts: `2026-06-26T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
          content: isMatch ? `MATCH-${i}` : 'no',
        }),
      );
    }
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');

    let calls = 0;
    const out = await store.searchEvents(
      's',
      (ev) => {
        calls++;
        return ev.type === 'user_input';
      },
      { limit: 3 },
    );
    expect(out).toHaveLength(3);
    // The first match is at line 2 (eventIndex 1). After we collect the
    // 3rd match, we return without walking the remaining ~4997 events.
    // We give some slack for the chunk boundary edge cases — the
    // important assertion is "fewer than 5000".
    expect(calls).toBeLessThan(100);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('honors an AbortSignal between chunks', async () => {
    const file = path.join(tmp, 's.jsonl');
    const lines: string[] = [
      JSON.stringify({
        type: 'session_start',
        ts: '2026-06-26T10:00:00.000Z',
        model: 'm',
        provider: 'p',
      }),
    ];
    // Force multiple read() iterations: 256 events × ~80 bytes = 20KB,
    // comfortably above the 64KB chunk size with a few dozen chunks worth
    // when we add padding to the content. We'll skip that and rely on
    // the smaller default chunk to ensure at least 2 iterations.
    for (let i = 1; i <= 4000; i++) {
      lines.push(
        JSON.stringify({
          type: 'user_input',
          ts: `2026-06-26T10:00:00.${String(i).padStart(3, '0')}Z`,
          content: 'x'.repeat(40),
        }),
      );
    }
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');

    const controller = new AbortController();
    let calls = 0;
    const promise = store.searchEvents(
      's',
      (_ev) => {
        calls++;
        // Abort after the 2nd event is seen — the next chunk read should
        // throw AbortError.
        if (calls >= 2) controller.abort();
        return true;
      },
      { signal: controller.signal },
    );

    await expect(promise).rejects.toThrow();
  });

  it('handles lines longer than the read chunk (boundary carry)', async () => {
    // 64KB chunk size; emit a single user_input whose serialized form
    // exceeds that, mixed with normal-sized events on either side.
    const file = path.join(tmp, 's.jsonl');
    const bigContent = 'B'.repeat(80_000);
    const lines = [
      JSON.stringify({
        type: 'session_start',
        ts: '2026-06-26T10:00:00.000Z',
        model: 'm',
        provider: 'p',
      }),
      JSON.stringify({
        type: 'user_input',
        ts: '2026-06-26T10:00:01.000Z',
        content: bigContent,
      }),
      JSON.stringify({ type: 'user_input', ts: '2026-06-26T10:00:02.000Z', content: 'after-big' }),
    ];
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');

    const out = await store.searchEvents('s', (ev) => ev.type === 'user_input');
    expect(out).toHaveLength(2);
    expect((out[0]!.event as { content: string }).content.length).toBe(80_000);
    expect((out[1]!.event as { content: string }).content).toBe('after-big');
    // eventIndex is independent of payload size.
    expect(out[0]?.eventIndex).toBe(1);
    expect(out[1]?.eventIndex).toBe(2);
  });

  it('preserves multi-byte UTF-8 split across the 64KB read boundary', async () => {
    const file = path.join(tmp, 'utf8.jsonl');
    const prefix = JSON.stringify({
      type: 'user_input',
      ts: '2026-06-26T10:00:01.000Z',
      content: '',
    });
    const contentPrefix = prefix.slice(0, -2);
    const contentSuffix = prefix.slice(-2);
    const target = 64 * 1024 - Buffer.byteLength(`${contentPrefix}\n`, 'utf8') - 1;
    const splitContent = `${'a'.repeat(target)}ğ-NEEDLE`;
    await fs.writeFile(file, `${contentPrefix}${splitContent}${contentSuffix}\n`, 'utf8');

    const out = await store.searchEvents(
      'utf8',
      (ev) => ev.type === 'user_input' && String(ev.content).includes('ğ-NEEDLE'),
    );
    expect(out).toHaveLength(1);
    expect(String((out[0]!.event as { content: string }).content)).not.toContain('\uFFFD');
  });
});
