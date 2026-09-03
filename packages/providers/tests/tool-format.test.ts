import type { Message, Tool } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { contentFromAnthropic } from '../src/tool-format/from-anthropic.js';
import { contentFromOpenAI } from '../src/tool-format/from-openai.js';
import { toolsToAnthropic } from '../src/tool-format/to-anthropic.js';
import { messagesToOpenAI, toolsToOpenAI } from '../src/tool-format/to-openai.js';
import { messagesToResponsesInput } from '../src/tool-format/to-responses.js';

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

  it('folds in-conversation system messages (compaction digest / evidence floor) into a user turn', () => {
    // Without this, role:'system' messages inserted by the compactors are
    // silently dropped across the entire OpenAI-compatible family, losing the
    // collapsed history. They must survive as a user turn.
    const messages: Message[] = [
      { role: 'system', content: '[prior_turns_digest: important context]' },
      { role: 'user', content: 'continue' },
    ];
    const out = messagesToOpenAI(undefined, messages);
    const folded = out.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('prior_turns_digest'),
    );
    expect(folded).toBeDefined();
    // No stray system role leaks into the message list from the fold.
    expect(out.some((m) => m.role === 'system')).toBe(false);
  });

  it('folds in-conversation system messages into a user turn on the Responses adapter too', () => {
    const messages: Message[] = [
      { role: 'system', content: '[prior_turns_digest: important context]' },
      { role: 'user', content: 'continue' },
    ];
    const out = messagesToResponsesInput(messages);
    const folded = out.find(
      (m) =>
        m['role'] === 'user' && JSON.stringify(m['content'] ?? '').includes('prior_turns_digest'),
    );
    expect(folded).toBeDefined();
  });

  it('reuses stringified tool inputs for identical object references across OpenAI and Responses adapters', () => {
    const sharedInput = { path: 'a.ts' };
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: sharedInput }],
      },
    ];

    const openai = messagesToOpenAI(undefined, messages);
    const responses = messagesToResponsesInput(messages);

    const openAiArgs = openai[0]?.tool_calls?.[0]?.function.arguments;
    const responsesArgs = responses[0]?.['arguments'];
    expect(openAiArgs).toBe('{"path":"a.ts"}');
    expect(responsesArgs).toBe('{"path":"a.ts"}');
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

  it('flattens top-level schema combinators rejected by OmniRoute', () => {
    const t: Tool = {
      name: 'dynamic_tool',
      description: 'dynamic tool',
      inputSchema: {
        oneOf: [
          {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        ],
      },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };

    const openai = toolsToOpenAI([t])[0]?.function.parameters;
    const anthropic = toolsToAnthropic([t])[0]?.input_schema;
    for (const schema of [openai, anthropic]) {
      expect(schema).toMatchObject({
        type: 'object',
        properties: { path: { type: 'string' }, query: { type: 'string' } },
      });
      expect(schema).not.toHaveProperty('oneOf');
      // Alternative-specific requirements cannot both be required on the wire.
      expect(schema).not.toHaveProperty('required');
    }
  });

  it('toolsToOpenAI falls back to empty schema when none provided', () => {
    const t: Tool = {
      name: 'noop',
      description: '',
      inputSchema: undefined as never as Record<string, unknown>,
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const out = toolsToOpenAI([t]);
    expect(out[0]?.function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('compacts tool descriptions and schema prose for wire formats', () => {
    const long = 'Very detailed operational guidance. '.repeat(80);
    const t: Tool = {
      name: 'verbose',
      description: long,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: long, minLength: 2 },
        },
        required: ['query'],
      },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };

    const openai = toolsToOpenAI([t])[0]?.function;
    const anthropic = toolsToAnthropic([t])[0];
    expect(openai?.description.length).toBeLessThan(long.length);
    expect(anthropic?.description).toBe(openai?.description);
    expect(openai?.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 2 } },
    });
    const props = openai?.parameters['properties'] as Record<string, Record<string, unknown>>;
    expect(String(props['query']?.['description']).length).toBeLessThan(long.length);
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

  it('messagesToOpenAI emits explicit null content for tool-only assistant message under emptyToolCallContent:null', () => {
    // Opt-in to the older / permissive-proxy wire format. vLLM and
    // llama.cpp servers that reject `content: ''` want `content: null`
    // explicitly. Today no WrongStack preset ships this — the
    // default `'empty_string'` is the right choice for 2025 — but
    // a future vLLM provider preset can flip this on.
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u1', name: 'x', input: {} }],
      },
    ];
    const out = messagesToOpenAI(undefined, messages, {
      emptyToolCallContent: 'null',
    });
    const a = out.find((m) => m.role === 'assistant')!;
    expect(a.content).toBeNull();
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

  // ── OpenAI content field on tool-only assistant messages ─────────
  //
  // OpenAI 2024-2025 wire contract: every assistant message must have
  // a `content` field — vanilla OpenAI, K2P7, strict Mistral, and
  // OpenRouter all 400 on a tool_calls message that omits content
  // ("messages.N.content must be a string").
  //
  // The default in `messagesToOpenAI` is `content: ''` (empty
  // string). The old pre-2024 behaviour — literally omitting the
  // field — was a foot-gun that broke multi-turn tool calling for
  // every model that produces prose-less tool calls (K2P7 most
  // visibly).
  //
  // Two valid values for the `emptyToolCallContent` option:
  //   - `'empty_string'` (default): wire-compatible with strict providers
  //   - `'null'`: explicit null — preferred by some older vLLM /
  //     llama.cpp builds; opt in with `emptyToolCallContent: 'null'`
  describe('emptyToolCallContent', () => {
    it('writes empty string content for tool-only assistant messages by default (K2P7-safe)', () => {
      // The pre-fix behaviour was: omit `content` entirely. That
      // broke K2P7 (and several strict proxies) with 400. The fix
      // ships as the new default: `content: ''`. This is the
      // canonical OpenAI wire shape and the safest choice in 2025.
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'hi' } }],
        },
      ];
      const out = messagesToOpenAI(undefined, messages);
      const a = out.find((m) => m.role === 'assistant')!;
      // `content` MUST be present (string) and non-undefined.
      expect('content' in a).toBe(true);
      expect(a.content).toBe('');
      // The tool_calls survive — the model at least sees what the
      // previous turn did.
      expect(a.tool_calls).toHaveLength(1);
    });

    it('writes explicit null content when emptyToolCallContent is "null" (legacy opt-in)', () => {
      // Some older / permissive proxies (e.g. vLLM, llama.cpp)
      // reject `content: ''` and want `content: null` explicitly.
      // This is the only path to omit-or-null the field today;
      // a future provider preset can opt in.
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'hi' } }],
        },
      ];
      const out = messagesToOpenAI(undefined, messages, {
        emptyToolCallContent: 'null',
      });
      const a = out.find((m) => m.role === 'assistant')!;
      expect(a.content).toBeNull();
    });
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

  // ── WeakMap memoization ──────────────────────────────────────────────
  //
  // Both toolsToAnthropic and toolsToOpenAI cache their output keyed by
  // the Tool[] array reference. Within a session the tool registry returns
  // the same array, so subsequent calls return the cached result (same
  // object identity) without re-mapping. When the array reference changes
  // (tools added/removed), the cache misses and recomputes.

  describe('toolsToAnthropic memoization', () => {
    it('returns the same array reference on repeated calls with the same Tool[] input', () => {
      const t: Tool = {
        name: 'read',
        description: 'read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        permission: 'auto',
        mutating: false,
        async execute() {
          return '';
        },
      };
      const tools = [t];
      const first = toolsToAnthropic(tools);
      const second = toolsToAnthropic(tools);
      // Same reference — no re-allocation on cache hit
      expect(first).toBe(second);
    });

    it('recomputes when a different Tool[] array is passed', () => {
      const t: Tool = {
        name: 'grep',
        description: 'search files',
        inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
        permission: 'auto',
        mutating: false,
        async execute() {
          return '';
        },
      };
      const a = toolsToAnthropic([t]);
      const b = toolsToAnthropic([t]);
      // Different array reference → cache miss → different result reference
      expect(a).not.toBe(b);
      // But structurally equal
      expect(a).toEqual(b);
    });
  });

  describe('toolsToOpenAI memoization', () => {
    it('returns the same array reference on repeated calls with the same Tool[] input', () => {
      const t: Tool = {
        name: 'edit',
        description: 'edit a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        permission: 'confirm',
        mutating: true,
        async execute() {
          return '';
        },
      };
      const tools = [t];
      const first = toolsToOpenAI(tools);
      const second = toolsToOpenAI(tools);
      expect(first).toBe(second);
    });

    it('recomputes when a different Tool[] array is passed', () => {
      const t: Tool = {
        name: 'bash',
        description: 'run shell command',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        permission: 'confirm',
        mutating: true,
        async execute() {
          return '';
        },
      };
      const a = toolsToOpenAI([t]);
      const b = toolsToOpenAI([t]);
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('deterministic tool sorting for prompt cache stability', () => {
    const makeTool = (name: string): Tool => ({
      name,
      description: `tool ${name}`,
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    });

    it('sorts tools alphabetically by name across OpenAI, Anthropic, and Responses', () => {
      const toolZ = makeTool('zebra');
      const toolA = makeTool('apple');
      const toolM = makeTool('mango');
      const unsorted = [toolZ, toolA, toolM];

      const openAi = toolsToOpenAI(unsorted);
      expect(openAi.map((t) => t.function.name)).toEqual(['apple', 'mango', 'zebra']);

      const anthropic = toolsToAnthropic(unsorted);
      expect(anthropic.map((t) => t.name)).toEqual(['apple', 'mango', 'zebra']);
    });
  });
});
