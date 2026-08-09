import { Writable } from 'node:stream';
import { stripAnsi } from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import { renderDiff } from '../src/diff-renderer.js';
import { TerminalRenderer } from '../src/renderer.js';

class CaptureStream extends Writable {
  buf = '';
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

function mkRenderer() {
  const out = new CaptureStream() as never as NodeJS.WriteStream;
  const err = new CaptureStream() as never as NodeJS.WriteStream;
  const renderer = new TerminalRenderer({ out, err });
  return {
    renderer,
    out: () => stripAnsi((out as never as CaptureStream).buf),
    err: () => stripAnsi((err as never as CaptureStream).buf),
  };
}

describe('TerminalRenderer', () => {
  it('write outputs text', () => {
    const r = mkRenderer();
    r.renderer.write('hello');
    expect(r.out()).toContain('hello');
  });

  it('writeLine adds newline', () => {
    const r = mkRenderer();
    r.renderer.writeLine('one');
    r.renderer.writeLine('two');
    expect(r.out()).toContain('one');
    expect(r.out()).toContain('two');
  });

  it('writeToolCall formats name + summary', () => {
    const r = mkRenderer();
    r.renderer.writeToolCall('read', { path: '/tmp/foo.ts' });
    expect(r.out()).toContain('read');
    expect(r.out()).toContain('/tmp/foo.ts');
  });

  it('writeToolResult marks errors', () => {
    const r = mkRenderer();
    r.renderer.writeToolResult('read', 'oops', true);
    expect(r.out()).toContain('oops');
    expect(r.out()).toContain('✘');
  });

  it('writeToolResult renders unified diff for edit tool', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/x.ts',
      replacements: 1,
      diff: '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+new\n',
    });
    r.renderer.writeToolResult('edit', payload, false);
    const out = r.out();
    expect(out).toContain('1 replacement');
    expect(out).toContain('-old');
    expect(out).toContain('+new');
  });

  it('writeToolResult shows multi-line preview for read with +N more', () => {
    const r = mkRenderer();
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n');
    r.renderer.writeToolResult('read', lines, false);
    const out = r.out();
    expect(out).toContain('line-1');
    expect(out).toContain('line-10');
    expect(out).not.toContain('line-11'); // capped at 10 preview lines
    expect(out).toContain('+10 more');
  });

  it('writeToolResult is compact (2-line preview) for unknown tools', () => {
    const r = mkRenderer();
    const lines = Array.from({ length: 5 }, (_, i) => `x${i}`).join('\n');
    r.renderer.writeToolResult('unknown-tool', lines, false);
    const out = r.out();
    expect(out).toContain('x0');
    expect(out).toContain('x1');
    expect(out).not.toContain('x2');
    expect(out).toContain('+3 more');
  });

  it('writeWarning goes to stderr', () => {
    const r = mkRenderer();
    r.renderer.writeWarning('careful');
    expect(r.err()).toContain('careful');
    expect(r.out()).toBe('');
  });

  it('writeError + writeInfo go to stderr', () => {
    const r = mkRenderer();
    r.renderer.writeError('bad');
    r.renderer.writeInfo('fyi');
    expect(r.err()).toContain('bad');
    expect(r.err()).toContain('fyi');
  });

  it('writeBlock dispatches text/tool_use/tool_result', () => {
    const r = mkRenderer();
    r.renderer.writeBlock({ type: 'text', text: 'hi' });
    r.renderer.writeBlock({ type: 'tool_use', id: '1', name: 'glob', input: { pattern: '*.ts' } });
    r.renderer.writeBlock({ type: 'tool_result', tool_use_id: '1', content: 'done' });
    const out = r.out();
    expect(out).toContain('hi');
    expect(out).toContain('glob');
    expect(out).toContain('done');
  });

  it('writeBlock applies the render mode for a named tool result', () => {
    const r = mkRenderer();
    r.renderer.setResultRenderMode('read', 'simple');
    r.renderer.writeBlock({
      type: 'tool_result',
      tool_use_id: '1',
      name: 'read',
      content: JSON.stringify({ path: '/p/foo.ts', total_lines: 2, text: 'first\nsecond' }),
    });

    expect(r.out()).toContain('/p/foo.ts');
    expect(r.out()).not.toContain('first');
    expect(r.out()).not.toContain('second');
  });

  it('clear emits ANSI clear sequence', () => {
    const r = mkRenderer();
    r.renderer.clear();
    // raw stream contains the escape, but stripped form is empty
    expect(r.out()).toBe('');
  });

  it('write renders bold and inline code markdown', () => {
    const r = mkRenderer();
    r.renderer.write('Use **pnpm** with `vitest`');
    expect(r.out()).toContain('pnpm');
    expect(r.out()).toContain('vitest');
  });

  it('writeToolResult shows count for grep result (non-JSON string)', () => {
    const r = mkRenderer();
    r.renderer.writeToolResult('grep', 'file.ts:10:match', false);
    expect(r.out()).toContain('file.ts');
  });

  it('writeToolResult shows file list for glob result', () => {
    const r = mkRenderer();
    r.renderer.writeToolResult('glob', '["/a.ts","/b.ts"]', false);
    expect(r.out()).toContain('/a.ts');
  });

  it('writeToolResult handles long line truncation in preview', () => {
    const r = mkRenderer();
    const longLine = 'x'.repeat(250);
    r.renderer.writeToolResult('read', longLine + '\nsecond', false);
    const out = r.out();
    expect(out).toContain('…');
    expect(out).toContain('second');
  });
});

