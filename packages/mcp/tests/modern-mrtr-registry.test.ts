import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, UserInputRequest, UserInputResponse } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { expect, it, vi } from 'vitest';
import { elicitViaUserInput } from '../src/elicitation-form.js';
import { MCPRegistry } from '../src/registry.js';

it('routes MRTR user input to the originating run when a newer run uses the same registry', async () => {
  type Pending = { id: number; response: ServerResponse; tag: string };
  let first: Pending | undefined, second: Pending | undefined;
  let firstAsked = false;
  const replies: Array<{ tag: string; answer: string; state: string }> = [];
  const json = (pending: Pending, result: unknown) => {
    pending.response.writeHead(200, { 'content-type': 'application/json' });
    pending.response.end(JSON.stringify({ jsonrpc: '2.0', id: pending.id, result }));
  };
  const ask = (pending: Pending) =>
    json(pending, {
      resultType: 'input_required',
      requestState: pending.tag,
      inputRequests: {
        branch: {
          method: 'elicitation/create',
          params: {
            message: `Choose for ${pending.tag}`,
            requestedSchema: {
              type: 'object',
              properties: { branch: { type: 'string' } },
              required: ['branch'],
            },
          },
        },
      },
    });
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const bytes of request) raw += bytes.toString();
    const message = JSON.parse(raw),
      tag = message.params?.arguments?.tag;
    const pending = { id: message.id, response, tag };
    if (message.method === 'server/discover')
      json(pending, {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
      });
    else if (message.method === 'tools/list')
      json(pending, {
        resultType: 'complete',
        tools: [
          {
            name: 'choose',
            inputSchema: { type: 'object', properties: { tag: { type: 'string' } } },
          },
        ],
      });
    else if (!message.params.inputResponses) {
      if (tag === 'first') first = pending;
      else second = pending;
      if (first && second && !firstAsked) {
        firstAsked = true;
        ask(first);
      }
    } else {
      const answer = message.params.inputResponses.branch.content.branch;
      replies.push({ tag, answer, state: message.params.requestState });
      json(pending, {
        resultType: 'complete',
        content: [{ type: 'text', text: `${tag}:${answer}` }],
      });
      if (tag === 'first') ask(second!);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const toolRegistry = new ToolRegistry();
  const registry = new MCPRegistry({
    toolRegistry,
    events: new EventBus(),
    log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    elicitationHandler: (request) => elicitViaUserInput(request),
  });
  const caller = (value: string) => ({
    signal: new AbortController().signal,
    requestUserInput: vi.fn(
      async (request: UserInputRequest): Promise<UserInputResponse> => ({
        requestId: request.id,
        status: 'submitted',
        answers: [
          { questionId: 'f0', selectedOptionIds: [], text: value, usedRecommendation: false },
        ],
      }),
    ),
  });
  const firstUser = caller('first-user'),
    secondUser = caller('second-user');
  try {
    await registry.start({
      name: 'scope',
      transport: 'streamable-http',
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      allowPrivateNetworks: true,
      requestTimeoutMs: 5000,
    });
    const tool = toolRegistry.list().find((item) => item.name === 'mcp__scope__choose');
    expect(tool).toBeDefined();
    const result = await Promise.all([
      tool!.execute({ tag: 'first' }, firstUser as never, { signal: firstUser.signal }),
      tool!.execute({ tag: 'second' }, secondUser as never, { signal: secondUser.signal }),
    ]);
    expect(result).toEqual(['first:first-user', 'second:second-user']);
    expect(replies).toEqual([
      { tag: 'first', answer: 'first-user', state: 'first' },
      { tag: 'second', answer: 'second-user', state: 'second' },
    ]);
    expect(firstUser.requestUserInput).toHaveBeenCalledTimes(1);
    expect(secondUser.requestUserInput).toHaveBeenCalledTimes(1);
    expect(firstUser.requestUserInput.mock.calls[0]![0].title).toContain('MCP server "scope"');
  } finally {
    await registry.stopAll();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
