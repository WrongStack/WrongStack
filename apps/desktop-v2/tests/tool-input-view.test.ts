import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolInputView } from '../src/ToolInputView';
import { toolInputView, WRITE_PREVIEW_LINES } from '../src/tool-input-view';

describe('tool-specific input views', () => {
  it('shows an edit as removed and added lines', () => {
    expect(
      toolInputView('edit', { path: 'a.ts', old_string: 'x = 1\ny', new_string: 'x = 2' }),
    ).toEqual({
      kind: 'edit',
      path: 'a.ts',
      removed: ['x = 1', 'y'],
      added: ['x = 2'],
      all: false,
    });
    const html = renderToStaticMarkup(
      createElement(ToolInputView, {
        name: 'edit',
        input: { path: 'a.ts', old_string: 'x = 1', new_string: 'x = 2', replace_all: true },
      }),
    );
    expect(html).toContain('- x = 1');
    expect(html).toContain('+ x = 2');
    expect(html).toContain('every occurrence');
  });

  it('previews a full write and counts the remaining lines', () => {
    const content = Array.from({ length: WRITE_PREVIEW_LINES + 5 }, (_, i) => `line ${i}`).join(
      '\n',
    );
    const view = toolInputView('write', { path: 'b.txt', content });
    expect(view).toMatchObject({ kind: 'write', path: 'b.txt', more: 5 });
  });

  it('shows a shell call as its command and keeps anything else generic', () => {
    expect(toolInputView('bash', { command: 'bun test', cwd: 'pkg' })).toEqual({
      kind: 'command',
      command: 'bun test',
      cwd: 'pkg',
    });
    expect(toolInputView('edit', { path: 'a.ts' })).toEqual({ kind: 'generic' });
    expect(toolInputView('grep', { pattern: 'x' })).toEqual({ kind: 'generic' });
  });
});