describe('TerminalRenderer.setSilent', () => {
  it('suppresses all stdout-bound writes once enabled', () => {
    const r = mkRenderer();
    r.renderer.setSilent(true);
    expect(r.renderer.isSilent()).toBe(true);
    r.renderer.write('hello');
    r.renderer.writeLine('line');
    r.renderer.writeToolCall('read', { path: '/x' });
    r.renderer.writeToolResult('read', 'big output', false);
    r.renderer.writeDiff('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new');
    r.renderer.writeBlock({ type: 'text', text: 'block' });
    r.renderer.clear();
    expect(r.out()).toBe('');
  });

  it('still routes writeInfo/writeWarning/writeError through stderr while silent', () => {
    const r = mkRenderer();
    r.renderer.setSilent(true);
    r.renderer.writeInfo('hello');
    r.renderer.writeWarning('warn');
    r.renderer.writeError('boom');
    expect(r.err()).toContain('hello');
    expect(r.err()).toContain('warn');
    expect(r.err()).toContain('boom');
    expect(r.out()).toBe('');
  });

  it('resumes stdout writes after setSilent(false)', () => {
    const r = mkRenderer();
    r.renderer.setSilent(true);
    r.renderer.write('hidden');
    r.renderer.setSilent(false);
    r.renderer.write('visible');
    expect(r.out()).not.toContain('hidden');
    expect(r.out()).toContain('visible');
  });
});

describe('TerminalRenderer.setTuiActive', () => {
  it('suppresses both stdout rendering and stderr diagnostics while active', () => {
    const r = mkRenderer();
    r.renderer.setTuiActive(true);

    expect(r.renderer.isTuiActive()).toBe(true);
    r.renderer.write('hidden output');
    r.renderer.writeInfo('hidden info');
    r.renderer.writeWarning('hidden warning');
    r.renderer.writeError('hidden error');

    expect(r.out()).toBe('');
    expect(r.err()).toBe('');
  });

  it('restores both streams after the TUI releases terminal ownership', () => {
    const r = mkRenderer();
    r.renderer.setTuiActive(true);
    r.renderer.setTuiActive(false);

    r.renderer.write('visible output');
    r.renderer.writeInfo('visible info');

    expect(r.out()).toContain('visible output');
    expect(r.err()).toContain('visible info');
  });

  it('keeps generic silent mode stderr-compatible for WebUI callers', () => {
    const r = mkRenderer();
    r.renderer.setSilent(true);
    r.renderer.writeInfo('still visible');

    expect(r.out()).toBe('');
    expect(r.err()).toContain('still visible');
  });

  it('keeps TUI and generic silent flags independent', () => {
    const r = mkRenderer();
    r.renderer.setSilent(true);
    r.renderer.setTuiActive(true);
    r.renderer.writeInfo('hidden while TUI owns stderr');

    r.renderer.setTuiActive(false);
    r.renderer.write('stdout remains hidden');
    r.renderer.writeInfo('stderr belongs to the WebUI host again');

    expect(r.out()).toBe('');
    expect(r.err()).not.toContain('hidden while TUI owns stderr');
    expect(r.err()).toContain('stderr belongs to the WebUI host again');
  });
});

