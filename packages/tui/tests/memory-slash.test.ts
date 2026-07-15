import { describe, expect, it } from 'vitest';
import type { MemoryEntry, MemoryScope, MemoryStore } from '@wrongstack/core';
import { createMemorySlashCommand, type MemorySlashDeps } from '../src/memory-slash.js';

/**
 * Build a fake MemoryStore backed by a mutable array per scope.
 */
function fakeMemoryStore(entries: Partial<Record<MemoryScope, MemoryEntry[]>>): MemoryStore {
  const store: Partial<Record<MemoryScope, MemoryEntry[]>> = {};
  for (const [scope, list] of Object.entries(entries)) {
    store[scope as MemoryScope] = list ? [...list] : [];
  }
  return {
    list: async (scope?: MemoryScope) => store[scope ?? 'project-memory'] ?? [],
    readAll: async () => '',
    read: async (_scope: MemoryScope) => '',
    remember: async () => {},
    forget: async () => 0,
    consolidate: async () => {},
    clear: async () => {},
    search: async () => [],
    withTraceId: () => store as unknown as MemoryStore,
  };
}

function entry(text: string, overrides?: Partial<MemoryEntry>): MemoryEntry {
  return {
    scope: 'project-memory',
    text,
    ts: new Date('2026-07-14T12:00:00Z').toISOString(),
    type: 'fact',
    priority: 'medium',
    tags: ['test'],
    ...overrides,
  };
}

function run(cmd: ReturnType<typeof createMemorySlashCommand>, args = ''): Promise<string> {
  return cmd.run(args).then((r) => (r as { message: string }).message);
}

describe('/memory slash command', () => {
  it('returns "No memory entries found." when all scopes are empty', async () => {
    const deps: MemorySlashDeps = { memoryStore: fakeMemoryStore({}) };
    const cmd = createMemorySlashCommand(deps);
    expect(await run(cmd)).toBe('No memory entries found.');
  });

  it('lists entries from project-memory in a markdown table', async () => {
    const deps: MemorySlashDeps = {
      memoryStore: fakeMemoryStore({
        'project-memory': [entry('A key design decision', { type: 'decision', priority: 'high', tags: ['design', 'arch'] })],
      }),
    };
    const cmd = createMemorySlashCommand(deps);
    const out = await run(cmd);
    expect(out).toContain('Project memory');
    expect(out).toContain('| Type');
    expect(out).toContain('decision');
    expect(out).toContain('high');
    expect(out).toContain('design, arch');
    expect(out).toContain('A key design decision');
    expect(out).toContain('Total: 1 entry across');
  });

  it('shows entries from all three scopes when no argument is given', async () => {
    const deps: MemorySlashDeps = {
      memoryStore: fakeMemoryStore({
        'project-agents': [entry('Agent coordination fact', { scope: 'project-agents', tags: ['agents'] })],
        'project-memory': [entry('Project note', { scope: 'project-memory', tags: ['project'] })],
        'user-memory': [entry('Personal preference', { scope: 'user-memory', tags: ['user'] })],
      }),
    };
    const cmd = createMemorySlashCommand(deps);
    const out = await run(cmd);
    expect(out).toContain('AGENTS.md');
    expect(out).toContain('Project memory');
    expect(out).toContain('User memory');
    expect(out).toContain('Total: 3 entries across 3 scopes');
  });

  it('filters to a single scope when given as argument', async () => {
    const deps: MemorySlashDeps = {
      memoryStore: fakeMemoryStore({
        'project-agents': [entry('agents-1', { scope: 'project-agents' })],
        'project-memory': [entry('proj-1', { scope: 'project-memory' })],
        'user-memory': [entry('user-1', { scope: 'user-memory' })],
      }),
    };
    const cmd = createMemorySlashCommand(deps);
    const out = await run(cmd, 'user-memory');
    expect(out).toContain('User memory');
    expect(out).not.toContain('Project memory');
    expect(out).not.toContain('AGENTS.md');
    expect(out).toContain('Total: 1 entry across 1 scope');
  });

  it('truncates long text previews with ellipsis', async () => {
    const longText = 'A very long memory entry that should be truncated because it exceeds the 72 character preview limit in the table output';
    const deps: MemorySlashDeps = {
      memoryStore: fakeMemoryStore({
        'project-memory': [entry(longText)],
      }),
    };
    const cmd = createMemorySlashCommand(deps);
    const out = await run(cmd);
    expect(out).toContain('…');
    expect(out).not.toContain(longText);
  });

  it('renders empty scope as "—" placeholders for missing fields', async () => {
    const deps: MemorySlashDeps = {
      memoryStore: fakeMemoryStore({
        'project-memory': [{ scope: 'project-memory', text: 'Minimal entry', ts: '' }],
      }),
    };
    const cmd = createMemorySlashCommand(deps);
    const out = await run(cmd);
    // No type, no priority, no tags, no date → em-dash placeholders
    expect(out).toMatch(/—/);
  });

  it('reports an error when memoryStore.list rejects', async () => {
    const brokenStore: MemoryStore = {
      list: async () => { throw new Error('disk failure'); },
      readAll: async () => '',
      read: async () => '',
      remember: async () => {},
      forget: async () => 0,
      consolidate: async () => {},
      clear: async () => {},
      search: async () => [],
      withTraceId: () => brokenStore,
    };
    const deps: MemorySlashDeps = { memoryStore: brokenStore };
    const cmd = createMemorySlashCommand(deps);
    const out = await run(cmd);
    expect(out).toContain('Failed to read memory store');
    expect(out).toContain('disk failure');
  });

  it('pluralises "entries" correctly for a single entry', async () => {
    const deps: MemorySlashDeps = {
      memoryStore: fakeMemoryStore({
        'project-memory': [entry('only one')],
      }),
    };
    const cmd = createMemorySlashCommand(deps);
    const out = await run(cmd);
    expect(out).toContain('1 entry');
  });

  it('pluralises "entries" correctly for multiple entries', async () => {
    const deps: MemorySlashDeps = {
      memoryStore: fakeMemoryStore({
        'project-memory': [entry('a'), entry('b')],
      }),
    };
    const cmd = createMemorySlashCommand(deps);
    const out = await run(cmd);
    expect(out).toContain('2 entries');
  });
});
