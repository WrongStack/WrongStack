import { markVolatileSystemBlock, type TextBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider, Request } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import { createAgentResponseHandler } from '../../src/core/agent-response.js';
import { addRequestScopedBlock } from '../../src/core/request-scoped-context.js';
import { SYSTEM_BLOCK_SOURCE } from '../../src/core/system-prompt-blocks.js';
import { createContextEvidenceState } from '../../src/utils/context-evidence.js';
import { getRequestResidency } from '../../src/utils/request-layout.js';

// An ACP agent leading the session (Capabilities.keepsOwnContext) runs its own
// system prompt, tools and history; the ACP provider forwards the trailing user
// message's text to it. Anything WrongStack composes around that message must
// therefore stay off it, or it reaches the agent as if the user typed it.
function harness(provider: Provider, messages: Message[]) {
  const identity: TextBlock = { type: 'text', text: 'identity '.repeat(50) };
  const plan: TextBlock = { type: 'text', text: 'PLAN: step 1 of 3' };
  SYSTEM_BLOCK_SOURCE.set(identity, 'identity');
  SYSTEM_BLOCK_SOURCE.set(plan, 'plan');
  let middlewareRuns = 0;
  const ctx = {
    agentId: 'leader',
    todos: [],
    tools: [{ name: 'read', description: 'read a file', inputSchema: { type: 'object' } }],
    catalogTools: [],
    systemPrompt: [identity, plan],
    memoryEvidence: [{ source: 'sage', text: 'remembered fact' }],
    messages,
    contextEvidence: createContextEvidenceState(),
    toolAdjacencyDirty: false,
    provider,
    model: 'claude-code',
    session: { id: 'thread' },
    meta: { sessionId: 'owner' },
    waitForModelTransition: async () => {},
  } as unknown as AgentInternals['ctx'];
  const a = {
    ctx,
    tools: { listForProvider: () => ctx.tools, list: () => ctx.tools },
    pipelines: {
      request: {
        run: async (request: Request) => {
          middlewareRuns++;
          return {
            ...request,
            system: [
              ...(request.system ?? []),
              markVolatileSystemBlock({
                type: 'text',
                text: '<turn_memory>\nrecall</turn_memory>',
              }),
            ],
          };
        },
      },
    },
    events: { emit: () => {} },
    logger: { warn: () => {} },
  } as unknown as AgentInternals;
  return { ctx, handler: createAgentResponseHandler(a), runs: () => middlewareRuns };
}

const text = (message: Message | undefined): string =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('|');

describe('the request for a provider that keeps its own context', () => {
  const agent = {
    id: 'acp',
    capabilities: { cacheControl: 'none', keepsOwnContext: true, tools: true, systemPrompt: true },
  } as unknown as Provider;

  it('carries the conversation and the next-steps gate: no system prompt, tools, live context or middleware', async () => {
    const history: Message[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'user', content: 'fix the failing test' },
    ];
    const { ctx, handler, runs } = harness(agent, history);
    const { request } = await handler.buildAndRunRequestPipeline({});
    expect(request.system ?? []).toEqual([]);
    expect(request.tools ?? []).toEqual([]);
    expect(request.messages.slice(0, 2).map(text)).toEqual(['first question', 'first answer']);
    const last = text(request.messages.at(-1));
    expect(last.startsWith('fix the failing test|[nextsteps_gate]')).toBe(true);
    // The gate carries the whole policy and never points at a tool the agent cannot call.
    expect(last).toContain('<nextsteps> is optional');
    expect(last).not.toContain('`nextsteps` tool');
    for (const leaked of [
      '[live_context]',
      'PLAN: step 1 of 3',
      'remembered fact',
      '<turn_memory>',
    ]) {
      expect(last).not.toContain(leaked);
    }
    expect(runs()).toBe(0);
    expect(request.cache).toMatchObject({ sessionId: 'owner', threadId: 'thread' });
    // Nothing is measured for the residency report on this route.
    expect(getRequestResidency(ctx)).toBeUndefined();
  });

  it('still delivers mail to the agent, right after its message', async () => {
    const { ctx, handler } = harness(agent, [{ role: 'user', content: 'go on' }]);
    addRequestScopedBlock(ctx, { type: 'text', text: '<mail from="w1">tests pass</mail>' });
    const { request } = await handler.buildAndRunRequestPipeline({});
    expect(text(request.messages.at(-1))).toMatch(
      /^go on\|<mail from="w1">tests pass<\/mail>\|\[nextsteps_gate\]/,
    );
  });

  it('opens a user turn for the additions when the conversation ends on the agent', async () => {
    const { handler } = harness(agent, [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    ]);
    const { request } = await handler.buildAndRunRequestPipeline({});
    expect(request.messages).toHaveLength(3);
    expect(request.messages[2]?.role).toBe('user');
    expect(text(request.messages[2])).toMatch(/^\[nextsteps_gate\]/);
  });

  it('still composes the full request for every other provider', async () => {
    const native = { id: 'anthropic', capabilities: { cacheControl: 'native' } } as Provider;
    const { handler, runs } = harness(native, [{ role: 'user', content: 'fix the failing test' }]);
    const { request } = await handler.buildAndRunRequestPipeline({});
    expect(request.system?.length).toBeGreaterThan(0);
    expect(text(request.messages.at(-1))).toContain('remembered fact');
    expect(runs()).toBe(1);
  });
});
