import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEvent, SessionSummary } from '../../src/index.js';
import { DefaultSessionStore } from '../../src/index.js';
import { totalUsageTokens } from '../../src/types/provider.js';

/**
 * Token and routed-identity attribution across the session journal.
 *
 * Three separate code paths derive `SessionSummary.model`/`provider`/
 * `tokenTotal` from the same JSONL — the live writer's tracker, the
 * disk-rebuild summary builder, and the SQLite catalog's transcript
 * summarizer. They had drifted on both questions this file pins down:
 *
 *  1. tokenTotal counted only `input + output`, dropping the cache buckets.
 *     With prompt caching on, cacheRead is the bulk of a real prompt, so a
 *     measured session listed 118,719 tokens against an actual 2,466,978.
 *     (The catalog summarizer already counted them — hence "drift".)
 *  2. model/provider came only from `session_start`, so a mid-session switch
 *     or a fallback rotation left every summary naming the model the session
 *     merely OPENED with.
 *
 * The fix put the routed identity on `llm_response` (where the usage it
 * produced already lives) and routed all three tokenTotal computations through
 * `totalUsageTokens`. These tests fail if any one of them drifts again.
 */
const ts = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

describe('session token + routed-identity attribution', () => {
  let tmp: string;
  let store: DefaultSessionStore;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tok-attr-'));
    store = new DefaultSessionStore({ dir: tmp });
  });
  afterEach(async () => {
    await store.dispose?.();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /**
   * One response whose prompt was mostly served from cache — the ordinary
   * shape once prompt caching is on, and the one the narrow sum discarded.
   */
  const cachedResponse = (
    at: number,
    model: string,
    provider: string,
  ): Extract<SessionEvent, { type: 'llm_response' }> => ({
    type: 'llm_response',
    ts: ts(at),
    content: [{ type: 'text', text: 'ok' }],
    stopReason: 'end_turn',
    usage: { input: 1_000, output: 100, cacheRead: 90_000, cacheWrite: 500 },
    model,
    provider,
  });

  it('counts cache buckets in tokenTotal and follows a mid-session model switch', async () => {
    const writer = await store.create({
      id: '',
      model: 'opening-model',
      provider: 'opening-provider',
    });
    await writer.append({ type: 'user_input', ts: ts(1), content: 'go' });
    await writer.append(cachedResponse(2, 'opening-model', 'opening-provider'));
    // The switch: same session, different routed target.
    await writer.append(cachedResponse(3, 'switched-model', 'switched-provider'));
    await writer.close();

    const perResponse = totalUsageTokens({
      input: 1_000,
      output: 100,
      cacheRead: 90_000,
      cacheWrite: 500,
    });
    expect(perResponse).toBe(91_600);

    const [summary] = await store.list();
    expect(summary).toBeDefined();
    // Both responses counted, cache included — not 2 × (1000 + 100).
    expect(summary?.tokenTotal).toBe(perResponse * 2);
    // The summary names what actually served the traffic, not what opened it.
    expect(summary?.model).toBe('switched-model');
    expect(summary?.provider).toBe('switched-provider');
  });

  it('rebuilds the same summary from disk as the live writer produced', async () => {
    const writer = await store.create({
      id: '',
      model: 'opening-model',
      provider: 'opening-provider',
    });
    await writer.append({ type: 'user_input', ts: ts(1), content: 'go' });
    await writer.append(cachedResponse(2, 'switched-model', 'switched-provider'));
    await writer.close();

    const live = (await store.list())[0] as SessionSummary;
    // Drop the cached summary sidecar and every index so list() has to
    // re-derive the summary by replaying the JSONL through the builder — the
    // second of the three implementations. Ids are date-sharded, so both live
    // one directory down from the store root.
    const shardDir = path.join(tmp, path.dirname(live.id));
    await fs.rm(path.join(tmp, `${live.id}.summary.json`), { force: true });
    await fs.rm(path.join(shardDir, '_manifest.json'), { force: true });
    await fs.rm(path.join(shardDir, '_index.jsonl'), { force: true });
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });

    const rebuilt = (await store.list())[0] as SessionSummary;
    expect(rebuilt.tokenTotal).toBe(live.tokenTotal);
    expect(rebuilt.model).toBe(live.model);
    expect(rebuilt.provider).toBe(live.provider);
  });

  it('keeps a legacy journal readable when llm_response carries no routed identity', async () => {
    const writer = await store.create({ id: '', model: 'legacy-model', provider: 'legacy-prov' });
    await writer.append({ type: 'user_input', ts: ts(1), content: 'go' });
    // Exactly what a pre-fix writer emitted: usage, no model, no provider.
    await writer.append({
      type: 'llm_response',
      ts: ts(2),
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
    });
    await writer.close();

    const [summary] = await store.list();
    // Falls back to the create-time metadata rather than reporting 'unknown'.
    expect(summary?.model).toBe('legacy-model');
    expect(summary?.provider).toBe('legacy-prov');
    // No cache buckets present — the wide sum degrades to the narrow one.
    expect(summary?.tokenTotal).toBe(15);
  });

  it('takes session_end usage as a floor with cache included', async () => {
    const writer = await store.create({ id: '', model: 'm', provider: 'p' });
    await writer.append({ type: 'user_input', ts: ts(1), content: 'go' });
    // A counter total larger than the journaled responses — the real shape when
    // a resumed session inherits spend it never re-journaled.
    await writer.append({
      type: 'session_end',
      ts: ts(2),
      usage: { input: 5_000, output: 200, cacheRead: 400_000, cacheWrite: 0 },
    });
    await writer.close();

    const [summary] = await store.list();
    expect(summary?.tokenTotal).toBe(405_200);
  });
});

