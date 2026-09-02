import { describe, expect, it } from 'vitest';
import { formatToolOutputSage, formatToolVisualOutput } from '../src/components/history/utils.js';
import { extractSageBlock } from '../src/components/history/sage-output-format.js';

// ── Realistic SAGE block (matches live injector format) ──

const SAGE_BLOCK = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-1">test memory content here</memory> [tags=test]',
  '- [decision][high] <memory id="mem-2">another memory</memory> (@wrongstack/tui) [relation=about_package]',
].join('\n');

const SAGE_BLOCK_TASK = [
  '--- SAGE: task-aware project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-3">task memory</memory>',
].join('\n');

// ── Helper: assert no SAGE leakage ──

function assertNoSage(label: string, text: string | undefined) {
  if (!text) return;
  expect(text, `[${label}] must not contain SAGE header`).not.toContain('--- SAGE:');
  expect(text, `[${label}] must not contain memory id`).not.toContain('<memory id=');
  expect(text, `[${label}] must not contain Memory Injector`).not.toContain('Memory Injector');
}

function assertVisualNoSage(label: string, visual: ReturnType<typeof formatToolVisualOutput>) {
  if (!visual) return;
  for (let i = 0; i < visual.length; i++) {
    const line = visual[i]!;
    assertNoSage(`${label} visual[${i}].text`, line.text);
    assertNoSage(`${label} visual[${i}].marker`, line.marker);
    assertNoSage(`${label} visual[${i}].path`, line.path);
  }
}

// ── Helper: run stripping for a tool and check all outputs ──

function checkTool(toolName: string, output: string, ok = true) {
  const { cleanOutput, outLines, sageLines } = formatToolOutputSage(toolName, output, ok);
  assertNoSage(`${toolName} cleanOutput`, cleanOutput);
  for (let i = 0; i < outLines.length; i++) {
    assertNoSage(`${toolName} outLines[${i}]`, outLines[i]);
  }
  // Also check visual path gets clean input
  const visual = formatToolVisualOutput(toolName, cleanOutput, ok);
  assertVisualNoSage(toolName, visual);
  return { sageLines, cleanOutput };
}

// ════════════════════════════════════════════════════════════════
// PART 1: Per-tool stripping — JSON format
// ════════════════════════════════════════════════════════════════

