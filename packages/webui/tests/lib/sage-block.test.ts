import { describe, expect, it } from 'vitest';
import { extractSageBlock } from '../../src/lib/sage-block';

const SAGE_BLOCK = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-1">remembered fact</memory> [tags=test]',
  '- [decision][high] <memory id="mem-2">another memory</memory>',
].join('\n');

const SAGE_BLOCK_TASK = [
  '--- SAGE: task-aware project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-3">task memory</memory>',
].join('\n');

describe('extractSageBlock', () => {
  describe('tolerant trailing-whitespace handling', () => {
    it('strips SAGE block followed by a single trailing newline', () => {
      const result = extractSageBlock(`hello\n\n${SAGE_BLOCK}\n`);
      expect(result.sageLines.length).toBe(3);
      expect(result.cleanOutput).toBe('hello');
      expect(result.cleanOutput).not.toContain('SAGE');
    });

    it('strips SAGE block followed by trailing blank lines', () => {
      const result = extractSageBlock(`hello\n\n${SAGE_BLOCK}\n\n`);
      expect(result.sageLines.length).toBe(3);
      expect(result.cleanOutput).toBe('hello');
      expect(result.cleanOutput).not.toContain('SAGE');
    });

    it('strips SAGE block followed by trailing whitespace-only line', () => {
      const result = extractSageBlock(`hello\n\n${SAGE_BLOCK}\n   `);
      expect(result.sageLines.length).toBe(3);
      expect(result.cleanOutput).toBe('hello');
      expect(result.cleanOutput).not.toContain('SAGE');
    });

    it('strips SAGE block exactly at end (no trailing whitespace)', () => {
      const result = extractSageBlock(`hello\n\n${SAGE_BLOCK}`);
      expect(result.sageLines.length).toBe(3);
      expect(result.cleanOutput).toBe('hello');
      expect(result.cleanOutput).not.toContain('SAGE');
    });
  });

  describe('shape detection', () => {
    it('extracts SAGE block from JSON tool output (exec/glob/grep style)', () => {
      const execJson = JSON.stringify({
        exit_code: 0,
        stdout: 'hello',
        stderr: '',
      });
      const contaminated = `${execJson}\n\n${SAGE_BLOCK}\n`;
      const result = extractSageBlock(contaminated);
      expect(result.cleanOutput).toBe(execJson);
      expect(result.cleanOutput).not.toContain('SAGE');
      expect(result.sageLines.length).toBe(3);
    });

    it('extracts SAGE block from text tool output (read/grep text style)', () => {
      const textOutput = 'grep (count=2)\nsrc/a.ts:10:const x\nsrc/b.ts:20:const y';
      const contaminated = `${textOutput}\n\n${SAGE_BLOCK}`;
      const result = extractSageBlock(contaminated);
      expect(result.cleanOutput).toBe(textOutput);
      expect(result.sageLines.length).toBe(3);
    });

    it('extracts task-aware SAGE block (different heading)', () => {
      const output = `hello\n\n${SAGE_BLOCK_TASK}`;
      const result = extractSageBlock(output);
      expect(result.sageLines.length).toBe(2);
      expect(result.cleanOutput).toBe('hello');
    });
  });

  describe('negative controls', () => {
    it('leaves ordinary SAGE-like output untouched', () => {
      const output = 'command output\n--- SAGE: example from a fixture\nstill ordinary output';
      expect(extractSageBlock(output)).toEqual({ cleanOutput: output, sageLines: [] });
    });

    it('leaves input alone when no SAGE block is present', () => {
      const output = 'plain text output\nline 2';
      expect(extractSageBlock(output)).toEqual({ cleanOutput: output, sageLines: [] });
    });

    it('rejects a SAGE header followed by an invalid memory line', () => {
      const output = `hello\n--- SAGE: related project knowledge (Memory Injector) ---\nnot a valid memory line`;
      expect(extractSageBlock(output)).toEqual({ cleanOutput: output, sageLines: [] });
    });

    it('rejects a SAGE-like header with a stray extra dash', () => {
      const fake = '--- SAGE: related project knowledge (Memory Injector) ----';
      const output = `hello\n${fake}\n- [fact] <memory id="x">y</memory>`;
      expect(extractSageBlock(output)).toEqual({ cleanOutput: output, sageLines: [] });
    });

    it('does NOT strip SAGE block followed by real (non-blank) content', () => {
      const output = `tool result\n\n${SAGE_BLOCK}\nsome real trailing content`;
      expect(extractSageBlock(output)).toEqual({ cleanOutput: output, sageLines: [] });
    });
  });

  describe('edge cases', () => {
    it('returns the entire input when it is a SAGE-only block', () => {
      const result = extractSageBlock(SAGE_BLOCK);
      expect(result.cleanOutput).toBe('');
      expect(result.sageLines.length).toBe(3);
    });

    it('only strips the LAST valid SAGE block when multiple are present', () => {
      const output = `hello\n\n${SAGE_BLOCK}\n\nmore output\n\n${SAGE_BLOCK_TASK}`;
      const result = extractSageBlock(output);
      // Scans from end; finds the last valid block (task-aware variant).
      expect(result.sageLines.length).toBe(2);
      expect(result.cleanOutput).toContain('hello');
      expect(result.cleanOutput).toContain('more output');
    });

    it('handles a SAGE block with a single memory', () => {
      const single = [
        '--- SAGE: related project knowledge (Memory Injector) ---',
        '- [fact] <memory id="only">only memory</memory>',
      ].join('\n');
      const result = extractSageBlock(`x\n\n${single}\n`);
      expect(result.cleanOutput).toBe('x');
      expect(result.sageLines.length).toBe(2);
    });
  });

  describe('memory-line regex robustness (real-world shapes)', () => {
    const lines = [
      '- [fact] <memory id="01KYF0MQW6PP8ZDCGJ0Y4KV4KW">SAGE memory display separation in TUI</memory> [tags=tui,sage,memory-injection]',
      '- [decision][high] <memory id="01KYF7X8FM0XJYWA14TX50XNZF">TUI tool-result rendering treats the exact terminal suffix</memory> [tags=tui,sage,tool-results]',
      '- [bug_root_cause][critical] <memory id="mem_01KXXKMPNFS42MCBX30NNKZYNR">Telegram P1.2 frozen commit</memory> (.) [relation=about_file; tags=telegram,p1.2,abort-signal]',
      '- [fact] <memory id="01KYF8ZKMJ4XCVNVFFQRAH2G4W">The TUI renders</memory> (@wrongstack/tui) [relation=about_package; tags=tui,sage,rendering]',
    ];

    for (const line of lines) {
      it(`matches: ${line.slice(0, 80)}…`, () => {
        const block = `--- SAGE: related project knowledge (Memory Injector) ---\n${line}`;
        const result = extractSageBlock(`x\n\n${block}\n`);
        expect(result.sageLines.length).toBe(2);
        expect(result.cleanOutput).toBe('x');
      });
    }
  });

  /**
   * Live results now arrive with the block already split off, but several other
   * paths still cap tool text by characters (fleet bridge, HQ raw-content cap,
   * TUI history retention). A block whose last line those caps cut must still
   * render as memory rather than decaying into raw tool output.
   */
  describe('caps that cut the last memory line', () => {
    const header = '--- SAGE: related project knowledge (Memory Injector) ---';
    const full =
      '- [fact] <memory id="mem-1">a fairly long remembered fact about globbing</memory> [tags=glob]';

    it('accepts a truncated final memory line', () => {
      const cut = `${full.slice(0, 60)}…`;
      const result = extractSageBlock(`x\n\n${header}\n${cut}`);
      expect(result.cleanOutput).toBe('x');
      expect(result.sageLines).toEqual([header, cut]);
    });

    it('accepts a complete line followed by a truncated one', () => {
      const cut = `${full.slice(0, 55)}…`;
      const result = extractSageBlock(`x\n\n${header}\n${full}\n${cut}`);
      expect(result.sageLines).toEqual([header, full, cut]);
    });

    it('rejects a truncated line that is not last — the shape is broken', () => {
      const cut = `${full.slice(0, 55)}…`;
      const result = extractSageBlock(`x\n\n${header}\n${cut}\n${full}`);
      expect(result.sageLines).toEqual([]);
    });

    it('still rejects prose that merely ends in an ellipsis', () => {
      const output = `x\n\n${header}\nsome truncated prose…`;
      expect(extractSageBlock(output)).toEqual({ cleanOutput: output, sageLines: [] });
    });
  });
});