/**
 * `outcome` had the same three-way drift `tokenTotal` did — same journal, two
 * different verdicts depending on whether the `.summary.json` sidecar was warm.
 */
describe('session outcome agreement', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-outcome-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** Write one journal, then read its summary from both producers. */
  const bothVerdicts = async (
    events: SessionEvent[],
  ): Promise<{ live: SessionSummary['outcome']; rebuilt: SessionSummary['outcome'] }> => {
    const store = new DefaultSessionStore({ dir: tmp });
    const writer = await store.create({ id: 'oc', model: 'm', provider: 'p' });
    for (const event of events) await writer.append(event);
    await writer.close();
    const live = (await store.list())[0]?.outcome;
    await store.dispose?.();

    // Drop every cache so list() must replay the JSONL through the builder.
    await fs.rm(path.join(tmp, 'oc.summary.json'), { force: true });
    await fs.rm(path.join(tmp, '_index.jsonl'), { force: true });
    await fs.rm(path.join(tmp, '_manifest.json'), { force: true });
    const reader = new DefaultSessionStore({ dir: tmp });
    const rebuilt = (await reader.list())[0]?.outcome;
    await reader.dispose?.();
    return { live, rebuilt };
  };

  it('lets a trailing session_end outrank an earlier tool failure, both ways', async () => {
    const { live, rebuilt } = await bothVerdicts([
      { type: 'user_input', ts: ts(1), content: 'go' },
      { type: 'tool_result', ts: ts(2), id: 'tu-1', content: 'ENOENT', isError: true },
      {
        type: 'llm_response',
        ts: ts(3),
        content: [{ type: 'text', text: 'recovered' }],
        stopReason: 'end_turn',
        usage: { input: 10, output: 5 },
        model: 'm',
        provider: 'p',
      },
      { type: 'session_end', ts: ts(4), usage: { input: 10, output: 5 } },
    ]);
    // The live tracker used to latch 'error' off the failed tool_result while
    // the rebuild read the terminal marker and said 'completed'.
    expect(live).toBe('completed');
    expect(rebuilt).toBe('completed');
  });

  it('agrees on "aborted" for a journal that ends mid-operation', async () => {
    const { live, rebuilt } = await bothVerdicts([
      { type: 'user_input', ts: ts(1), content: 'go' },
      { type: 'in_flight_start', ts: ts(2), context: 'iteration 0 / tool: bash' },
    ]);
    expect(live).toBe('aborted');
    expect(rebuilt).toBe('aborted');
  });

  it('agrees on "error" when a session error is the last word', async () => {
    const { live, rebuilt } = await bothVerdicts([
      { type: 'user_input', ts: ts(1), content: 'go' },
      { type: 'error', ts: ts(2), message: 'provider exploded', phase: 'agent' },
    ]);
    expect(live).toBe('error');
    expect(rebuilt).toBe('error');
  });

  it('agrees on no verdict when the journal ends with neither marker nor error', async () => {
    const { live, rebuilt } = await bothVerdicts([
      { type: 'user_input', ts: ts(1), content: 'go' },
      { type: 'tool_result', ts: ts(2), id: 'tu-1', content: 'ok', isError: false },
    ]);
    // Claiming 'completed' here is how a killed process looked successful.
    expect(live).toBeUndefined();
    expect(rebuilt).toBeUndefined();
  });
});
