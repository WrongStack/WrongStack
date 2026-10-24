/**
 * The registered contract appended to a failed call is durable history. Live
 * (2026-10-11): two consecutive bad `tool_use` calls carried the same ~1.4k-char
 * contract twice, pretty-printed. The model still has the first copy; the
 * second needs only the new validation errors.
 */

import type { Message } from '@wrongstack/contracts/types/messages';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it } from 'vitest';
import { toolInputCorrection } from '../../src/execution/tool-executor-results.js';

const tool = {
  name: 'tool_use',
  description: 'Invoke a registered tool by its exact name.',
  usageHint: 'ADVANCED META TOOL — USE WITH CARE.',
  permission: 'auto',
  mutating: false,
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'The exact registered name.' },
      input: { type: 'object', description: 'The input object.' },
    },
    required: ['tool'],
  },
  execute: async () => ({}),
} as unknown as Tool;

function failedCall(id: string, content: string): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'tool_use', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: true }] },
  ];
}

describe('toolInputCorrection', () => {
  it('sends the schema as compact JSON', () => {
    const text = toolInputCorrection(tool);
    expect(text).toContain(JSON.stringify(tool.inputSchema));
    expect(text).not.toContain('{\n  "type"');
  });

  it('does not repeat a contract that is still visible in recent history', () => {
    const first = `Invalid arguments for tool "tool_use".${toolInputCorrection(tool)}`;
    const history = failedCall('a', first);
    const second = toolInputCorrection(tool, history);
    expect(second).not.toContain('Input schema');
    expect(second).toContain('tool_use');
    expect(second.length).toBeLessThan(300);
  });

  it('trims a wide schema to the required and failing fields', () => {
    // kanban: ~150 flat fields, ~23k chars — one bad call put all of it into
    // durable history.
    const properties = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [
        `field_${i}`,
        { type: 'string', description: `Field ${i} carries one piece of board state.` },
      ]),
    );
    const wide = {
      ...tool,
      name: 'kanban',
      inputSchema: { type: 'object', properties, required: ['field_0'] },
    } as unknown as Tool;
    const text = toolInputCorrection(wide, undefined, ['field_42', 'field_7.sub']);
    expect(text).toContain('"field_0"');
    expect(text).toContain('"field_42"');
    expect(text).toContain('"field_7"');
    expect(text).not.toContain('"field_99"');
    expect(text).toContain('tool_search with the exact name "kanban"');
    expect(text.length).toBeLessThan(4_000);
    // Every declared name is still listed, so the model knows what exists.
    expect(text).toContain('field_149');
  });

  it('repeats it once the earlier copy is gone from the recent window', () => {
    const first = `Invalid arguments for tool "tool_use".${toolInputCorrection(tool)}`;
    const filler: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `turn ${i}`,
    }));
    expect(toolInputCorrection(tool, [...failedCall('a', first), ...filler])).toContain(
      'Input schema',
    );
    // An elided copy (compaction clipped it) no longer carries the contract.
    const elided = failedCall('b', 'Invalid arguments for tool "tool_use"...(1700 chars)');
    expect(toolInputCorrection(tool, elided)).toContain('Input schema');
  });
});
