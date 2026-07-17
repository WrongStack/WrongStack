import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/types/messages.js';
import { hasMeaningfulContent, repairToolUseAdjacency } from '../../src/utils/message-invariants.js';

describe('repairToolUseAdjacency', () => {
  it('leaves valid tool_use/tool_result pairs untouched', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] },
      { role: 'assistant', content: 'done' },
    ];

    const repaired = repairToolUseAdjacency(messages);

    expect(repaired.report.changed).toBe(false);
    expect(repaired.messages).toBe(messages);
  });

  it('removes assistant tool_use blocks without immediate results', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'u1', name: 'read', input: {} },
        ],
      },
      { role: 'assistant', content: 'not a tool result' },
    ];

    const repaired = repairToolUseAdjacency(messages);

    expect(repaired.report.removedToolUses).toEqual(['u1']);
    expect(repaired.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'checking' }],
    });
  });

  it('removes orphan tool_result blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] },
      { role: 'assistant', content: 'next' },
    ];

    const repaired = repairToolUseAdjacency(messages);

    expect(repaired.report.removedToolResults).toEqual(['missing']);
    expect(repaired.report.removedMessages).toBe(1);
    expect(repaired.messages).toEqual([{ role: 'assistant', content: 'next' }]);
  });

  it('repairs ranges cut through a tool exchange', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'grep', input: {} }] },
      { role: 'system', content: '[summary]' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'late' }] },
      { role: 'user', content: 'continue' },
    ];

    const repaired = repairToolUseAdjacency(messages);

    expect(repaired.report.removedToolUses).toEqual(['u1']);
    expect(repaired.report.removedToolResults).toEqual(['u1']);
    expect(repaired.messages).toEqual([
      { role: 'system', content: '[summary]' },
      { role: 'user', content: 'continue' },
    ]);
  });

  // Issue #271 — interrupted streams persisted `[{type:'text',text:''}]`
  // assistant turns that strict providers reject on the next request.
  it('removes assistant messages backed only by an empty text block', () => {
    const messages: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: 'second' },
    ];

    const repaired = repairToolUseAdjacency(messages);

    expect(repaired.report.changed).toBe(true);
    expect(repaired.report.removedMessages).toBe(1);
    expect(repaired.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('removes messages backed only by whitespace-only text blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '  ' },
          { type: 'text', text: '\n\t ' },
        ],
      },
      { role: 'user', content: 'next' },
    ];

    const repaired = repairToolUseAdjacency(messages);

    expect(repaired.report.removedMessages).toBe(1);
    expect(repaired.messages).toEqual([{ role: 'user', content: 'next' }]);
  });

  it('keeps tool-call-only assistant messages intact', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'tool_use', id: 'u1', name: 'read', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] },
    ];

    const repaired = repairToolUseAdjacency(messages);

    expect(repaired.report.changed).toBe(false);
    expect(repaired.messages).toBe(messages);
  });

  it('keeps thinking blocks that carry text or a signature', () => {
    const withText: Message[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }] },
    ];
    const withSignature: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'sig-1' }],
      },
    ];

    expect(repairToolUseAdjacency(withText).report.changed).toBe(false);
    expect(repairToolUseAdjacency(withSignature).report.changed).toBe(false);
  });

  it('keeps partial text produced before an interrupt', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'partial answer' },
        ],
      },
    ];

    const repaired = repairToolUseAdjacency(messages);

    expect(repaired.report.changed).toBe(false);
    expect(repaired.messages).toBe(messages);
  });
});

describe('hasMeaningfulContent', () => {
  it('rejects empty and whitespace-only string content', () => {
    expect(hasMeaningfulContent('')).toBe(false);
    expect(hasMeaningfulContent('  \n\t ')).toBe(false);
    expect(hasMeaningfulContent('answer')).toBe(true);
  });

  it('rejects empty arrays and arrays of only empty text blocks', () => {
    expect(hasMeaningfulContent([])).toBe(false);
    expect(hasMeaningfulContent([{ type: 'text', text: '' }])).toBe(false);
    expect(hasMeaningfulContent([{ type: 'text', text: ' \n' }])).toBe(false);
  });

  it('accepts any non-text block and non-empty text', () => {
    expect(hasMeaningfulContent([{ type: 'text', text: 'hi' }])).toBe(true);
    expect(
      hasMeaningfulContent([
        { type: 'text', text: '' },
        { type: 'tool_use', id: 'u1', name: 'read', input: {} },
      ]),
    ).toBe(true);
    expect(
      hasMeaningfulContent([{ type: 'tool_result', tool_use_id: 'u1', content: '' }]),
    ).toBe(true);
    expect(hasMeaningfulContent([{ type: 'thinking', thinking: 'plan' }])).toBe(true);
    expect(hasMeaningfulContent([{ type: 'thinking', thinking: '', signature: 's' }])).toBe(
      true,
    );
    expect(hasMeaningfulContent([{ type: 'thinking', thinking: '' }])).toBe(false);
  });
});
