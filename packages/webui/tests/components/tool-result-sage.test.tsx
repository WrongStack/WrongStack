import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolResult } from '../../src/components/ToolResult.js';

const SAGE_BLOCK = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-1">remembered glob fact</memory> [tags=glob]',
  '- [decision][high] <memory id="mem-2">remembered glob decision</memory>',
].join('\n');

/**
 * SAGE memory injection is no longer rendered inline in chat history.
 * ToolResult shows a compact badge (`sage-memory-badge`) with the count
 * of injected memories. The full memory cards live in the Memory Injector
 * side panel.
 */
describe('<ToolResult /> — SAGE memory injection badge', () => {
  it('renders glob JSON output without the SAGE header in the result body', () => {
    const globOutput = JSON.stringify({ files: ['src/a.ts', 'src/b.tsx'] });
    const contaminated = `${globOutput}\n\n${SAGE_BLOCK}\n`;
    const { container } = render(<ToolResult toolName="glob" result={contaminated} />);
    // The glob result body still surfaces the file paths.
    expect(container.textContent).toContain('src/a.ts');
    expect(container.textContent).toContain('src/b.tsx');
    // The SAGE header must NOT appear inline in the result body.
    expect(container.textContent).not.toContain('--- SAGE:');
    // The badge surfaces the injection evidence (2 memories).
    const badge = screen.getByTestId('sage-memory-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('2');
  });

  it('renders tree JSON output with SAGE separately', () => {
    const treeOutput = JSON.stringify({
      total_files: 3,
      total_dirs: 1,
      truncated: false,
      entries: [{ path: 'src/a.ts', kind: 'file' }],
    });
    const contaminated = `${treeOutput}\n\n${SAGE_BLOCK}`;
    const { container } = render(<ToolResult toolName="tree" result={contaminated} />);
    // JSON shape summary is still rendered.
    expect(container.textContent).toContain('3');
    expect(container.textContent).not.toContain('--- SAGE:');
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });

  it('renders grep JSON output with SAGE separately', () => {
    const grepOutput = JSON.stringify({
      matches: [{ file: 'a.ts', line: 1, text: 'foo' }],
      count: 1,
    });
    const contaminated = `${grepOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="grep" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });

  it('renders read JSON output with SAGE separately', () => {
    const readOutput = JSON.stringify({ bytes: 42, path: 'src/foo.ts' });
    const contaminated = `${readOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="read" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });

  it('renders read serialized-text output with SAGE separately', () => {
    const readText = 'read (path=src/foo.ts, total_lines=2)\n  1→const x;\n  2→const y;';
    const contaminated = `${readText}\n\n${SAGE_BLOCK}`;
    const { container } = render(<ToolResult toolName="read" result={contaminated} />);
    expect(container.textContent).toContain('src/foo.ts');
    expect(container.textContent).not.toContain('--- SAGE:');
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });

  it('renders edit JSON output with SAGE separately', () => {
    const editOutput = JSON.stringify({
      path: 'src/a.ts',
      replacements: 1,
      diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-a\n+b',
    });
    const contaminated = `${editOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="edit" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });

  it('renders patch JSON output with SAGE separately', () => {
    const patchOutput = JSON.stringify({
      applied: 1,
      rejected: 0,
      files: ['src/c.ts'],
    });
    const contaminated = `${patchOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="patch" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });

  it('renders replace multi-file JSON output with SAGE separately', () => {
    const replaceOutput = JSON.stringify({
      files_modified: 2,
      total_replacements: 4,
      files: ['src/a.ts', 'src/b.ts'],
    });
    const contaminated = `${replaceOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="replace" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });

  it('renders write JSON output with SAGE separately', () => {
    const writeOutput = JSON.stringify({
      created: false,
      path: 'src/d.ts',
      diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new',
    });
    const contaminated = `${writeOutput}\n\n${SAGE_BLOCK}`;
    render(<ToolResult toolName="write" result={contaminated} />);
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });

  it('does NOT render a badge when the result has no injection', () => {
    const globOutput = JSON.stringify({ files: ['src/a.ts'] });
    const { container } = render(<ToolResult toolName="glob" result={globOutput} />);
    expect(container.textContent).toContain('src/a.ts');
    expect(screen.queryByTestId('sage-memory-badge')).toBeNull();
    expect(container.textContent).not.toContain('--- SAGE:');
  });

  it('does NOT render a badge when the result is plain text without injection', () => {
    const plain = 'just some plain tool output\nline 2';
    const { container } = render(<ToolResult toolName="bash" result={plain} />);
    expect(container.textContent).toContain('just some plain tool output');
    expect(screen.queryByTestId('sage-memory-badge')).toBeNull();
  });
});

/**
 * Live tool results carry the block out-of-band in `tool.executed.sage`; the
 * backend splits it off before the event's ~400-char preview cap. `result` then
 * holds tool text only, so the badge must come from the prop.
 */
describe('<ToolResult /> — SAGE lines delivered out-of-band', () => {
  const sageLines = SAGE_BLOCK.split('\n');

  it('renders the memory badge from the prop when the body has no SAGE suffix', () => {
    const { container } = render(
      <ToolResult toolName="glob" result="src/a.ts\nsrc/b.tsx" sageLines={sageLines} />,
    );
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
    expect(container.textContent).not.toContain('--- SAGE:');
  });

  it('renders the badge even when the preview cap truncated the tool body away', () => {
    // Short body + long memory line was the shape that used to straddle the cut.
    render(<ToolResult toolName="grep" result={`${'x'.repeat(399)}…`} sageLines={sageLines} />);
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });

  it('prefers the out-of-band lines over anything parsed from the body', () => {
    const stale = [
      '--- SAGE: task-aware project knowledge (Memory Injector) ---',
      '- [fact] <memory id="mem-stale">stale inline memory</memory>',
    ].join('\n');
    const { container } = render(
      <ToolResult toolName="glob" result={`files\n\n${stale}`} sageLines={sageLines} />,
    );
    // The stale inline memory text must not appear — the out-of-band lines win.
    expect(container.textContent).not.toContain('stale inline memory');
    expect(container.textContent).not.toContain('--- SAGE:');
    // Badge count reflects the out-of-band sageLines (2 memories).
    const badge = screen.getByTestId('sage-memory-badge');
    expect(badge.textContent).toContain('2');
  });

  it('falls back to the inline split when no lines are supplied (replay path)', () => {
    render(<ToolResult toolName="glob" result={`files\n\n${SAGE_BLOCK}`} sageLines={[]} />);
    expect(screen.getByTestId('sage-memory-badge')).toBeTruthy();
  });
});
