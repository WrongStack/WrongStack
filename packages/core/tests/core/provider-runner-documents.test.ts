import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { DocumentBlock } from '@wrongstack/contracts/types/blocks';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Provider, Request, Response } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import { runProviderWithRetry } from '../../src/core/provider-runner.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

const pdf: DocumentBlock = {
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
  name: 'spec.pdf',
  text: 'the text',
  pages: 1,
};

function recordingProvider(id: string, acceptsPdf: boolean, seen: Request[]): Provider {
  return {
    id,
    capabilities: { streaming: false, tools: true, vision: true, pdf: acceptsPdf },
    async complete(req: Request): Promise<Response> {
      seen.push(req);
      return {
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 1, output: 1 },
      } as unknown as Response;
    },
  } as unknown as Provider;
}

function firstBlockType(req: Request | undefined): string | undefined {
  const content = req?.messages[0]?.content;
  return Array.isArray(content) ? content[0]?.type : undefined;
}

function run(provider: Provider, request: Request) {
  return runProviderWithRetry({
    provider,
    request,
    signal: new AbortController().signal,
    ctx: { agentId: 'a', session: { id: 's' } } as unknown as AgentContext,
    events: new EventBus(),
    retry: new DefaultRetryPolicy(),
    logger: silentLogger,
  });
}

describe('provider-runner document gate', () => {
  const request = {
    model: 'm',
    messages: [{ role: 'user', content: [pdf, { type: 'text', text: 'summarize' }] }],
  } as unknown as Request;

  it('sends the file to a model whose catalog lists PDF input', async () => {
    const seen: Request[] = [];
    await run(recordingProvider('anthropic', true, seen), request);
    expect(seen[0]).toBe(request);
  });

  it('sends the text to a model without PDF input, leaving the conversation intact', async () => {
    const seen: Request[] = [];
    await run(recordingProvider('deepseek', false, seen), request);
    const content = seen[0]?.messages[0]?.content as { type: string; text?: string }[];
    expect(content[0]).toEqual({
      type: 'text',
      text: '<attached-pdf name="spec.pdf, 1 page">\nthe text\n</attached-pdf>',
    });
    expect(firstBlockType(request)).toBe('document');
  });

  it('decides per provider, so a fallback hop to a text-only model is covered', async () => {
    const seen: Request[] = [];
    await run(recordingProvider('anthropic', true, seen), request);
    await run(recordingProvider('deepseek', false, seen), request);
    expect(firstBlockType(seen[0])).toBe('document');
    expect(firstBlockType(seen[1])).toBe('text');
  });
});
