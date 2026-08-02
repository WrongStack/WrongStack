import type { ToolRegistry } from '@wrongstack/core/registry';
import { describe, expect, it, vi } from 'vitest';
import { buildToolsCommand } from '../src/slash-commands/tools.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function makeRegistry(): ToolRegistry {
  return {
    listWithOwner: () => [
      { tool: { name: 'read', description: 'Read a file', mutating: false, permission: 'auto' }, owner: 'system' },
      { tool: { name: 'write', description: 'Write a file', mutating: true, permission: 'prompt' }, owner: 'system' },
      { tool: { name: 'bash', description: 'Run command', mutating: true, permission: 'auto' }, owner: 'user' },
    ],
    listDisabled: () => [
      { tool: { name: 'delete', description: 'Delete file', mutating: true, permission: 'never' }, owner: 'system' },
    ],
    isDisabled: (name: string) => name === 'delete',
  } as never as ToolRegistry;
}

function makeOpts(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const writeFn = vi.fn();
  return {
    toolRegistry: makeRegistry(),
    renderer: { write: writeFn } as never,
    onPanelOpen: { current: null },
    ...overrides,
  } as never as SlashCommandContext;
}

describe('buildToolsCommand', () => {
  it('renders tool list with header and rows', async () => {
    const writeFn = vi.fn();
    const cmd = buildToolsCommand(makeOpts({ renderer: { write: writeFn } as never }));
    const res = await cmd.run('');
    expect(res?.message).toContain('Tools');
    expect(res?.message).toContain('read');
    expect(res?.message).toContain('write');
    expect(res?.message).toContain('bash');
    expect(res?.message).toContain('delete');
    expect(res?.message).toContain('disabled');
    expect(res?.message).toContain('active');
    expect(writeFn).toHaveBeenCalled();
  });

  it('filters tools by name pattern', async () => {
    const cmd = buildToolsCommand(makeOpts());
    const res = await cmd.run('read');
    expect(res?.message).toContain('read');
    expect(res?.message).not.toContain('bash');
  });

  it('filters tools by owner pattern', async () => {
    const cmd = buildToolsCommand(makeOpts());
    const res = await cmd.run('user');
    expect(res?.message).toContain('bash');
    expect(res?.message).not.toContain('read');
  });

  it('shows no-match message when filter finds nothing', async () => {
    const writeFn = vi.fn();
    const cmd = buildToolsCommand(makeOpts({ renderer: { write: writeFn } as never }));
    const res = await cmd.run('zzznonexistent');
    expect(res?.message).toMatch(/no tool name or owner matched/);
    expect(writeFn).toHaveBeenCalled();
  });

  it('opens TUI picker when onPanelOpen is wired', async () => {
    const onPanelOpen = vi.fn().mockReturnValue(true);
    const cmd = buildToolsCommand(
      makeOpts({ onPanelOpen: { current: onPanelOpen } }),
    );
    const res = await cmd.run('');
    expect(onPanelOpen).toHaveBeenCalledWith('toolsPickerOpen');
    expect(res?.message).toBe('');
  });

  it('shows disabled count in output', async () => {
    const cmd = buildToolsCommand(makeOpts());
    const res = await cmd.run('');
    expect(res?.message).toMatch(/1 tool\(s\) disabled/);
  });

  it('shows filter note with ratio', async () => {
    const cmd = buildToolsCommand(makeOpts());
    const res = await cmd.run('read');
    expect(res?.message).toMatch(/matching "read"/);
    expect(res?.message).toMatch(/1 of 4/);
  });

  it('handles empty registry', async () => {
    const emptyRegistry = {
      listWithOwner: () => [],
      listDisabled: () => [],
      isDisabled: () => false,
    } as never as ToolRegistry;
    const cmd = buildToolsCommand(makeOpts({ toolRegistry: emptyRegistry }));
    const res = await cmd.run('');
    expect(res?.message).toContain('Tools');
    expect(res?.message).toMatch(/0 shown, 0 disabled/);
  });
});
