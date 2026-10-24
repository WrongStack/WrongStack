import type { Provider } from '@wrongstack/contracts/types';
import type { FallbackSuggestCandidate } from '@wrongstack/core/models';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleFallbackSuggest } from '../src/server/fallback-suggest-handler.js';
import type { WSServerMessage } from '../src/server/types.js';

const ws = {} as WebSocket;
const tools = ['tools', 'reasoning'];
const POOL: FallbackSuggestCandidate[] = [
  {
    provider: 'zai',
    model: 'glm-5.3',
    releaseDate: '2026-08-14',
    inputCost: 0.6,
    outputCost: 2.2,
    capabilities: tools,
  },
  {
    provider: 'zai',
    model: 'glm-5.3-flash',
    releaseDate: '2026-08-26',
    inputCost: 0.1,
    outputCost: 0.4,
    capabilities: tools,
  },
  {
    provider: 'minimax',
    model: 'MiniMax-M3',
    releaseDate: '2026-06-01',
    inputCost: 0.3,
    outputCost: 1.2,
    capabilities: tools,
  },
  {
    provider: 'opencode',
    model: 'claude-opus-5-5',
    releaseDate: '2026-09-22',
    inputCost: 15,
    outputCost: 75,
    capabilities: tools,
  },
];

function fakeProvider(reply: string | Error): Provider {
  return {
    id: 'zai',
    capabilities: { structuredOutput: false, jsonMode: true },
    complete: vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return { content: [{ type: 'text', text: reply }] };
    }),
  } as unknown as Provider;
}

async function run(payload: unknown, provider?: Provider) {
  const sent: WSServerMessage[] = [];
  await handleFallbackSuggest(ws, payload, {
    collectCandidates: async () => POOL,
    resolveLlm: () => ({ provider, model: provider ? 'glm-5.3' : undefined }),
    send: (_ws, message) => sent.push(message),
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.type).toBe('fallback.suggestions');
  return sent[0]?.payload as {
    requestId?: string;
    mode: string;
    suggestions: Array<{ id: string; chain: string[]; source: string }>;
    candidateCount: number;
    llmModel?: string;
    error?: string;
    rejected?: number;
  };
}

describe('fallback.suggest handler', () => {
  it('answers heuristic suggestions drawn only from the reachable pool', async () => {
    const out = await run({ requestId: 'r1' });
    expect(out.requestId).toBe('r1');
    expect(out.mode).toBe('heuristic');
    expect(out.candidateCount).toBe(4);
    const reachable = new Set(POOL.map((c) => `${c.provider}/${c.model}`));
    for (const s of out.suggestions)
      for (const ref of s.chain) expect(reachable.has(ref)).toBe(true);
  });

  it('applies a validated LLM re-rank and names the model that ran it', async () => {
    const provider = fakeProvider(
      JSON.stringify({
        profiles: [
          { id: 'strong', chain: ['zai/glm-5.3', 'opencode/claude-opus-5-5'], rationale: 'r' },
        ],
      }),
    );
    const out = await run({ mode: 'llm' }, provider);
    expect(out.mode).toBe('llm');
    expect(out.llmModel).toBe('zai/glm-5.3');
    expect(out.error).toBeUndefined();
    const strong = out.suggestions.find((s) => s.id === 'strong');
    expect(strong?.source).toBe('llm');
    expect(strong?.chain).toEqual(['zai/glm-5.3', 'opencode/claude-opus-5-5']);
  });

  it('keeps the heuristic result and reports why when the LLM invents a model', async () => {
    const provider = fakeProvider(
      JSON.stringify({ profiles: [{ id: 'strong', chain: ['zai/glm-9', 'zai/glm-5.3'] }] }),
    );
    const out = await run({ mode: 'llm' }, provider);
    expect(out.rejected).toBe(1);
    expect(out.error).toMatch(/heuristic/);
    expect(out.suggestions.every((s) => s.source === 'heuristic')).toBe(true);
    expect(out.suggestions.length).toBeGreaterThan(0);
  });

  it('degrades to the heuristic result when the provider call fails', async () => {
    const out = await run({ mode: 'llm' }, fakeProvider(new Error('429 rate limited')));
    expect(out.error).toBe('429 rate limited');
    expect(out.suggestions.length).toBeGreaterThan(0);
  });

  it('never suggests a model or provider the tab has disabled', async () => {
    const out = await run({
      disabledModels: ['opencode/claude-opus-5-5', 'glm-5.3-flash'],
      disabledProviders: ['MiniMax'],
    });
    expect(out.candidateCount).toBe(1);
    const used = out.suggestions.flatMap((s) => s.chain);
    expect(used).not.toContain('opencode/claude-opus-5-5');
    expect(used).not.toContain('zai/glm-5.3-flash');
    expect(used.some((ref) => ref.startsWith('minimax/'))).toBe(false);
  });

  it('reports a missing live model instead of silently skipping the LLM pass', async () => {
    const out = await run({ mode: 'llm' });
    expect(out.error).toMatch(/No active model/);
    expect(out.suggestions.length).toBeGreaterThan(0);
  });
});
