import type { Message, ThinkingBlock } from '@wrongstack/contracts/types';
import { expect, it } from 'vitest';
import {
  CODEX_TOOL_ARGUMENTS_META,
  messagesToResponsesInput,
} from '../src/tool-format/to-responses.js';

const thinking = (id: string): ThinkingBlock => ({
  type: 'thinking',
  thinking: 'reasoning',
  providerMeta: { codexReasoningId: id, codexReasoningEncrypted: `encrypted-${id}` },
});

it('does not replay trailing reasoning merely because an earlier answer exists', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: [
        thinking('rs_complete'),
        { type: 'text', text: 'Earlier answer' },
        thinking('rs_interrupted'),
      ],
    },
  ];
  const input = messagesToResponsesInput(messages, { includeReasoning: true });
  expect(input.map((item) => item['type'])).toEqual(['reasoning', 'message']);
  expect(input[0]?.['id']).toBe('rs_complete');
});

it('keeps reasoning that follows commentary and precedes a tool call', () => {
  const input = messagesToResponsesInput(
    [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the file.' },
          thinking('rs_tool'),
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'file.ts' } },
        ],
      },
    ],
    { includeReasoning: true },
  );
  expect(input.map((item) => item['type'])).toEqual(['message', 'reasoning', 'function_call']);
});

it.each([false, true])(
  'serializes the current nested tool input after mutation (metadata=%s)',
  (withMetadata) => {
    const input = { path: 'old.ts', range: { lines: [1] } };
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'read',
            input,
            ...(withMetadata
              ? { providerMeta: { [CODEX_TOOL_ARGUMENTS_META]: '{"path":"stale.ts"}' } }
              : {}),
          },
        ],
      },
    ];
    expect(JSON.parse(String(messagesToResponsesInput(messages)[0]?.['arguments']))).toEqual(input);
    input.path = 'new.ts';
    input.range.lines.push(2);
    expect(JSON.parse(String(messagesToResponsesInput(messages)[0]?.['arguments']))).toEqual(input);
  },
);