describe('SAGE suffix parser sync contract (2026-08-02)', () => {
  // WebUI's extractSageBlock must delegate to the canonical core parser
  // (@wrongstack/core/utils/sage-output-block). The TUI's extractSageBlock
  // delegates to the same module (see verify-sage-all-tools.test.ts), so a
  // future producer-format change lands in ONE place and every surface
  // inherits it. This test pins the delegation so a regression back to a
  // local copy (the old byte-identical three-copy layout) fails loudly.
  it('delegates to splitSageOutputBlock from core', async () => {
    const core = await import('@wrongstack/core/utils/sage-output-block');
    const sample =
      'packages/a.ts\n\n--- SAGE: related project knowledge (Memory Injector) ---\n- [fact] <memory id="sync-1">sync probe</memory>';
    const fromWebui = extractSageBlock(sample);
    const fromCore = core.splitSageOutputBlock(sample);
    expect(fromWebui.sageLines).toEqual(fromCore.sageLines);
    expect(fromWebui.cleanOutput).toBe(fromCore.body);
  });

  it('shares the canonical heading set', async () => {
    const core = await import('@wrongstack/core/utils/sage-output-block');
    expect(
      core.SAGE_INJECTOR_HEADINGS.has(
        '--- SAGE: task-aware project knowledge (Memory Injector) ---',
      ),
    ).toBe(true);
    expect(
      core.SAGE_INJECTOR_HEADINGS.has('--- SAGE: related project knowledge (Memory Injector) ---'),
    ).toBe(true);
  });
});
