import { describe, expect, it } from 'vitest';
import { extractFileEditMeta } from '../src/lib/timeline-model.js';
import type { ToolCallInfo } from '../src/types.js';

const SAGE_BLOCK = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-1">test memory content here</memory> [tags=test]',
  '- [decision][high] <memory id="mem-2">another memory</memory> (@wrongstack/tui) [relation=about_package]',
].join('\n');

function toolCall(name: string, output: string): ToolCallInfo {
  return { id: 't1', name, input: {}, status: 'done', output };
}

describe('extractFileEditMeta — SAGE injector stripping', () => {
  it('strips a trailing SAGE block from serialized-format diff output', () => {
    const out =
      'edit (path=src/file.ts replacements=1 matched_by=exact)\n@@ -1,3 +1,3 @@\n old\n+new\n-old';
    const meta = extractFileEditMeta(toolCall('edit', `${out}\n\n${SAGE_BLOCK}`));
    expect(meta?.diff).toBeDefined();
    expect(meta?.diff).not.toContain('SAGE');
    expect(meta?.diff).not.toContain('Memory Injector');
    expect(meta?.diff).not.toContain('<memory id=');
    expect(meta?.diff).toContain('+new');
    expect(meta?.diff).toContain('-old');
  });

  it('strips a trailing SAGE block from JSON diff output', () => {
    const out = JSON.stringify({
      path: 'src/file.ts',
      replacements: 1,
      diff: '@@ -1,1 +1,1 @@\n-old\n+new',
    });
    const meta = extractFileEditMeta(toolCall('edit', `${out}\n\n${SAGE_BLOCK}`));
    expect(meta?.diff).toBeDefined();
    expect(meta?.diff).not.toContain('SAGE');
    expect(meta?.diff).not.toContain('Memory Injector');
  });

  it('leaves output untouched when there is no SAGE block', () => {
    const out =
      'edit (path=src/file.ts replacements=1 matched_by=exact)\n@@ -1,1 +1,1 @@\n-old\n+new';
    const meta = extractFileEditMeta(toolCall('edit', out));
    expect(meta?.diff).toContain('+new');
    expect(meta?.diff).not.toContain('SAGE');
  });

  it('handles the task-aware SAGE heading variant too', () => {
    const taskBlock = [
      '--- SAGE: task-aware project knowledge (Memory Injector) ---',
      '- [fact] <memory id="mem-3">task memory</memory>',
    ].join('\n');
    const out = 'write (path=src/new.ts bytes_written=42 created=true)\n@@ -0,0 +1,1 @@\n+hello';
    const meta = extractFileEditMeta(toolCall('write', `${out}\n\n${taskBlock}`));
    expect(meta?.diff).toContain('+hello');
    expect(meta?.diff).not.toContain('SAGE');
    expect(meta?.diff).not.toContain('<memory id=');
  });
});
