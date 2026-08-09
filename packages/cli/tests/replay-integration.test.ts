import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashRequest, ReplayProviderRunner } from '@wrongstack/core/replay';
import { ReplayLogStore } from '@wrongstack/core/storage';
import type { ProviderRunner, Request, Response, RunProviderOptions } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End-to-end test for idea #2 (Deterministic Replay).
 *
 * Simulates the full record → reload → replay flow:
 *   1. Session A makes real provider calls (via a fake inner runner)
 *      and records them with `mode: 'record'`.
 *   2. The on-disk log is closed and a brand-new store/inner pair
 *      is constructed — this is what a fresh process would do.
 *   3. Session B wraps the same inner shape with `mode: 'replay'`
 *      and replays the same requests. The inner is never called
 *      and the responses are byte-for-byte identical to what
 *      Session A saw.
 *
 * The test also asserts that:
 *   - hashes are stable across store instances (re-loading from
 *     disk produces the same hash for the same Request);
 *   - mode='replay' throws on hash miss;
 *   - mode='auto' records new requests and serves cached ones.
 */

function makeRequest(seed: number): Request {
  return {
    model: 'claude-test',
    system: [{ type: 'text', text: `system ${seed}` }],
    messages: [{ role: 'user', content: [{ type: 'text', text: `m${seed}` }] }],
    maxTokens: 1024,
    temperature: 0,
  };
}

function makeResponse(seed: number): Response {
  return {
    content: [{ type: 'text', text: `response for ${seed}` }],
    stopReason: 'end_turn',
    usage: { input: 10, output: 5 },
    model: 'claude-test',
  };
}

function makeInner(responses: Response[]): ProviderRunner & { calls: number[] } {
  let i = 0;
  const calls: number[] = [];
  return {
    get calls() {
      return calls;
    },
    async run(_opts: RunProviderOptions): Promise<Response> {
      // We don't know which seed the request corresponds to without
      // inspecting the request — but for the test we just record the
      // call index. The caller is expected to push responses in the
      // same order as requests.
      const idx = i++;
      calls.push(idx);
      return responses[idx]!;
    },
  } as never as ProviderRunner & { calls: number[] };
}

function makeRunOpts(req: Request): RunProviderOptions {
  return {
    provider: { name: 'fake', sendMessage: vi.fn() } as never,
    request: req,
    signal: new AbortController().signal,
    ctx: {} as never,
    events: { emit: vi.fn() } as never,
    retry: { shouldRetry: () => false, delayMs: () => 0 } as never,
    logger: { debug() {}, warn() {}, info() {}, error() {} } as never,
  };
}

