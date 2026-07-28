import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolResult } from '../../src/components/ToolResult.js';

const SAGE_BLOCK = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-1">remembered glob fact</memory> [tags=glob]',
  '- [decision][high] <memory id="mem-2">remembered glob decision</memory>',
].join('\n');

describe('<ToolResult /> — SAGE memory injection as separate card', () => {
  it('renders glob JSON output without the SAGE header in the result body', () => {
    const globOutput = JSON.stringify({ files: ['src/a.ts', 'src/b.tsx'] });
    const contaminated = `${globOutput}\n\n${SAGE_BLOCK}\n`;
    const { container } = render(
      <ToolResult toolName="glob" result={contaminated} />,
    );
    // The glob result body still surfaces the file paths.
    expect(container.textContent).toContain('src/a.ts');
    expect(container.textContent).toContain('src/b.tsx');
    // The SAGE header must NOT appear inline in the result body — only in
    // the separate bordered card.
    expect(container.textContent).not.toContain('--- SAGE:');
    // The separate card surfaces the injection evidence.
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
    expect(screen.getByTestId('sage-memory-header').textContent).toContain('glob');
  });

  it('renders tree JSON output with SAGE separately', () => {
    const treeOutput = JSON.stringify({
      total_files: 3,
      total_dirs: 1,
      truncated: false,
      entries: [{ path: 'src/a.ts', kind: 'file' }],
    });
    const contaminated = `${treeOutput}\n\n${SAGE_BLOCK}`;
    const { container } = render(
      <ToolResult toolName="tree" result={contaminated} />,
    );
    // JSON shape summary is still rendered.
    expect(container.textContent).toContain('3');
    expect(container.textContent).not.toContain('--- SAGE:');
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
  });

  it('renders grep JSON output with SAGE separately', () => {
    const grepOutput = JSON.stringify({
      matches: [{ file: 'a.ts', line: 1, text: 'foo' }],
      count: 1,
    });
    const contaminated = `${grepOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="grep" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
  });

  it('renders read JSON output with SAGE separately', () => {
    const readOutput = JSON.stringify({ bytes: 42, path: 'src/foo.ts' });
    const contaminated = `${readOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="read" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
  });

  it('renders read serialized-text output with SAGE separately', () => {
    const readText = 'read (path=src/foo.ts, total_lines=2)\n  1→const x;\n  2→const y;';
    const contaminated = `${readText}\n\n${SAGE_BLOCK}`;
    const { container } = render(
      <ToolResult toolName="read" result={contaminated} />,
    );
    expect(container.textContent).toContain('src/foo.ts');
    expect(container.textContent).not.toContain('--- SAGE:');
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
  });

  it('renders edit JSON output with SAGE separately', () => {
    const editOutput = JSON.stringify({
      path: 'src/a.ts',
      replacements: 1,
      diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-a\n+b',
    });
    const contaminated = `${editOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="edit" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
  });

  it('renders patch JSON output with SAGE separately', () => {
    const patchOutput = JSON.stringify({
      applied: 1,
      rejected: 0,
      files: ['src/c.ts'],
    });
    const contaminated = `${patchOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="patch" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
  });

  it('renders replace multi-file JSON output with SAGE separately', () => {
    const replaceOutput = JSON.stringify({
      files_modified: 2,
      total_replacements: 4,
      files: ['src/a.ts', 'src/b.ts'],
    });
    const contaminated = `${replaceOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="replace" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
  });

  it('renders write JSON output with SAGE separately', () => {
    const writeOutput = JSON.stringify({
      created: false,
      path: 'src/d.ts',
      diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new',
    });
    const contaminated = `${writeOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="write" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-card')).toBeTruthy();
  });

  it('does NOT render a SAGE card when the result has no injection', () => {
    const globOutput = JSON.stringify({ files: ['src/a.ts'] });
    const { container } = render(
      <ToolResult toolName="glob" result={globOutput} />,
    );
    expect(container.textContent).toContain('src/a.ts');
    expect(screen.queryByTestId('sage-memory-card')).toBeNull();
    expect(container.textContent).not.toContain('--- SAGE:');
  });

  it('does NOT render a SAGE card when the result is plain text without injection', () => {
    const plain = 'just some plain tool output\nline 2';
    const { container } = render(<ToolResult toolName="bash" result={plain} />);
    expect(container.textContent).toContain('just some plain tool output');
    expect(screen.queryByTestId('sage-memory-card')).toBeNull();
  });
});