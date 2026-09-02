import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../../src/core/context.js';
import { formatTodosList, hasOpenTodos } from '../../src/utils/todos-format.js';

// Strip ANSI escapes so assertions match regardless of color codes.
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('todos-format / formatTodosList', () => {
  it('returns "No todos." for empty list', () => {
    expect(formatTodosList([])).toBe('No todos.');
  });

  it('renders header with done/total count', () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'first', status: 'pending' },
      { id: '2', content: 'second', status: 'completed' },
      { id: '3', content: 'third', status: 'in_progress' },
    ];
    const out = stripAnsi(formatTodosList(todos));
    expect(out.split('\n')[0]).toBe('Todos (1/3 done):');
  });

  it('uses [ ] for pending rows', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'todo me', status: 'pending' }];
    const out = stripAnsi(formatTodosList(todos));
    expect(out).toContain('[ ]');
    expect(out).toContain('todo me');
  });

  it('uses [x] for completed rows', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'done thing', status: 'completed' }];
    const out = stripAnsi(formatTodosList(todos));
    expect(out).toContain('[x]');
    expect(out).toContain('done thing');
  });

  it('uses [~] for in-progress rows', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'work on it', status: 'in_progress' }];
    const out = stripAnsi(formatTodosList(todos));
    expect(out).toContain('[~]');
  });

  it('prefers activeForm over content for in-progress rows', () => {
    const todos: TodoItem[] = [
      {
        id: '1',
        content: 'Build the project',
        status: 'in_progress',
        activeForm: 'Building the project',
      },
    ];
    const out = stripAnsi(formatTodosList(todos));
    expect(out).toContain('Building the project');
    expect(out).not.toContain('Build the project');
  });

  it('falls back to content if activeForm is missing on in-progress', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'Do work', status: 'in_progress' }];
    const out = stripAnsi(formatTodosList(todos));
    expect(out).toContain('Do work');
  });

  it('does not use activeForm for non-in-progress rows', () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'Imperative', status: 'completed', activeForm: 'Continuous' },
      { id: '2', content: 'Imperative2', status: 'pending', activeForm: 'Continuous2' },
    ];
    const out = stripAnsi(formatTodosList(todos));
    expect(out).toContain('Imperative');
    expect(out).toContain('Imperative2');
    expect(out).not.toContain('Continuous');
    expect(out).not.toContain('Continuous2');
  });

  it('numbers rows starting at 1, right-padded to width 2', () => {
    const todos: TodoItem[] = Array.from({ length: 3 }, (_, i) => ({
      id: String(i + 1),
      content: `item ${i + 1}`,
      status: 'pending' as const,
    }));
    const out = stripAnsi(formatTodosList(todos));
    const lines = out.split('\n');
    expect(lines[1]).toMatch(/^\s+1\. \[ \] item 1/);
    expect(lines[2]).toMatch(/^\s+2\. \[ \] item 2/);
    expect(lines[3]).toMatch(/^\s+3\. \[ \] item 3/);
  });

  it('preserves the input order', () => {
    const todos: TodoItem[] = [
      { id: 'b', content: 'second', status: 'pending' },
      { id: 'a', content: 'first', status: 'pending' },
      { id: 'c', content: 'third', status: 'pending' },
    ];
    const out = stripAnsi(formatTodosList(todos));
    const lines = out.split('\n').slice(1);
    expect(lines[0]).toContain('second');
    expect(lines[1]).toContain('first');
    expect(lines[2]).toContain('third');
  });

  it('counts only completed items toward done', () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'a', status: 'completed' },
      { id: '2', content: 'b', status: 'completed' },
      { id: '3', content: 'c', status: 'in_progress' },
      { id: '4', content: 'd', status: 'pending' },
    ];
    const out = stripAnsi(formatTodosList(todos));
    expect(out.split('\n')[0]).toBe('Todos (2/4 done):');
  });

  it('returns a single newline-joined string', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'x', status: 'pending' }];
    const out = formatTodosList(todos);
    expect(typeof out).toBe('string');
    expect(out.includes('\n')).toBe(true);
  });
});

// ── hasOpenTodos ───────────────────────────────────────────────────

describe('hasOpenTodos', () => {
  it('returns false for null / undefined / non-array', () => {
    expect(hasOpenTodos(null)).toBe(false);
    expect(hasOpenTodos(undefined)).toBe(false);
    expect(hasOpenTodos('not array' as never)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(hasOpenTodos([])).toBe(false);
  });

  it('returns false when all todos are completed', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'done', status: 'completed' }];
    expect(hasOpenTodos(todos)).toBe(false);
  });

  it('returns true when there is a pending todo', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'do it', status: 'pending' }];
    expect(hasOpenTodos(todos)).toBe(true);
  });

  it('returns true when there is an in-progress todo', () => {
    const todos: TodoItem[] = [{ id: '1', content: 'doing it', status: 'in_progress' }];
    expect(hasOpenTodos(todos)).toBe(true);
  });

  it('returns true when mixed with completed items', () => {
    const todos: TodoItem[] = [
      { id: '1', content: 'done', status: 'completed' },
      { id: '2', content: 'pending', status: 'pending' },
    ];
    expect(hasOpenTodos(todos)).toBe(true);
  });

  it('accepts readonly arrays', () => {
    const todos: readonly TodoItem[] = [{ id: '1', content: 'task', status: 'pending' }];
    expect(hasOpenTodos(todos)).toBe(true);
  });
});