describe('SAGE stripping — JSON output format (per tool)', () => {
  it('exec (JSON, safe)', () => {
    const out = JSON.stringify({
      exit_code: 0,
      stdout: 'hello\nworld',
      stderr: '',
      danger: { level: 'safe' },
    });
    checkTool('exec', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('exec (JSON, destructive)', () => {
    const out = JSON.stringify({
      exit_code: 0,
      stdout: 'done',
      stderr: '',
      danger: { level: 'destructive', reasons: ['rm -rf'] },
    });
    checkTool('exec', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('bash (JSON)', () => {
    const out = JSON.stringify({
      exit_code: 0,
      stdout: 'hello\nworld',
      stderr: '',
      timed_out: false,
    });
    checkTool('bash', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('git (JSON)', () => {
    const out = JSON.stringify({ exitCode: 0, stdout: 'main\n', stderr: '' });
    checkTool('git', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('read (JSON)', () => {
    const out = JSON.stringify({ bytes: 1234, path: 'src/foo.ts' });
    checkTool('read', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('grep (JSON)', () => {
    const out = JSON.stringify({
      matches: [{ file: 'src/a.ts', line: 10, text: 'const x' }],
      count: 1,
    });
    checkTool('grep', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('glob (JSON)', () => {
    const out = JSON.stringify({ files: ['src/a.ts', 'src/b.tsx'] });
    checkTool('glob', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('lint (JSON)', () => {
    const out = JSON.stringify({
      linter: 'biome',
      files_checked: 5,
      errors: 0,
      warnings: 2,
      fix_applied: false,
    });
    checkTool('lint', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('typecheck (JSON)', () => {
    const out = JSON.stringify({ exit_code: 0, errors: 0, output: '' });
    checkTool('typecheck', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('test (JSON)', () => {
    const out = JSON.stringify({
      runner: 'vitest',
      tests_run: 10,
      passed: 10,
      failed: 0,
      duration_ms: 500,
    });
    checkTool('test', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('format (JSON)', () => {
    const out = JSON.stringify({ fixer: 'biome', files_checked: 5, files_changed: 2 });
    checkTool('format', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('fetch (JSON)', () => {
    const out = JSON.stringify({
      status: 200,
      content_type: 'text/html',
      url: 'https://example.com',
      content: '<html>...',
    });
    checkTool('fetch', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('audit (JSON)', () => {
    const out = JSON.stringify({ total: 3, summary: '2 high, 1 low' });
    checkTool('audit', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('outdated (JSON)', () => {
    const out = JSON.stringify({
      total: 2,
      packages: [{ name: 'react', current: '18.0.0', latest: '19.0.0' }],
    });
    checkTool('outdated', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('install (JSON)', () => {
    const out = JSON.stringify({ exit_code: 0, added: 3, removed: 0, stdout: '+ react@19' });
    checkTool('install', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('tree (JSON)', () => {
    const out = JSON.stringify({ total_files: 10, total_dirs: 3, truncated: false });
    checkTool('tree', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('json (JSON)', () => {
    const out = JSON.stringify({ type: 'object', keys: ['a', 'b', 'c'] });
    checkTool('json', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('search (JSON)', () => {
    const out = JSON.stringify({ results: [{ title: 'Test', url: 'http://x.com' }], count: 1 });
    checkTool('search', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('logs (text)', () => {
    const out = '[12:00:00] INFO: started\n[12:00:01] INFO: connected';
    checkTool('logs', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('remember (text)', () => {
    const out = 'saved';
    checkTool('remember', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('todo (text)', () => {
    const out = '';
    checkTool('todo', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('mode (JSON)', () => {
    const out = JSON.stringify({ mode: 'code' });
    checkTool('mode', `${out}\n\n${SAGE_BLOCK}`);
  });
});

// ════════════════════════════════════════════════════════════════
// PART 2: Per-tool stripping — serialized text format
// ════════════════════════════════════════════════════════════════

describe('SAGE stripping — serialized text format (per tool)', () => {
  it('read (numbered lines)', () => {
    const out =
      'read (path=src/foo.ts, total_lines=3)\n  1→const x = 1;\n  2→const y = 2;\n  3→const z = 3;';
    checkTool('read', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('exec (header+sections)', () => {
    const out = 'exec (exit_code=0)\nstdout:\nhello world\nstderr:\n';
    checkTool('exec', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('typecheck (header+sections)', () => {
    const out = 'typecheck (status=ok)\nreport:\nerrors=0\nwarnings=0';
    checkTool('typecheck', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('test (header+sections)', () => {
    const out = 'test (status=ok)\nreport:\ntests_run=5\npassed=5\nfailed=0';
    checkTool('test', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('grep (text format)', () => {
    const out = 'grep (count=2)\nsrc/a.ts:10:const x\nsrc/b.ts:20:const y';
    checkTool('grep', `${out}\n\n${SAGE_BLOCK}`);
  });

  it('plain text output (generic fallback)', () => {
    const out = 'some unknown tool output line 1\nline 2\nline 3';
    checkTool('unknowntool', `${out}\n\n${SAGE_BLOCK}`);
  });
});

// ════════════════════════════════════════════════════════════════
// PART 3: Edge cases
// ════════════════════════════════════════════════════════════════

describe('SAGE stripping — edge cases', () => {
  it('SAGE-only output (empty cleanOutput)', () => {
    const result = extractSageBlock(SAGE_BLOCK);
    expect(result.cleanOutput).toBe('');
    expect(result.sageLines.length).toBe(3);
  });

  it('task-aware variant header', () => {
    const output = `hello\n\n${SAGE_BLOCK_TASK}`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(2);
    expect(result.cleanOutput).toBe('hello');
  });

  it('SAGE-like but NOT exact header → left untouched', () => {
    const fake = '--- SAGE: related project knowledge (Memory Injector) ----'; // extra dash
    const output = `hello\n${fake}\n- [fact] <memory id="x">y</memory>`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(0);
    expect(result.cleanOutput).toBe(output);
  });

  it('SAGE header but invalid memory line → left untouched', () => {
    const output = `hello\n--- SAGE: related project knowledge (Memory Injector) ---\nnot a valid memory line`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(0);
    expect(result.cleanOutput).toBe(output);
  });

  it('multiple SAGE blocks → only last one stripped', () => {
    const output = `hello\n\n${SAGE_BLOCK}\n\nmore output\n\n${SAGE_BLOCK_TASK}`;
    const result = extractSageBlock(output);
    // Scans from end; finds the last valid block.
    expect(result.sageLines.length).toBe(2); // SAGE_BLOCK_TASK has header + 1 memory
    expect(result.cleanOutput).toContain('hello');
    expect(result.cleanOutput).toContain('more output');
  });

  it('SAGE block with extra trailing whitespace/newlines after', () => {
    const output = `hello\n\n${SAGE_BLOCK}\n   \n`;
    const result = extractSageBlock(output);
    expect(result.cleanOutput).toBe('hello');
    expect(result.sageLines.length).toBe(3);
  });

  it('real SAGE block from this session (grep tool)', () => {
    // Exact format observed in real tool output
    const realBlock = [
      '--- SAGE: related project knowledge (Memory Injector) ---',
      '- [fact] <memory id="01KYF0MQW6PP8ZDCGJ0Y4KV4KW">SAGE memory display separation in TUI</memory> [tags=tui,sage,memory-injection]',
      '- [bug_root_cause][high] <memory id="01KY5MC7W2ZP8YE4GG4M0NVZCV">TUI dist artifacts wiped</memory> (packages/tui) [relation=about_package; tags=tui,build]',
      '- [workflow][high] <memory id="01KY8PDAFGFMPBH3BBS6NK7ZRY">bash tool cannot launch TUI</memory> (packages/tui) [relation=about_package; tags=tui,bash,ci]',
    ].join('\n');
    const grepOutput = JSON.stringify({
      matches: [{ file: 'a.ts', line: 1, text: 'x' }],
      count: 1,
    });
    const result = checkTool('grep', `${grepOutput}\n\n${realBlock}`);
    expect(result.sageLines.length).toBe(4);
  });

  it('memory line with HTML entities and special chars', () => {
    const block = [
      '--- SAGE: related project knowledge (Memory Injector) ---',
      '- [fact] <memory id="mem-x">User&#39;s &amp; &quot;data&quot; with &lt;tags&gt;</memory> [tags=special]',
    ].join('\n');
    const output = `output\n\n${block}`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(2);
    expect(result.cleanOutput).toBe('output');
  });
});

// ════════════════════════════════════════════════════════════════
// PART 4: Regex robustness — does the memory-line regex match
// every real SAGE line format observed in this session?
// ════════════════════════════════════════════════════════════════

describe('SAGE memory-line regex — real-world robustness', () => {
  const SAGE_MEMORY_LINE = /^- \[[^\]]+\](?:\[[^\]]+\])* <memory id="[^"]+">.*<\/memory>(?: .*)?$/;

  const realLines = [
    '- [fact] <memory id="01KYF0MQW6PP8ZDCGJ0Y4KV4KW">SAGE memory display separation in TUI</memory> [tags=tui,sage,memory-injection]',
    '- [decision][high] <memory id="01KYF7X8FM0XJYWA14TX50XNZF">TUI tool-result rendering treats the exact terminal suffix</memory> [tags=tui,sage,tool-results]',
    '- [fact] <memory id="01KYF8ZKMJ4XCVNVFFQRAH2G4W">The TUI renders</memory> (@wrongstack/tui) [relation=about_package; tags=tui,sage,rendering]',
    '- [bug_root_cause][high] <memory id="01KY5MC7W2ZP8YE4GG4M0NVZCV">TUI dist artifacts in packages/tui/dist/** are wiped</memory> (packages/tui) [relation=about_package; tags=tui,build,workspace]',
    '- [bug_root_cause][critical] <memory id="mem_01KXXKMPNFS42MCBX30NNKZYNR">Telegram P1.2 frozen commit</memory> (.) [relation=about_file; tags=telegram,p1.2,abort-signal]',
    '- [convention][high] <memory id="mem_01KY22ER2ZC5W951VAFMY3RPZ5">CodeMap.tsx perf-tuning rule</memory> (packages/webui/src/components/CodeMap.tsx) [relation=about_file; tags=codemap,performance,refactor]',
    '- [fact] <memory id="01KYCM5EVNV6VVJ9HP3N3N3AC7">The WrongStack workspace packages are</memory> (packages) [relation=about_directory; tags=workspace,packages,structure]',
  ];

  for (const line of realLines) {
    it(`matches: ${line.slice(0, 80)}...`, () => {
      expect(SAGE_MEMORY_LINE.test(line)).toBe(true);
    });
  }
});