describe('TerminalRenderer.setResultRenderMode', () => {
  it('defaults to extend: read shows full multi-line preview', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/foo.ts',
      total_lines: 50,
      truncated: true,
      text: Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n'),
    });
    r.renderer.writeToolResult('read', payload, false);
    const out = r.out();
    expect(out).toContain('/p/foo.ts');
    expect(out).toContain('line-1');
    expect(out).toContain('line-10');
    expect(out).not.toContain('line-11');
  });

  it('simple: read hides content lines, shows only meta (path + line count)', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/foo.ts',
      total_lines: 50,
      truncated: true,
      text: Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join('\n'),
    });
    r.renderer.setResultRenderMode('read', 'simple');
    r.renderer.writeToolResult('read', payload, false);
    const out = r.out();
    // Meta is shown.
    expect(out).toContain('/p/foo.ts');
    expect(out).toContain('50 lines');
    expect(out).toContain('truncated');
    // Content lines are hidden.
    expect(out).not.toContain('line-1');
    expect(out).not.toContain('line-10');
    expect(out).not.toContain('line-30');
    // No +N more indicator in simple mode (we're not previewing at all).
    expect(out).not.toContain('more line');
  });

  it('simple: bash hides stdout/stderr, shows only exit + size', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      exitCode: 0,
      stdout: 'a\nb\nc\nd\ne',
      stderr: '',
    });
    r.renderer.setResultRenderMode('bash', 'simple');
    r.renderer.writeToolResult('bash', payload, false);
    const out = r.out();
    expect(out).toContain('exit=0');
    expect(out).toContain('5 stdout lines');
    // Raw stdout lines never rendered.
    expect(out).not.toContain('a');
    expect(out).not.toContain('b');
    expect(out).not.toContain('c');
  });

  it('simple: one-shot — mode is consumed after one write', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/foo.ts',
      total_lines: 50,
      text: Array.from({ length: 5 }, (_, i) => `line-${i + 1}`).join('\n'),
    });
    r.renderer.setResultRenderMode('read', 'simple');
    r.renderer.writeToolResult('read', payload, false);
    // Second write without re-hint should be extend (default) again.
    r.renderer.writeToolResult('read', payload, false);
    const out = r.out();
    // Both writes happened, second one shows content.
    expect(out).toContain('line-1');
  });

  it('does not stage a mode while the TUI suppresses stdout', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/foo.ts',
      total_lines: 5,
      text: 'a\nb\nc\nd\ne',
    });

    r.renderer.setTuiActive(true);
    r.renderer.setResultRenderMode('read', 'simple');
    r.renderer.setTuiActive(false);
    r.renderer.writeToolResult('read', payload, false);

    expect(r.out()).toContain('a');
    expect(r.out()).toContain('b');
  });

  it('clears a mode staged before the TUI takes ownership', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/foo.ts',
      total_lines: 5,
      text: 'a\nb\nc\nd\ne',
    });

    r.renderer.setResultRenderMode('read', 'simple');
    r.renderer.setTuiActive(true);
    r.renderer.setTuiActive(false);
    r.renderer.writeToolResult('read', payload, false);

    expect(r.out()).toContain('a');
    expect(r.out()).toContain('b');
  });

  it('consumes a staged mode when the TUI suppresses the matching result', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/foo.ts',
      total_lines: 5,
      text: 'a\nb\nc\nd\ne',
    });

    r.renderer.setResultRenderMode('read', 'simple');
    r.renderer.setTuiActive(true);
    r.renderer.writeToolResult('read', payload, false);
    r.renderer.setTuiActive(false);
    r.renderer.writeToolResult('read', payload, false);

    expect(r.out()).toContain('a');
    expect(r.out()).toContain('b');
  });

  it('consumes a staged mode when silent mode suppresses the matching result', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/foo.ts',
      total_lines: 5,
      text: 'a\nb\nc\nd\ne',
    });

    r.renderer.setResultRenderMode('read', 'simple');
    r.renderer.setSilent(true);
    r.renderer.writeToolResult('read', payload, false);
    r.renderer.setSilent(false);
    r.renderer.writeToolResult('read', payload, false);

    expect(r.out()).toContain('a');
    expect(r.out()).toContain('b');
  });

  it('consumes a staged mode through a suppressed named tool-result block', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/foo.ts',
      total_lines: 5,
      text: 'a\nb\nc\nd\ne',
    });

    r.renderer.setResultRenderMode('read', 'simple');
    r.renderer.setSilent(true);
    r.renderer.writeBlock({
      type: 'tool_result',
      tool_use_id: '1',
      name: 'read',
      content: payload,
    });
    r.renderer.setSilent(false);
    r.renderer.writeToolResult('read', payload, false);

    expect(r.out()).toContain('a');
    expect(r.out()).toContain('b');
  });

  it('bounds abandoned render-mode hints by evicting the oldest name', () => {
    const r = mkRenderer();
    for (let i = 0; i <= 256; i++) {
      r.renderer.setResultRenderMode(`tool-${i}`, 'simple');
    }

    r.renderer.writeToolResult('tool-0', 'old-first\nold-second', false);
    r.renderer.writeToolResult('tool-256', 'new-first\nnew-second', false);

    expect(r.out()).toContain('old-second');
    expect(r.out()).not.toContain('new-second');
  });

  it('simple: applies to grep/glob when content is structured (count meta)', () => {
    const r = mkRenderer();
    // Realistic grep result shape: structured `{count, matches}` or a JSON
    // array of files. Simple mode should show only the count line, not
    // every file.
    const payload = JSON.stringify({
      count: 42,
      matches: Array.from({ length: 42 }, (_, i) => `file-${i}.ts`),
    });
    r.renderer.setResultRenderMode('grep', 'simple');
    r.renderer.writeToolResult('grep', payload, false);
    const out = r.out();
    expect(out).toContain('42 matches');
    // Individual file names from the structured payload must not be shown.
    expect(out).not.toContain('file-0.ts');
    expect(out).not.toContain('file-19.ts');
    expect(out).not.toContain('file-41.ts');
  });

  it('extend: still renders the full preview after a prior simple hint was consumed', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/foo.ts',
      total_lines: 5,
      text: 'a\nb\nc\nd\ne',
    });
    r.renderer.setResultRenderMode('read', 'simple');
    r.renderer.writeToolResult('read', payload, false); // consumed
    r.renderer.writeToolResult('read', payload, false); // extend default
    const out = r.out();
    expect(out).toContain('a');
    expect(out).toContain('b');
  });
});

describe('renderDiff', () => {
  it('returns empty for empty diff', () => {
    expect(renderDiff('')).toBe('');
  });

  it('keeps content lines, applying ANSI', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n unchanged';
    const out = stripAnsi(renderDiff(diff));
    expect(out).toContain('--- a/x');
    expect(out).toContain('+++ b/x');
    expect(out).toContain('-old');
    expect(out).toContain('+new');
    expect(out).toContain('unchanged');
  });
});