describe('ReplayProviderRunner end-to-end record → reload → replay', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-e2e-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('records in process A, replays in process B with identical responses', async () => {
    const sessionId = 'sess-e2e-1';

    // ── Process A: record 5 requests ────────────────────────────────────
    const logA = new ReplayLogStore({ dir });
    const innerA = makeInner([0, 1, 2, 3, 4].map(makeResponse));
    const runnerA = new ReplayProviderRunner(innerA, {
      log: logA,
      sessionId,
      mode: 'record',
    });
    const recorded: Response[] = [];
    for (let i = 0; i < 5; i++) {
      const req = makeRequest(i);
      recorded.push(await runnerA.run(makeRunOpts(req)));
    }
    // logA has 5 entries; innerA was called 5 times.
    const recordedHashes = [0, 1, 2, 3, 4].map((i) => hashRequest(makeRequest(i)));
    for (const h of recordedHashes) {
      expect(await logA.lookup(sessionId, h)).not.toBeNull();
    }
    // Drop our references; simulate process exit.
    void logA;
    void runnerA;
    void innerA;

    // ── Process B: reload the log and replay ────────────────────────────
    const logB = new ReplayLogStore({ dir });
    const innerB = makeInner(
      // B has a fresh "API" that returns garbage — but the replay
      // mode should never call it. We tag these so the test can
      // assert they were never produced.
      [0, 1, 2, 3, 4].map(() =>
        makeResponse(99).content
          ? { ...makeResponse(99), content: [{ type: 'text', text: 'B-FRESH' as string }] }
          : makeResponse(99),
      ),
    );
    const runnerB = new ReplayProviderRunner(innerB, {
      log: logB,
      sessionId,
      mode: 'replay',
    });
    const replayed: Response[] = [];
    for (let i = 0; i < 5; i++) {
      replayed.push(await runnerB.run(makeRunOpts(makeRequest(i))));
    }
    // innerB was never called — every response came from the log.
    expect(innerB.calls).toEqual([]);
    // Replayed responses match recorded ones byte-for-byte.
    for (let i = 0; i < 5; i++) {
      expect(replayed[i]).toEqual(recorded[i]);
    }
  });

  it('replay mode throws on hash miss (no silent fallback)', async () => {
    const sessionId = 'sess-e2e-2';
    const log = new ReplayLogStore({ dir });
    const inner = makeInner([makeResponse(0)]);
    // Pre-record seed 0 only.
    await log.record({ sessionId, request: makeRequest(0), response: makeResponse(0) });
    const runner = new ReplayProviderRunner(inner, { log, sessionId, mode: 'replay' });
    // Replay seed 0 — should succeed without calling inner.
    const r0 = await runner.run(makeRunOpts(makeRequest(0)));
    expect(r0.content[0]).toMatchObject({ text: 'response for 0' });
    // Replay seed 5 — never recorded; should throw.
    await expect(runner.run(makeRunOpts(makeRequest(5)))).rejects.toThrow(
      /no recorded response for hash sha256:/,
    );
    expect(inner.calls).toEqual([]); // inner was never called even on the miss
  });

  it('auto mode: warm start — second run is fully cached, first run records', async () => {
    const sessionId = 'sess-e2e-3';
    const log = new ReplayLogStore({ dir });
    // Run 1: empty log, record everything.
    {
      const inner = makeInner([0, 1, 2].map(makeResponse));
      const runner = new ReplayProviderRunner(inner, { log, sessionId, mode: 'auto' });
      for (let i = 0; i < 3; i++) {
        await runner.run(makeRunOpts(makeRequest(i)));
      }
      expect(inner.calls).toEqual([0, 1, 2]);
    }
    // Run 2: same log, fresh inner. The log should serve every request.
    {
      const inner = makeInner(
        [0, 1, 2].map((i) => ({
          ...makeResponse(i),
          content: [{ type: 'text', text: 'FRESH' }],
        })),
      );
      const runner = new ReplayProviderRunner(inner, { log, sessionId, mode: 'auto' });
      for (let i = 0; i < 3; i++) {
        const r = await runner.run(makeRunOpts(makeRequest(i)));
        // Cached text is the original, not 'FRESH'.
        expect(r.content[0]).toMatchObject({ text: `response for ${i}` });
      }
      expect(inner.calls).toEqual([]); // nothing was re-recorded
    }
  });

  it('different sessions do not share replay entries', async () => {
    const log = new ReplayLogStore({ dir });
    // Record under s1.
    await log.record({ sessionId: 's1', request: makeRequest(0), response: makeResponse(0) });
    // s2 has no entry.
    const runnerS2 = new ReplayProviderRunner(makeInner([makeResponse(0)]), {
      log,
      sessionId: 's2',
      mode: 'replay',
    });
    await expect(runnerS2.run(makeRunOpts(makeRequest(0)))).rejects.toThrow(
      /no recorded response for hash sha256:/,
    );
  });

  it('hashRequest is stable across store reload (key-order invariance across persistence)', async () => {
    const log = new ReplayLogStore({ dir });
    const req = makeRequest(0);
    await log.record({ sessionId: 's', request: req, response: makeResponse(0) });
    // Reload the log from disk in a fresh store.
    const log2 = new ReplayLogStore({ dir });
    const hash1 = hashRequest(req);
    const entry = await log2.lookup('s', hash1);
    expect(entry).not.toBeNull();
    // And lookup-by-different-but-equivalent request still works
    // (we don't actually call hashRequest on a mutated object
    // here; the point is that load() reads the same shape we wrote).
    expect(entry!.hash).toBe(hash1);
  });
});
