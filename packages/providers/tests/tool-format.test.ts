import type { Message, Tool } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { contentFromAnthropic } from '../src/tool-format/from-anthropic.js';
import { contentFromOpenAI } from '../src/tool-format/from-openai.js';
import { toolsToAnthropic } from '../src/tool-format/to-anthropic.js';
import { messagesToOpenAI, toolsToOpenAI } from '../src/tool-format/to-openai.js';

describe('tool-format conversions', () => {
  it('toolsToAnthropic passes name and schema', () => {
    const t: Tool = {
      name: 'read',
      description: 'read',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const out = toolsToAnthropic([t]);
    expect(out[0]).toEqual({
      name: 'read',
      description: 'read',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    });
  });

  it('messagesToOpenAI splits tool_results into tool role messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'using' },
          { type: 'tool_use', id: 'u1', name: 'read', input: { path: 'a' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'file contents' }],
      },
    ];
    const out = messagesToOpenAI(undefined, messages);
    expect(out.some((m) => m.role === 'tool' && m.tool_call_id === 'u1')).toBe(true);
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls).toHaveLength(1);
  });

  it('messagesToOpenAI emits tool messages before user content in a mixed turn (DeepSeek adjacency)', () => {
    // A single canonical user turn carrying BOTH a tool_result and a text
    // block (e.g. a /btw note appended onto the tool-result message). The
    // tool message MUST come before the user text so it immediately follows
    // the assistant tool_calls — otherwise DeepSeek 400s.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: { path: 'a' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'u1', content: 'file contents' },
          { type: 'text', text: 'btw: prefer tabs' },
        ],
      },
    ];
    const out = messagesToOpenAI(undefined, messages);
    const assistantIdx = out.findIndex((m) => m.role === 'assistant');
    const toolIdx = out.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'u1');
    const userIdx = out.findIndex((m) => m.role === 'user');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBe(assistantIdx + 1);
    expect(userIdx).toBeGreaterThan(toolIdx);
  });

  it('contentFromOpenAI parses tool_calls', () => {
    const content = contentFromOpenAI({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
    expect(content[0]).toMatchObject({
      type: 'tool_use',
      id: 'tc1',
      name: 'read',
      input: { path: 'a.ts' },
    });
  });

  it('contentFromOpenAI synthesizes an id when the tool_call omits one', () => {
    const content = contentFromOpenAI({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            type: 'function',
            function: { name: 'read', arguments: '{"path":"a.ts"}' },
          } as never,
        ],
      },
      finish_reason: 'tool_calls',
    });
    const block = content[0] as { type: string; id: string; name: string; input: unknown };
    expect(block.type).toBe('tool_use');
    expect(block.name).toBe('read');
    expect(block.input).toEqual({ path: 'a.ts' });
    expect(block.id).toMatch(/^call_/);
  });

  it('contentFromOpenAI handles malformed args with jsonArgumentsBuggy', () => {
    const content = contentFromOpenAI(
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"a",}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
      { jsonArgumentsBuggy: true },
    );
    expect(content[0]).toMatchObject({
      type: 'tool_use',
      input: { path: 'a' },
    });
  });

  it('contentFromOpenAI surfaces unparseable args as __raw_arguments', () => {
    const content = contentFromOpenAI({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'read', arguments: 'not-json' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
    expect(content[0]).toMatchObject({
      type: 'tool_use',
      input: { __raw_arguments: 'not-json' },
    });
  });

  it('contentFromOpenAI salvages valid JSON objects wrapped in string arguments', () => {
    const content = contentFromOpenAI({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'read', arguments: '"{\\"path\\":\\"a\\"}"' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
    expect(content[0]).toMatchObject({
      type: 'tool_use',
      input: { path: 'a' },
    });
  });

  it('contentFromOpenAI emits an empty text block when message is empty', () => {
    const content = contentFromOpenAI({
      message: { role: 'assistant', content: null },
      finish_reason: 'stop',
    });
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'text', text: '' });
  });

  it('toolsToOpenAI wraps tools in {type:function, function:{...}}', () => {
    const t: Tool = {
      name: 'edit',
      description: 'edit',
      inputSchema: { type: 'object', properties: {} },
      permission: 'confirm',
      mutating: true,
      async execute() {
        return '';
      },
    };
    const out = toolsToOpenAI([t]);
    expect(out[0]?.type).toBe('function');
    expect(out[0]?.function.name).toBe('edit');
    expect(out[0]?.function.description).toBe('edit');
  });

  it('toolsToOpenAI falls back to empty schema when none provided', () => {
    const t: Tool = {
      name: 'noop',
      description: '',
      inputSchema: undefined as unknown as Record<string, unknown>,
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const out = toolsToOpenAI([t]);
    expect(out[0]?.function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('messagesToOpenAI prepends system as system role by default', () => {
    const out = messagesToOpenAI(
      [{ type: 'text', text: 'be terse' }],
      [{ role: 'user', content: 'hi' }],
    );
    expect(out[0]?.role).toBe('system');
    expect(out[0]?.content).toBe('be terse');
  });

  it('messagesToOpenAI merges system as user message when systemAsMessage:true', () => {
    const out = messagesToOpenAI(
      [{ type: 'text', text: 'be terse' }],
      [{ role: 'user', content: 'hi' }],
      { systemAsMessage: true },
    );
    expect(out[0]?.role).toBe('user');
    expect(out[0]?.content).toBe('be terse');
  });

  it('messagesToOpenAI emits empty string content for tool-only assistant message under emptyToolCallContent:empty_string', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'x', input: {} }],
      },
    ];
    const out = messagesToOpenAI(undefined, messages, {
      emptyToolCallContent: 'empty_string',
    });
    const a = out.find((m) => m.role === 'assistant')!;
    expect(a.content).toBe('');
    expect(a.tool_calls).toHaveLength(1);
  });

  // ------------------------------------------------------------------
  // K2P7 wire shape: every assistant message must have a content field.
  // OpenAI 2024-2025 spec, K2P7's Moonshot gateway, OpenRouter strict
  // mode, and modern Mistral all 400 on a tool_calls message that omits
  // content. Default is `''`; permissive proxies (vLLM, llama.cpp) can
  // opt out with `emptyToolCallContent: 'null'`.
  // ------------------------------------------------------------------

  it('messagesToOpenAI defaults to content:"" on tool-only assistant (K2P7 wire shape)', () => {
    // No opts passed — the converter defaults to the OpenAI-spec shape.
    // K2P7 / OpenRouter strict / modern Mistral all require this.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: { path: 'a' } }],
      },
    ];
    const out = messagesToOpenAI(undefined, messages);
    const a = out.find((m) => m.role === 'assistant')!;
    expect(a.content).toBe('');
    expect(a.tool_calls).toHaveLength(1);
  });

  it('messagesToOpenAI honors emptyToolCallContent:"null" for vLLM / llama.cpp', () => {
    // Permissive proxies (vLLM, llama.cpp) reject content: '' and want
    // the field omitted entirely. The 'null' opt-in writes content: null.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: { path: 'a' } }],
      },
    ];
    const out = messagesToOpenAI(undefined, messages, { emptyToolCallContent: 'null' });
    const a = out.find((m) => m.role === 'assistant')!;
    expect(a.content).toBeNull();
    expect(a.tool_calls).toHaveLength(1);
  });

  it('messagesToOpenAI flattens image content to text marker under flattenContentToString', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see: ' },
          { type: 'image', source: { type: 'url', url: 'https://x/p.png' } },
        ],
      },
    ];
    const out = messagesToOpenAI(undefined, messages, { flattenContentToString: true });
    const u = out.find((m) => m.role === 'user')!;
    expect(u.content).toContain('see: ');
    expect(u.content).toContain('[image]');
  });

  it('messagesToOpenAI keeps image_url entries when image present without flatten', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', source: { type: 'url', url: 'https://x/p.png' } },
        ],
      },
    ];
    const out = messagesToOpenAI(undefined, messages);
    const u = out.find((m) => m.role === 'user')!;
    expect(Array.isArray(u.content)).toBe(true);
    const arr = u.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(arr.find((c) => c.type === 'image_url')?.image_url?.url).toBe('https://x/p.png');
  });

  it('messagesToOpenAI builds data URI for base64 image source', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
          },
        ],
      },
    ];
    const out = messagesToOpenAI(undefined, messages);
    const u = out.find((m) => m.role === 'user')!;
    const arr = u.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(arr[0]?.image_url?.url).toBe('data:image/jpeg;base64,AAAA');
  });

  it('contentFromAnthropic copies text, tool_use, tool_result and drops unknowns', () => {
    const blocks = contentFromAnthropic([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'u1', name: 'read', input: { path: 'a' } },
      { type: 'tool_result', tool_use_id: 'u1', content: 'ok', is_error: false },
      { type: 'unknown_block' },
      // missing required fields — should be dropped
      { type: 'tool_use' },
      { type: 'text' },
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.type).toBe('text');
    expect(blocks[1]?.type).toBe('tool_use');
    expect(blocks[2]?.type).toBe('tool_result');
  });

  it('contentFromAnthropic defaults missing tool_use input to empty object', () => {
    const blocks = contentFromAnthropic([{ type: 'tool_use', id: 'u', name: 'n' }]);
    expect(blocks[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('contentFromAnthropic coerces non-object tool_use input to empty object', () => {
    const blocks = contentFromAnthropic([
      { type: 'tool_use', id: 'u1', name: 'n', input: 'oops' },
      { type: 'tool_use', id: 'u2', name: 'n', input: [1, 2] },
      { type: 'tool_use', id: 'u3', name: 'n', input: null },
    ]);
    expect(blocks).toHaveLength(3);
    for (const b of blocks) expect(b).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('contentFromAnthropic preserves base64 and URL image blocks', () => {
    const blocks = contentFromAnthropic([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
      { type: 'image', source: { type: 'url', url: 'https://x/p.png' } },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://x/p.png' },
    });
  });

  it('contentFromAnthropic normalizes structured tool_result content to string', () => {
    const blocks = contentFromAnthropic([
      {
        type: 'tool_result',
        tool_use_id: 'u1',
        content: [
          { type: 'text', text: 'see below:' },
          { type: 'image', source: { type: 'url', url: 'https://x/r.png' } },
        ],
      },
    ]);
    const result = blocks[0] as { type: 'tool_result'; content: string };
    expect(result.type).toBe('tool_result');
    // Sub-blocks are flattened to a string with text extracted and
    // non-text blocks replaced with their type marker.
    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('see below:');
    expect(result.content).toContain('[image]');
  });

  it('contentFromAnthropic invokes onUnsupported for unknown block types', () => {
    const seen: string[] = [];
    const blocks = contentFromAnthropic(
      [{ type: 'text', text: 'ok' }, { type: 'server_tool_use' }],
      { onUnsupported: (t) => seen.push(t) },
    );
    expect(blocks).toHaveLength(1);
    expect(seen).toEqual(['server_tool_use']);
  });

  it('contentFromAnthropic preserves thinking blocks with signature for echo-back', () => {
    // Anthropic extended-thinking blocks MUST round-trip on the next
    // request, otherwise the API returns 400 "content[].thinking in the
    // thinking mode must be passed back to the API".
    const blocks = contentFromAnthropic([
      { type: 'thinking', thinking: 'Let me think...', signature: 'sig-abc' },
      { type: 'text', text: 'answer' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: 'thinking',
      thinking: 'Let me think...',
      signature: 'sig-abc',
    });
    expect(blocks[1]).toEqual({ type: 'text', text: 'answer' });
  });

  it('messagesToOpenAI hoists thinking blocks to message-level reasoning_content for DeepSeek', () => {
    // DeepSeek 400s if the prior assistant's reasoning_content isn't
    // echoed back on the assistant message. Vanilla OpenAI ignores the
    // field, so emitting it is safe across the OpenAI-compatible
    // ecosystem.
    const messages: Message[] = [
      { role: 'user', content: 'compute' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'consider...' },
          { type: 'text', text: 'using tool' },
          { type: 'tool_use', id: 'u1', name: 'calc', input: { x: 1 } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'u1', content: '42' }],
      },
    ];
    const out = messagesToOpenAI(undefined, messages);
    const assistant = out.find((m) => m.role === 'assistant')!;
    expect(assistant.reasoning_content).toBe('consider...');
    // The reasoning blob must live at message-level, NOT on individual
    // tool_calls — DeepSeek rejects the latter shape.
    expect(assistant.tool_calls?.[0]).not.toHaveProperty('reasoning_content');
    expect(assistant.content).toBe('using tool');
  });

  it('messagesToOpenAI emits reasoning_content even when there are no tool calls', () => {
    // Pure-text thinking turns also need the blob round-tripped — the
    // earlier per-tool_call capture lost reasoning entirely for these.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reflecting...' },
          { type: 'text', text: 'done' },
        ],
      },
    ];
    const out = messagesToOpenAI(undefined, messages);
    const a = out.find((m) => m.role === 'assistant')!;
    expect(a.reasoning_content).toBe('reflecting...');
    expect(a.content).toBe('done');
    expect(a.tool_calls).toBeUndefined();
  });

  it('contentFromOpenAI auto-recovers malformed args via sanitizer (no flag needed)', () => {
    const content = contentFromOpenAI({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"a",}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
    expect(content[0]).toMatchObject({ type: 'tool_use', input: { path: 'a' } });
  });

  it('contentFromOpenAI calls onParseFailure when sanitizer also fails', () => {
    const failures: Array<{ toolName: string; toolCallId: string; raw: string }> = [];
    const content = contentFromOpenAI(
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'read', arguments: 'not-json-at-all' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
      { onParseFailure: (info) => failures.push(info) },
    );
    expect(failures).toEqual([{ toolName: 'read', toolCallId: 'tc1', raw: 'not-json-at-all' }]);
    expect(content[0]).toMatchObject({ input: { __raw_arguments: 'not-json-at-all' } });
  });

  it('contentFromOpenAI flags scalar/array JSON args as parse failure', () => {
    // JSON parses fine but the result isn't an object — tool would receive
    // an unexpected shape, so we want the same failure signal.
    const failures: Array<{ toolName: string }> = [];
    const content = contentFromOpenAI(
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc-arr',
              type: 'function',
              function: { name: 'x', arguments: '[1,2,3]' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
      { onParseFailure: (info) => failures.push({ toolName: info.toolName }) },
    );
    expect(failures).toEqual([{ toolName: 'x' }]);
    expect(content[0]).toMatchObject({ input: { __raw_arguments: '[1,2,3]' } });
  });

  it('contentFromOpenAI preserves whitespace-only text content', () => {
    const content = contentFromOpenAI({
      message: { role: 'assistant', content: '   \n  ' },
      finish_reason: 'stop',
    });
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'text', text: '   \n  ' });
  });
});
