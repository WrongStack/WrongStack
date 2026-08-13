/**
 * End-to-end lock on the property the two unit suites only cover from one side:
 * across a long agentic run, the bytes the provider caches must stay put.
 *
 * A provider's prompt cache is a prefix match. It survives only while the
 * conversation is append-only, so any pass that rewrites an already-transmitted
 * message costs a full re-cache. This drives real turns through the real
 * middleware and the real request composer and asserts the request prefix stays
 * byte-identical except on the deliberate, pressure-gated hygiene turns.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import { createAgentResponseHandler } from '../../src/core/agent-response.js';
import type { Context } from '../../src/core/context.js';
import { AutoCompactionMiddleware } from '../../src/execution/auto-compaction-middleware.js';
import type { Message } from '../../src/types/messages.js';
import type { Request } from '../../src/types/provider.js';
import { createContextEvidenceState } from '../../src/utils/context-evidence.js';

const TURNS = 40;
const MAX_CONTEXT = 60_000;
/** ~2.3k tokens of tool output per turn — enough to cross warn part-way in. */
const RESULT_BODY = 'x'.repeat(8_000);

/**
 * Reduce a message array to what a provider actually hashes.
 *
 * `cache_control` is breakpoint metadata, not cached content, and `_estTokens`
 * is the estimator's per-message memo — both are dropped when a wire adapter
 * builds its body (the Anthropic preset emits `{role, content}` only). Keeping
 * them in the comparison would report phantom prefix breaks.
 */
function wireVisible(messages: readonly Message[]): unknown {
  return JSON.parse(JSON.stringify(messages), (key, value) =>
    key === 'cache_control' || key === '_estTokens' ? undefined : value,
  );
}

/** The part of a request that a later request must reproduce byte-for-byte. */
function cacheablePrefix(messages: readonly Message[]): string {
  // The final message carries the live-context tail, which is volatile by
  // design and always sits after the deepest breakpoint.
  return JSON.stringify(wireVisible(messages.slice(0, messages.length - 1)));
}

function makeHarness() {
  const contextEvidence = createContextEvidenceState();
  const ctx = {
    agentId: 'leader',
    todos: [],
    tools: [],
    systemPrompt: [{ type: 'text', text: 'stable identity prompt' }],
    memoryEvidence: [],
    // Block content, matching what `normalizeInput` appends for real user turns.
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'start the investigation' }] },
    ] as Message[],
    contextEvidence,
    toolAdjacencyDirty: false,
    readFiles: new Set(),
    fileMtimes: new Map(),
    meta: {} as Record<string, unknown>,
    provider: { id: 'test', capabilities: {} },
    model: 'test-model',
    clearFileTracking: () => {},
    waitForModelTransition: vi.fn(async () => {}),
  } as never as Context;

  let revision = 0;
  Object.defineProperty(ctx, 'state', {
    value: {
      get revision() {
        return revision;
      },
      replaceMessages(messages: Message[]) {
        ctx.messages = messages;
        revision++;
      },
    },
  });

  const a = {
    ctx,
    tools: { listForProvider: () => [] },
    pipelines: { request: { run: async (request: Request) => request } },
    events: { emit: vi.fn() },
    logger: { warn: vi.fn() },
  } as never as AgentInternals;

  // A compactor that never rewrites history, so every prefix break observed in
  // this test is attributable to the hygiene pass and nothing else.
  const compactor = {
    compact: async () => ({
      before: 1000,
      after: 1000,
      fullRequestTokensBefore: 1000,
      fullRequestTokensAfter: 1000,
      reductions: [],
    }),
  };

  return { ctx, a, compactor };
}

describe('prompt cache prefix stability across a long run', () => {
  it('keeps the request prefix byte-identical except on gated hygiene turns', async () => {
    const { ctx, a, compactor } = makeHarness();
    const mw = new AutoCompactionMiddleware(compactor, MAX_CONTEXT, undefined, {
      warn: 0.5,
      soft: 0.7,
      hard: 0.9,
    });
    const handler = createAgentResponseHandler(a);
    const run = mw.handler();

    let previousPrefix: string | null = null;
    let brokenPrefixTurns = 0;
    let rewriteTurns = 0;

    for (let turn = 0; turn < TURNS; turn++) {
      const revisionBefore = ctx.state.revision;
      await run(ctx, async (c) => c);
      const rewritten = ctx.state.revision !== revisionBefore;
      if (rewritten) rewriteTurns++;

      const { request } = await handler.buildAndRunRequestPipeline({});
      const prefix = cacheablePrefix(request.messages);

      if (previousPrefix !== null && !prefix.startsWith(previousPrefix.slice(0, -1))) {
        brokenPrefixTurns++;
        // Every break must be explained by a rewrite on the same turn.
        expect(rewritten).toBe(true);
      }
      previousPrefix = prefix;

      ctx.messages.push(
        {
          role: 'assistant',
          content: [
            { type: 'text', text: `step ${turn}` },
            { type: 'tool_use', id: `t${turn}`, name: 'grep', input: { path: `src/${turn}.ts` } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `t${turn}`,
              name: 'grep',
              content: `HEAD_${turn}\n${RESULT_BODY}\nTAIL_${turn}`,
            },
          ],
        },
      );
    }

    // The point of the whole exercise: rewrites are rare events, not per-turn.
    // Measured 4 of 40 at the time of writing; per-turn hygiene made it ~40.
    expect(rewriteTurns).toBeGreaterThan(0);
    expect(rewriteTurns).toBeLessThanOrEqual(6);
    expect(brokenPrefixTurns).toBeLessThanOrEqual(rewriteTurns);
  });

  it('marks the previous turn boundary so each request offers two lookup points', async () => {
    const { ctx, a } = makeHarness();
    const handler = createAgentResponseHandler(a);

    await handler.buildAndRunRequestPipeline({});
    ctx.messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'grep', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'body' }] },
    );
    const { request } = await handler.buildAndRunRequestPipeline({});

    const marked = request.messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => 'cache_control' in block && block.cache_control)
        : [],
    );
    expect(marked).toHaveLength(2);
  });
});
