import { describe, expect, it } from 'vitest';
import { summarizeToolInput } from '../../src/lib/tool-summary';

describe('tool-summary', () => {
  describe('TodoWrite', () => {
    it('summarizes todos with completed and in_progress counts', () => {
      const result = summarizeToolInput('todo', {
        todos: [
          { content: 'task 1', status: 'completed' },
          { content: 'task 2', status: 'completed' },
          { content: 'task 3', status: 'in_progress' },
          { content: 'task 4', status: 'pending' },
        ],
      });
      expect(result).toBe('4 todos · 2 done · 1 in-progress');
    });

    it('handles single todo', () => {
      const result = summarizeToolInput('todo_write', {
        todos: [{ content: 'only one', status: 'pending' }],
      });
      expect(result).toBe('1 todo');
    });

    it('handles empty todos array', () => {
      const result = summarizeToolInput('todos', { todos: [] });
      expect(result).toBe('0 todos');
    });

    it('handles undefined tool name but array todos', () => {
      const result = summarizeToolInput(undefined, {
        todos: [{ content: 'test', status: 'completed' }],
      });
      expect(result).toBe('1 todo · 1 done');
    });
  });

  describe('batch_tool_use', () => {
    it('summarizes batch with sub-tool names', () => {
      const result = summarizeToolInput('batch_tool_use', {
        tool_uses: [
          { name: 'read', input: {} },
          { name: 'write', input: {} },
          { name: 'edit', input: {} },
        ],
      });
      expect(result).toBe('3 sub-tools · read, write, edit');
    });

    it('shows +N when more than 3 sub-tools', () => {
      const result = summarizeToolInput('batch_tool_use', {
        tool_uses: [
          { name: 'read', input: {} },
          { name: 'write', input: {} },
          { name: 'edit', input: {} },
          { name: 'grep', input: {} },
          { name: 'bash', input: {} },
        ],
      });
      expect(result).toBe('5 sub-tools · read, write, edit +2');
    });

    it('handles calls array', () => {
      const result = summarizeToolInput('parallel_tool_use', {
        calls: [{ name: 'read', input: {} }],
      });
      expect(result).toBe('1 sub-tool · read');
    });

    it('handles batch array', () => {
      const result = summarizeToolInput('batch', {
        batch: [
          { name: 'read', input: {} },
          { name: 'write', input: {} },
        ],
      });
      expect(result).toBe('2 sub-tools · read, write');
    });

    it('handles empty sub-tools', () => {
      const result = summarizeToolInput('batch_tool_use', {
        tool_uses: [],
      });
      expect(result).toBe('0 sub-tools');
    });
  });

  describe('edit / str_replace / patch', () => {
    it('summarizes edit with file path and line changes', () => {
      const result = summarizeToolInput('edit', {
        path: '/foo/bar.ts',
        old_string: 'line1\nline2\nline3',
        new_string: 'line1\nnew_line\nline3',
      });
      expect(result).toBe('edit /foo/bar.ts (3 → 3 lines)');
    });

    it('shows old_string line count', () => {
      const result = summarizeToolInput('str_replace', {
        path: 'test.ts',
        old_string: 'a\nb\nc\nd\ne',
        new_string: '',
      });
      expect(result).toBe('edit test.ts (5 → 0 lines)');
    });

    it('handles missing old_string', () => {
      const result = summarizeToolInput('patch', {
        path: 'file.ts',
        new_string: 'new content',
      });
      expect(result).toBe('edit file.ts (0 → 1 lines)');
    });

    it('handles missing path', () => {
      const result = summarizeToolInput('edit_file', {
        old_string: 'old',
        new_string: 'new',
      });
      expect(result).toBe('edit (file) (1 → 1 lines)');
    });
  });

  describe('write / write_file', () => {
    it('summarizes write with path and line count', () => {
      const result = summarizeToolInput('write', {
        path: '/tmp/test.ts',
        content: 'line1\nline2\nline3',
      });
      expect(result).toBe('write /tmp/test.ts · 3 lines');
    });

    it('handles create_file', () => {
      const result = summarizeToolInput('create_file', {
        file_path: 'new.ts',
        content: 'const x = 1;',
      });
      expect(result).toBe('write new.ts · 1 lines');
    });

    it('handles empty content', () => {
      const result = summarizeToolInput('write_file', {
        path: 'empty.ts',
        content: '',
      });
      expect(result).toBe('write empty.ts');
    });

    it('uses filepath field', () => {
      const result = summarizeToolInput('new_file', {
        filepath: 'thing.ts',
        content: 'content',
      });
      expect(result).toBe('write thing.ts · 1 lines');
    });
  });

  describe('bash / shell / exec', () => {
    it('summarizes bash command', () => {
      const result = summarizeToolInput('bash', {
        command: 'echo "hello world"',
      });
      expect(result).toBe('$ echo "hello world"');
    });

    it('truncates long commands', () => {
      const longCmd = 'echo ' + 'x'.repeat(120);
      const result = summarizeToolInput('shell', { command: longCmd });
      expect(result.length).toBeLessThanOrEqual(113); // "$ " + 110 chars + "…"
    });

    it('uses cmd field', () => {
      const result = summarizeToolInput('run', { cmd: 'ls -la' });
      expect(result).toBe('$ ls -la');
    });

    it('uses script field', () => {
      const result = summarizeToolInput('run_shell', { script: 'npm test' });
      expect(result).toBe('$ npm test');
    });

    it('handles missing command', () => {
      const result = summarizeToolInput('bash', {});
      // Falls back to JSON when no command/cmd/script field
      expect(result).toBe('{}');
    });
  });

  describe('fetch / http', () => {
    it('summarizes GET request', () => {
      const result = summarizeToolInput('fetch', {
        url: 'https://api.example.com/data',
      });
      expect(result).toBe('GET https://api.example.com/data');
    });

    it('summarizes POST request', () => {
      const result = summarizeToolInput('http', {
        url: 'https://api.example.com/post',
        method: 'POST',
      });
      expect(result).toBe('POST https://api.example.com/post');
    });

    it('truncates long URLs', () => {
      const longUrl = 'https://api.example.com/' + 'x'.repeat(110);
      const result = summarizeToolInput('webfetch', { url: longUrl });
      expect(result.length).toBeLessThanOrEqual(114); // "GET " + 100 chars + "…"
    });

    it('handles missing URL', () => {
      const result = summarizeToolInput('curl', {});
      // Falls back to JSON when no URL field
      expect(result).toBe('{}');
    });
  });

  describe('grep / search', () => {
    it('summarizes grep with pattern and scope', () => {
      const result = summarizeToolInput('grep', {
        pattern: 'TODO',
        path: 'src/**/*.ts',
      });
      expect(result).toBe('grep TODO in src/**/*.ts');
    });

    it('summarizes grep with glob scope', () => {
      const result = summarizeToolInput('search', {
        pattern: 'fixme',
        glob: '*.js',
      });
      expect(result).toBe('grep fixme in *.js');
    });

    it('summarizes grep without scope', () => {
      const result = summarizeToolInput('ripgrep', {
        pattern: 'TODO',
      });
      expect(result).toBe('grep TODO');
    });

    it('truncates long patterns', () => {
      const longPattern = 'x'.repeat(70);
      const result = summarizeToolInput('grep', { pattern: longPattern });
      expect(result.length).toBeLessThanOrEqual(110); // "grep " + 60 + "…"
    });
  });

  describe('glob / find', () => {
    it('summarizes glob pattern', () => {
      const result = summarizeToolInput('glob', {
        pattern: '**/*.ts',
      });
      expect(result).toBe('glob **/*.ts');
    });

    it('uses glob field', () => {
      const result = summarizeToolInput('find', {
        glob: 'src/**/*.{ts,tsx}',
      });
      expect(result).toBe('glob src/**/*.{ts,tsx}');
    });
  });

  describe('read with offset/limit', () => {
    it('summarizes read with offset and limit', () => {
      const result = summarizeToolInput('read', {
        path: 'file.ts',
        offset: 10,
        limit: 50,
      });
      expect(result).toBe('read file.ts (10…60)');
    });

    it('summarizes read with only offset', () => {
      const result = summarizeToolInput('read_file', {
        path: 'file.ts',
        offset: 5,
      });
      expect(result).toBe('read file.ts (5…)');
    });

    it('summarizes read with only limit', () => {
      const result = summarizeToolInput('cat', {
        file_path: 'file.ts',
        limit: 100,
      });
      expect(result).toBe('read file.ts (0…100)');
    });

    it('summarizes read without offset/limit', () => {
      const result = summarizeToolInput('read', {
        path: 'file.ts',
      });
      expect(result).toBe('read file.ts');
    });
  });

  describe('fallback', () => {
    it('uses path field', () => {
      const result = summarizeToolInput('unknown', { path: '/foo/bar' });
      expect(result).toBe('path: /foo/bar');
    });

    it('uses file_path field', () => {
      const result = summarizeToolInput('unknown', { file_path: '/foo/bar' });
      expect(result).toBe('file_path: /foo/bar');
    });

    it('uses description field', () => {
      const result = summarizeToolInput('custom', { description: 'My custom tool' });
      expect(result).toBe('description: My custom tool');
    });

    it('falls back to JSON for unknown fields', () => {
      const result = summarizeToolInput('unknown', { weirdField: 'value' });
      expect(result).toBe('{"weirdField":"value"}');
    });

    it('falls back to String when JSON.stringify throws (circular ref)', () => {
      // Circular reference causes JSON.stringify to throw → safeJson catch fires
      const circular: Record<string, unknown> = { self: null };
      circular.self = circular;
      const result = summarizeToolInput('unknown', circular);
      expect(result).toBe('[object Object]'); // String(circular) = '[object Object]'
    });
  });

  describe('edge cases', () => {
    it('handles null input', () => {
      expect(summarizeToolInput('read', null)).toBe('');
    });

    it('handles undefined input', () => {
      expect(summarizeToolInput('read', undefined)).toBe('');
    });

    it('handles primitive input', () => {
      expect(summarizeToolInput('read', 42)).toBe('42');
    });

    it('handles tool name variations case-insensitively', () => {
      const result1 = summarizeToolInput('TODO', { todos: [] });
      const result2 = summarizeToolInput('TodoWrite', { todos: [] });
      const result3 = summarizeToolInput('TODOS', { todos: [] });
      expect(result1).toBe('0 todos');
      expect(result2).toBe('0 todos');
      expect(result3).toBe('0 todos');
    });
  });
});
