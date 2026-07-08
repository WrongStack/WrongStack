import { describe, expect, it } from 'vitest';
import { SUMMARIZE_TOOL_INPUT_BROWSER_SRC, summarizeToolInput } from '../src/tool-summary.js';

/**
 * Parity guard: the HQ dashboard cannot `import` at browser runtime, so it
 * embeds `SUMMARIZE_TOOL_INPUT_BROWSER_SRC` — a hand-written browser-JS
 * transcription of `summarizeToolInput`. This test compiles that source and
 * asserts, over a broad fixture table, that it produces output IDENTICAL to the
 * TypeScript implementation. If the two ever drift, this fails loudly.
 *
 * The TS function is fed the parsed object; the browser function is fed the
 * JSON string (HQ's on-wire shape) — so this also validates the object↔string
 * coercion path.
 */

// Compile the embedded browser source into a callable function.
// The source defines `toolInputSummary(name, rawInput)`; we return it.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const browserSummarize = new Function(
  `${SUMMARIZE_TOOL_INPUT_BROWSER_SRC}\nreturn toolInputSummary;`,
)() as (name: string | undefined, rawInput: string | null) => string;

interface Case {
  readonly label: string;
  readonly tool: string | undefined;
  readonly input: unknown;
}

const cases: readonly Case[] = [
  // TodoWrite
  { label: 'todos mixed', tool: 'todo', input: { todos: [{ status: 'completed' }, { status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }] } },
  { label: 'single todo', tool: 'todo_write', input: { todos: [{ status: 'pending' }] } },
  { label: 'empty todos', tool: 'todos', input: { todos: [] } },
  { label: 'todos via array, no name', tool: undefined, input: { todos: [{ status: 'completed' }] } },
  // batch
  { label: 'batch names', tool: 'batch_tool_use', input: { tool_uses: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }] } },
  { label: 'batch +N', tool: 'batch_tool_use', input: { tool_uses: [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'grep' }, { name: 'glob' }] } },
  { label: 'parallel calls', tool: 'parallel_tool_use', input: { calls: [{ name: 'read' }] } },
  { label: 'batch array key', tool: 'batch', input: { batch: [{ name: 'read' }, { name: 'write' }] } },
  { label: 'empty batch', tool: 'batch_tool_use', input: { tool_uses: [] } },
  { label: 'batch by tool key', tool: 'batch_tool_use', input: { calls: [{ tool: 'read' }, { tool: 'read' }, { tool: 'bash' }] } },
  // edit / patch
  { label: 'edit abs path', tool: 'edit', input: { file_path: '/foo/bar.ts', old_string: 'a\nb\nc', new_string: 'x\ny\nz' } },
  { label: 'edit delete', tool: 'str_replace', input: { path: 'test.ts', old_string: '1\n2\n3\n4\n5', new_string: '' } },
  { label: 'edit add', tool: 'patch', input: { path: 'file.ts', old_string: '', new_string: 'new' } },
  { label: 'edit no path', tool: 'edit', input: { old_string: 'a', new_string: 'b' } },
  // write
  { label: 'write with lines', tool: 'write', input: { path: '/tmp/test.ts', content: 'a\nb\nc' } },
  { label: 'write one line', tool: 'create_file', input: { file_path: 'new.ts', content: 'x' } },
  { label: 'write empty', tool: 'write', input: { path: 'empty.ts', content: '' } },
  // bash
  { label: 'bash quoted', tool: 'bash', input: { command: 'echo "hello world"' } },
  { label: 'bash cmd alias', tool: 'exec', input: { cmd: 'ls -la' } },
  { label: 'bash no command', tool: 'bash', input: {} },
  // fetch
  { label: 'fetch GET', tool: 'fetch', input: { url: 'https://api.example.com/data' } },
  { label: 'fetch POST', tool: 'fetch', input: { url: 'https://api.example.com/post', method: 'post' } },
  { label: 'fetch no url', tool: 'fetch', input: {} },
  // grep
  { label: 'grep in scope', tool: 'grep', input: { pattern: 'TODO', path: 'src/**/*.ts' } },
  { label: 'grep glob scope', tool: 'search', input: { pattern: 'fixme', glob: '*.js' } },
  { label: 'grep no scope', tool: 'grep', input: { pattern: 'TODO' } },
  // glob
  { label: 'glob pattern', tool: 'glob', input: { pattern: '**/*.ts' } },
  { label: 'find pattern', tool: 'find', input: { glob: 'src/**/*.{ts,tsx}' } },
  // read
  { label: 'read offset+limit', tool: 'read', input: { path: 'file.ts', offset: 10, limit: 50 } },
  { label: 'read offset only', tool: 'read', input: { path: 'file.ts', offset: 5 } },
  { label: 'read limit only', tool: 'read', input: { path: 'file.ts', limit: 100 } },
  { label: 'read plain', tool: 'read', input: { path: 'file.ts' } },
  // fallback head fields
  { label: 'fallback path', tool: 'unknown_tool', input: { path: '/foo/bar' } },
  { label: 'fallback file_path', tool: 'mcp__x__y', input: { file_path: '/foo/bar' } },
  { label: 'fallback description', tool: 'weird', input: { description: 'My custom tool' } },
  { label: 'fallback json', tool: 'weird', input: { weirdField: 'value' } },
  // edge cases
  { label: 'empty object', tool: 'noop', input: {} },
  { label: 'nested numbers', tool: 'x', input: { count: 42 } },
];

describe('tool-summary parity (TS vs embedded browser source)', () => {
  for (const c of cases) {
    it(`matches for: ${c.label}`, () => {
      const ts = summarizeToolInput(c.tool, c.input);
      const browser = browserSummarize(c.tool, JSON.stringify(c.input));
      expect(browser).toBe(ts);
    });
  }

  it('both return empty string for null/undefined/empty input', () => {
    for (const v of [null, undefined, '']) {
      expect(summarizeToolInput('read', v)).toBe('');
      expect(browserSummarize('read', v as null)).toBe('');
    }
  });

  it('TS accepts a JSON string identically to a parsed object', () => {
    const obj = { path: 'file.ts', offset: 10, limit: 50 };
    expect(summarizeToolInput('read', obj)).toBe(summarizeToolInput('read', JSON.stringify(obj)));
  });

  it('non-JSON string input is clipped, not parsed', () => {
    expect(summarizeToolInput('x', 'not json at all')).toBe('not json at all');
    expect(browserSummarize('x', 'not json at all')).toBe('not json at all');
  });
});
