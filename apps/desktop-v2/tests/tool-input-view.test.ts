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
    expect(html).toContain('x = 1');
    expect(html).toContain('x = 2');
    expect(html).toContain('a.ts');
    expect(html).toContain('Every occurrence is replaced.');
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
    expect(toolInputView('fetch', { url: 'https://x.test' })).toEqual({ kind: 'generic' });
  });
});

describe('read, search, replace and exec views', () => {
  it('describes a read range', () => {
    expect(toolInputView('read', { path: 'a.ts', offset: 10, limit: 5 })).toEqual({
      kind: 'read',
      path: 'a.ts',
      range: 'lines 10–14',
    });
    expect(toolInputView('read', { path: 'a.ts' })).toMatchObject({ range: 'whole file' });
  });

  it('describes a search with its scope and options', () => {
    expect(
      toolInputView('grep', {
        pattern: 'TODO',
        path: 'src',
        glob: '*.ts',
        case_insensitive: true,
        context_lines: 2,
      }),
    ).toEqual({
      kind: 'search',
      tool: 'grep',
      pattern: 'TODO',
      path: 'src',
      details: ['files *.ts', 'ignore case', '±2 lines'],
    });
  });

  it('says whether a replace only previews', () => {
    expect(
      toolInputView('replace', { pattern: 'a', replacement: 'b', files: ['x.ts'] }),
    ).toMatchObject({ kind: 'replace', files: ['x.ts'], details: ['preview only'] });
    expect(
      toolInputView('replace', { pattern: 'a', replacement: '', files: 'y.ts', dry_run: false }),
    ).toMatchObject({ files: ['y.ts'], details: ['writes files'] });
  });

  it('shows an exec call as one command line, quoting only what needs it', () => {
    expect(
      toolInputView('exec', { command: 'git', args: ['commit', '-m', 'two words'], cwd: 'repo' }),
    ).toEqual({ kind: 'command', command: 'git commit -m "two words"', cwd: 'repo' });
  });
});
