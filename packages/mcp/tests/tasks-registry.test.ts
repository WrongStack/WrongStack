import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger, UserInputRequest, UserInputResponse } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { expect, it, vi } from 'vitest';
import { elicitViaUserInput } from '../src/elicitation-form.js';
import { MCPRegistry } from '../src/registry.js';

it('delivers task user input to its originating run while another run uses the same registry', async () => {
  type Pending = { id: number; response: ServerResponse; tag: string };
  const pendingPolls = new Map<string, Pending>();
  const answers = new Map<string, string>();
  const createdAt = new Date().toISOString();
  const task = (tag: string) => ({
    taskId: tag,
    status: 'working',
    createdAt,
    lastUpdatedAt: createdAt,
    ttlMs: null,
    pollIntervalMs: 1,
  });
  const json = (pending: Pending, result: unknown) => {
    pending.response.writeHead(200, { 'content-type': 'application/json' });
    pending.response.end(JSON.stringify({ jsonrpc: '2.0', id: pending.id, result }));
  };
  const ask = (pending: Pending) =>
    json(pending, {
      resultType: 'complete',
      ...task(pending.tag),
      status: 'input_required',
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
  let toolCalls = 0,
    firstAsked = false;
  const server = createServer(async (req, response) => {
    let raw = '';
    for await (const bytes of req) raw += bytes.toString();
    const message = JSON.parse(raw);
    const tag = message.params?.taskId ?? message.params?.arguments?.tag;
    const pending = { id: message.id, response, tag };
    if (message.method === 'server/discover')
      json(pending, {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } },
      });
    else if (message.method === 'tools/list')
      json(pending, {
        resultType: 'complete',
        tools: [{ name: 'build', inputSchema: { type: 'object' } }],
      });
    else if (message.method === 'tools/call') {
      toolCalls++;
      json(pending, { resultType: 'task', ...task(tag) });
    } else if (message.method === 'tasks/update') {
      answers.set(tag, message.params.inputResponses.branch.content.branch);
      json(pending, { resultType: 'complete' });
      if (tag === 'first') ask(pendingPolls.get('second')!);
    } else if (answers.has(tag))
      json(pending, {
        resultType: 'complete',
        ...task(tag),
        status: 'completed',
        result: { content: [{ type: 'text', text: `${tag}:${answers.get(tag)}` }] },
      });
    else {
      pendingPolls.set(tag, pending);
      if (pendingPolls.has('first') && pendingPolls.has('second') && !firstAsked) {
        firstAsked = true;
        ask(pendingPolls.get('first')!);
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tools = new ToolRegistry();
  const registry = new MCPRegistry({
    toolRegistry: tools,
    events: new EventBus(),
    log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    elicitationHandler: elicitViaUserInput,
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
  const first = caller('first-user'),
    second = caller('second-user');
  try {
    await registry.start({
      name: 'tasks',
      transport: 'streamable-http',
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      allowPrivateNetworks: true,
      requestTimeoutMs: 5000,
    });
    const tool = tools.list().find((t) => t.name === 'mcp__tasks__build')!;
    expect(
      await Promise.all([
        tool.execute({ tag: 'first' }, first as never, { signal: first.signal }),
        tool.execute({ tag: 'second' }, second as never, { signal: second.signal }),
      ]),
    ).toEqual(['first:first-user', 'second:second-user']);
    expect(toolCalls).toBe(2);
    expect([...answers]).toEqual([
      ['first', 'first-user'],
      ['second', 'second-user'],
    ]);
    expect(first.requestUserInput).toHaveBeenCalledTimes(1);
    expect(second.requestUserInput).toHaveBeenCalledTimes(1);
  } finally {
    await registry.stopAll();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
});
