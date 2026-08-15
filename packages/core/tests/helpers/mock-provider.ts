import type { ContentBlock } from '../../src/types/blocks.js';
import type {
  Capabilities,
  Provider,
  Request,
  Response,
  StreamEvent,
} from '../../src/types/provider.js';

export interface ScriptedResponse {
  content: ContentBlock[];
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';
  usage?: { input: number; output: number };
}

export class MockProvider implements Provider {
  readonly id = 'mock';
  readonly capabilities: Capabilities = {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: false,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    maxContext: 200_000,
    cacheControl: 'none',
  };
  calls = 0;
  receivedRequests: Request[] = [];
  private readonly script: ScriptedResponse[];

  constructor(script: ScriptedResponse[]) {
    this.script = script;
  }

  async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
    this.receivedRequests.push(req);
    const scripted = this.script[this.calls++];
    if (!scripted) {
      throw new Error('MockProvider: script exhausted');
    }
    return {
      content: scripted.content,
      stopReason: scripted.stopReason ?? 'end_turn',
      usage: { input: scripted.usage?.input ?? 10, output: scripted.usage?.output ?? 5 },
      model: req.model,
    };
  }

  // biome-ignore lint/correctness/useYield: stub throws intentionally
  async *stream(_req: Request, _opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    throw new Error('MockProvider.stream not used — capabilities.streaming is false');
  }
}

/**
 * Streaming-capable mock for testing the agent's stream path. Each scripted
 * response is replayed as a sequence of StreamEvents (one text_delta per
 * text block, tool_use_start + tool_use_stop for each tool_use block).
 */
export class StreamingMockProvider implements Provider {
  readonly id = 'mock-streaming';
  readonly capabilities: Capabilities = {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: true,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    maxContext: 200_000,
    cacheControl: 'none',
  };
  calls = 0;
  receivedRequests: Request[] = [];
  private readonly script: ScriptedResponse[];

  constructor(script: ScriptedResponse[]) {
    this.script = script;
  }

  async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    // Aggregate the stream for legacy callers.
    let stop: Response['stopReason'] = 'end_turn';
    let usage: Response['usage'] = { input: 0, output: 0 };
    const content: ContentBlock[] = [];
    let textBuf = '';
    for await (const ev of this.stream(req, opts)) {
      if (ev.type === 'text_delta') textBuf += ev.text;
      else if (ev.type === 'tool_use_start') {
        if (textBuf) {
          content.push({ type: 'text', text: textBuf });
          textBuf = '';
        }
        content.push({ type: 'tool_use', id: ev.id, name: ev.name, input: {} });
      } else if (ev.type === 'tool_use_stop') {
        const last = content[content.length - 1];
        if (last && last.type === 'tool_use' && last.id === ev.id) {
          last.input = (ev.input as Record<string, unknown>) ?? {};
        }
      } else if (ev.type === 'message_stop') {
        stop = ev.stopReason;
        usage = ev.usage;
      }
    }
    if (textBuf) content.push({ type: 'text', text: textBuf });
    return { content, stopReason: stop, usage, model: req.model };
  }

  async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
    this.receivedRequests.push(req);
    const scripted = this.script[this.calls++];
    if (!scripted) throw new Error('StreamingMockProvider: script exhausted');
    yield { type: 'message_start', model: req.model };
    for (const block of scripted.content) {
      if (block.type === 'text') {
        // Split into a few chunks so the test sees real deltas
        const mid = Math.max(1, Math.floor(block.text.length / 2));
        yield { type: 'text_delta', text: block.text.slice(0, mid) };
        yield { type: 'text_delta', text: block.text.slice(mid) };
      } else if (block.type === 'tool_use') {
        yield { type: 'tool_use_start', id: block.id, name: block.name };
        yield { type: 'tool_use_stop', id: block.id, input: block.input };
      }
    }
    yield {
      type: 'message_stop',
      stopReason: scripted.stopReason ?? 'end_turn',
      usage: { input: scripted.usage?.input ?? 10, output: scripted.usage?.output ?? 5 },
    };
  }
}
