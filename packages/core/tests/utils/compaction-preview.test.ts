import type { Message } from '@wrongstack/contracts/types/messages';
import { describe, expect, it } from 'vitest';
import { buildCompactionPreview } from '../../src/utils/compaction-preview.js';

const toolResult = (content: unknown): Message =>
  ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content }] }) as Message;

describe('buildCompactionPreview', () => {
  it('scans a long word-character run in linear time', () => {
    // Every start offset inside the run used to re-scan it to the end.
    const started = performance.now();
    buildCompactionPreview(toolResult('a'.repeat(100_000)));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('extracts path hints without reading a mid-word letter as a drive', () => {
    const preview = buildCompactionPreview(
      toolResult('key=src/a.ts, other:lib/b.json; at C:\\Users\\dev\\c.json'),
    );
    expect(preview).toContain('files=src/a.ts, lib/b.json, C:/Users/dev/c.json');
  });

  it('never leaves a lone surrogate at the truncation point', () => {
    const preview = buildCompactionPreview(
      { role: 'user', content: `${'a'.repeat(598)}😀 tail` } as Message,
      600,
    );
    expect(preview).toBe(`${'a'.repeat(598)}…`);
  });

  it('renders stubs for tool blocks without input or content', () => {
    expect(
      buildCompactionPreview({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'u', name: 'ls', input: undefined }],
      } as unknown as Message),
    ).toBe('[tool_use: ls]');
    expect(buildCompactionPreview(toolResult(undefined))).toBe('[tool_result: ok]');
  });
});
